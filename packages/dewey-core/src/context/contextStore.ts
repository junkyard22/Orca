import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  applyContextManifestAction,
  createEmptyContextManifest,
  normalizeContextManifest,
} from '../cargo.js';
import type { ContextManifest, ContextManifestAction, PreferenceBuckets, UserContext } from '../types.js';

function emptyPreferenceBuckets(): PreferenceBuckets {
  return {
    scheduling: [],
    communication: [],
    food: [],
    work: [],
    general: [],
  };
}

const DEFAULT_CONTEXT: UserContext = {
  hot: {
    name: "User",
    timezone: "America/Chicago",
    currentSession: {
      startedAt: "",
      recentTasks: [],
      manifest: createEmptyContextManifest(),
    },
  },
  warm: {
    learnedPreferences: emptyPreferenceBuckets(),
    patterns:    { commonTaskTypes: [], peakHours: [] },
    household:   { notes: [] },
    connectedApps: { gmail: false, outlook: false, calendar: false },
  },
};

function loadDefaultTemplate(): UserContext {
  return structuredClone(DEFAULT_CONTEXT);
}

type TaskCategory = keyof PreferenceBuckets;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizePreferenceBuckets(value: unknown): PreferenceBuckets {
  const buckets = emptyPreferenceBuckets();
  if (!value || typeof value !== 'object') return buckets;

  const record = value as Record<string, unknown>;
  for (const category of Object.keys(buckets) as TaskCategory[]) {
    buckets[category] = normalizeStringArray(record[category]);
  }

  return buckets;
}

function normalizeConnectedApps(value: unknown): UserContext['warm']['connectedApps'] {
  const defaults = structuredClone(DEFAULT_CONTEXT.warm.connectedApps);
  if (!value || typeof value !== 'object') return defaults;

  for (const [app, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') {
      defaults[app] = enabled;
    }
  }

  return defaults;
}

function normalizeContext(raw: unknown): UserContext {
  const defaults = loadDefaultTemplate();
  if (!raw || typeof raw !== 'object') return defaults;

  const root = raw as Record<string, unknown>;
  const hot = (root.hot ?? {}) as Record<string, unknown>;
  const warm = (root.warm ?? {}) as Record<string, unknown>;
  const currentSession = (hot.currentSession ?? {}) as Record<string, unknown>;
  const patterns = (warm.patterns ?? {}) as Record<string, unknown>;
  const household = (warm.household ?? {}) as Record<string, unknown>;

  return {
    hot: {
      name: typeof hot.name === 'string' ? hot.name : defaults.hot.name,
      timezone: typeof hot.timezone === 'string' ? hot.timezone : defaults.hot.timezone,
      currentSession: {
        startedAt:
          typeof currentSession.startedAt === 'string'
            ? currentSession.startedAt
            : defaults.hot.currentSession.startedAt,
        recentTasks: normalizeStringArray(currentSession.recentTasks),
        manifest: normalizeContextManifest(currentSession.manifest),
      },
    },
    warm: {
      learnedPreferences: normalizePreferenceBuckets(
        warm.learnedPreferences ?? warm.preferences,
      ),
      patterns: {
        commonTaskTypes: normalizeStringArray(patterns.commonTaskTypes),
        peakHours: normalizeStringArray(patterns.peakHours),
      },
      household: {
        notes: normalizeStringArray(household.notes),
      },
      connectedApps: normalizeConnectedApps(warm.connectedApps),
    },
  };
}

function detectCategory(taskType: string): TaskCategory {
  const t = taskType.toLowerCase();
  if (/scheduling|calendar|planning/.test(t)) return 'scheduling';
  if (/food|meal|recipe|dinner/.test(t)) return 'food';
  if (/email|message|communication/.test(t)) return 'communication';
  if (/code|coding|implement/.test(t)) return 'work';
  return 'general';
}

export class ContextStore {
  private contextPath: string;
  private context: UserContext;
  private _loadPromise: Promise<UserContext> | null = null;

  constructor(contextPath: string) {
    this.contextPath = contextPath;
    this.context = loadDefaultTemplate();
  }

  async load(): Promise<UserContext> {
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = (async () => {
      try {
        const raw = await fs.readFile(this.contextPath, 'utf-8');
        this.context = normalizeContext(JSON.parse(raw));
        console.error('[Dewey] Context loaded from', this.contextPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error('[Dewey] Context file not found, creating default at', this.contextPath);
          this.context = loadDefaultTemplate();
          await this.save();
        } else {
          this._loadPromise = null; // allow retry on transient errors
          throw err;
        }
      }
      return this.context;
    })();

    return this._loadPromise;
  }

  async save(): Promise<void> {
    const dir = dirname(this.contextPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.contextPath, JSON.stringify(this.context, null, 2), 'utf-8');
    console.error('[Dewey] Context saved to', this.contextPath);
  }

  getRelevantContext(taskType: string): {
    preferences: string[];
    notes: string[];
    availableApps: string[];
  } {
    const category = detectCategory(taskType);
    const preferences = this.context.warm.learnedPreferences[category] ?? [];
    const notes = this.context.warm.household.notes;
    const availableApps = Object.entries(this.context.warm.connectedApps)
      .filter(([, enabled]) => enabled)
      .map(([app]) => app);

    return { preferences, notes, availableApps };
  }

  async addSignal(signal: string, category: TaskCategory): Promise<void> {
    const list = this.context.warm.learnedPreferences[category];
    if (!list.includes(signal)) {
      list.push(signal);
      console.error(`[Dewey] New signal added to ${category}: ${signal}`);
    }
    await this.save();
  }

  async startSession(): Promise<void> {
    this.context.hot.currentSession.startedAt = new Date().toISOString();
    this.context.hot.currentSession.recentTasks = [];
    console.error('[Dewey] Session started at', this.context.hot.currentSession.startedAt);
    await this.save();
  }

  async recordTask(taskSummary: string): Promise<void> {
    this.context.hot.currentSession.recentTasks.push(taskSummary);
    await this.save();
  }

  async getManifest(): Promise<ContextManifest> {
    await this.load();
    return structuredClone(this.context.hot.currentSession.manifest);
  }

  async updateManifest(action: ContextManifestAction): Promise<ContextManifest> {
    await this.load();
    this.context.hot.currentSession.manifest = applyContextManifestAction(
      this.context.hot.currentSession.manifest,
      action,
    );
    await this.save();
    return structuredClone(this.context.hot.currentSession.manifest);
  }
}
