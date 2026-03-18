import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { UserContext } from '../types.js';

const require = createRequire(import.meta.url);

function loadDefaultTemplate(): UserContext {
  return require('./userContext.json') as UserContext;
}

type TaskCategory = keyof UserContext['warm']['preferences'];

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
        this.context = JSON.parse(raw) as UserContext;
        console.log('[Dewey] Context loaded from', this.contextPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log('[Dewey] Context file not found, creating default at', this.contextPath);
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
    console.log('[Dewey] Context saved to', this.contextPath);
  }

  getRelevantContext(taskType: string): {
    preferences: string[];
    notes: string[];
    availableApps: string[];
  } {
    const category = detectCategory(taskType);
    const preferences = this.context.warm.preferences[category] ?? [];
    const notes = this.context.warm.household.notes;
    const availableApps = Object.entries(this.context.warm.connectedApps)
      .filter(([, enabled]) => enabled)
      .map(([app]) => app);

    return { preferences, notes, availableApps };
  }

  async addSignal(signal: string, category: TaskCategory): Promise<void> {
    const list = this.context.warm.preferences[category];
    if (!list.includes(signal)) {
      list.push(signal);
      console.log(`[Dewey] New signal added to ${category}: ${signal}`);
    }
    await this.save();
  }

  async startSession(): Promise<void> {
    this.context.hot.currentSession.startedAt = new Date().toISOString();
    this.context.hot.currentSession.recentTasks = [];
    console.log('[Dewey] Session started at', this.context.hot.currentSession.startedAt);
    await this.save();
  }

  async recordTask(taskSummary: string): Promise<void> {
    this.context.hot.currentSession.recentTasks.push(taskSummary);
    await this.save();
  }
}
