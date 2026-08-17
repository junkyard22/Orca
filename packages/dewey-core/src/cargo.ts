import { basename } from 'node:path';
import type {
  ContextConnectorResource,
  ContextFileKind,
  ContextManifest,
  ContextManifestAction,
  ContextManifestBrief,
} from './types.js';

const MAX_RESOURCES_PER_KIND = 100;

function clean(value: unknown, max = 2_048): string {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim().slice(0, max)
    : '';
}

function cleanHttpUrl(value: unknown): string {
  const url = clean(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

function uniqueId(kind: string, key: string): string {
  let hash = 2_166_136_261;
  for (const char of `${kind}:${key.toLowerCase()}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `cargo_${kind}_${(hash >>> 0).toString(36)}`;
}

function normalizedTimestamp(value?: string): string {
  const candidate = clean(value, 64);
  return candidate && !Number.isNaN(Date.parse(candidate))
    ? new Date(candidate).toISOString()
    : new Date().toISOString();
}

function defaultLabel(value: string): string {
  const pathLabel = basename(value.replace(/[\\/]+$/, ''));
  return pathLabel || value;
}

function normalizeResourceList<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].slice(-MAX_RESOURCES_PER_KIND);
}

export function createEmptyContextManifest(at?: string): ContextManifest {
  return {
    version: 1,
    files: [],
    tasks: [],
    connectors: [],
    urls: [],
    previousRuns: [],
    updatedAt: normalizedTimestamp(at),
  };
}

export function normalizeContextManifest(raw: unknown): ContextManifest {
  const empty = createEmptyContextManifest();
  if (!raw || typeof raw !== 'object') return empty;

  const value = raw as Record<string, unknown>;
  const workspaceValue = value.workspace && typeof value.workspace === 'object'
    ? value.workspace as Record<string, unknown>
    : undefined;
  const repositoryValue = workspaceValue?.repository && typeof workspaceValue.repository === 'object'
    ? workspaceValue.repository as Record<string, unknown>
    : undefined;
  const rootPath = clean(workspaceValue?.rootPath);
  const repositoryLocator = clean(repositoryValue?.locator);

  const normalizeFiles = (): ContextManifest['files'] => {
    if (!Array.isArray(value.files)) return [];
    return normalizeResourceList(value.files.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const path = clean(record.path);
      const kind: ContextFileKind = record.kind === 'folder' ? 'folder' : 'file';
      if (!path) return [];
      return [{
        id: uniqueId(kind, path),
        kind,
        path,
        label: clean(record.label) || defaultLabel(path),
      }];
    }));
  };

  const normalizeTasks = (): ContextManifest['tasks'] => {
    if (!Array.isArray(value.tasks)) return [];
    return normalizeResourceList(value.tasks.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const reference = clean(record.reference);
      if (!reference) return [];
      return [{
        id: uniqueId('task', reference),
        kind: 'task' as const,
        reference,
        label: clean(record.label) || reference,
      }];
    }));
  };

  const normalizeConnectors = (): ContextManifest['connectors'] => {
    if (!Array.isArray(value.connectors)) return [];
    return normalizeResourceList(value.connectors.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const connectorId = clean(record.connectorId);
      if (!connectorId) return [];
      return [{
        id: uniqueId('connector', connectorId),
        kind: 'connector' as const,
        connectorId,
        label: clean(record.label) || connectorId,
        available: record.available === true,
      }];
    }));
  };

  const normalizeUrls = (): ContextManifest['urls'] => {
    if (!Array.isArray(value.urls)) return [];
    return normalizeResourceList(value.urls.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const url = cleanHttpUrl(record.url);
      if (!url) return [];
      return [{
        id: uniqueId('url', url),
        kind: 'url' as const,
        url,
        label: clean(record.label) || url,
      }];
    }));
  };

  const normalizePreviousRuns = (): ContextManifest['previousRuns'] => {
    if (!Array.isArray(value.previousRuns)) return [];
    return normalizeResourceList(value.previousRuns.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const runId = clean(record.runId);
      if (!runId) return [];
      return [{
        id: uniqueId('run', runId),
        kind: 'previous_run' as const,
        runId,
        label: clean(record.label) || runId,
      }];
    }));
  };

  return {
    version: 1,
    ...((rootPath || repositoryLocator) && {
      workspace: {
        rootPath,
        label: clean(workspaceValue?.label) || (rootPath ? defaultLabel(rootPath) : 'Workspace'),
        ...(repositoryLocator && {
          repository: {
            id: uniqueId('repository', repositoryLocator),
            kind: 'repository' as const,
            locator: repositoryLocator,
            label: clean(repositoryValue?.label) || defaultLabel(repositoryLocator),
            ...(clean(repositoryValue?.branch) && { branch: clean(repositoryValue?.branch) }),
          },
        }),
      },
    }),
    files: normalizeFiles(),
    tasks: normalizeTasks(),
    connectors: normalizeConnectors(),
    urls: normalizeUrls(),
    previousRuns: normalizePreviousRuns(),
    updatedAt: normalizedTimestamp(clean(value.updatedAt, 64) || undefined),
  };
}

function actionTime(action: ContextManifestAction): string {
  return normalizedTimestamp(action.at);
}

function connectorFromAction(
  action: Extract<ContextManifestAction, { type: 'attach_connector' }>,
): ContextConnectorResource {
  const connectorId = clean(action.connectorId);
  return {
    id: uniqueId('connector', connectorId),
    kind: 'connector',
    connectorId,
    label: clean(action.label) || connectorId,
    available: action.available === true,
  };
}

export function applyContextManifestAction(
  current: ContextManifest,
  action: ContextManifestAction,
): ContextManifest {
  const manifest = normalizeContextManifest(current);
  const updatedAt = actionTime(action);

  switch (action.type) {
    case 'set_workspace': {
      const rootPath = clean(action.rootPath);
      if (!rootPath) return manifest;
      return {
        ...manifest,
        workspace: {
          rootPath,
          label: clean(action.label) || defaultLabel(rootPath),
          ...(manifest.workspace?.repository && { repository: manifest.workspace.repository }),
        },
        updatedAt,
      };
    }
    case 'attach_repository': {
      const locator = clean(action.locator);
      if (!locator) return manifest;
      const workspace = manifest.workspace ?? { rootPath: '', label: 'Workspace' };
      return {
        ...manifest,
        workspace: {
          ...workspace,
          repository: {
            id: uniqueId('repository', locator),
            kind: 'repository',
            locator,
            label: clean(action.label) || defaultLabel(locator),
            ...(clean(action.branch) && { branch: clean(action.branch) }),
          },
        },
        updatedAt,
      };
    }
    case 'attach_file': {
      const path = clean(action.path);
      if (!path) return manifest;
      const kind: ContextFileKind = action.fileKind === 'folder' ? 'folder' : 'file';
      const resource = {
        id: uniqueId(kind, path),
        kind,
        path,
        label: clean(action.label) || defaultLabel(path),
      };
      return { ...manifest, files: normalizeResourceList([...manifest.files, resource]), updatedAt };
    }
    case 'attach_task': {
      const reference = clean(action.reference);
      if (!reference) return manifest;
      const resource = {
        id: uniqueId('task', reference),
        kind: 'task' as const,
        reference,
        label: clean(action.label) || reference,
      };
      return { ...manifest, tasks: normalizeResourceList([...manifest.tasks, resource]), updatedAt };
    }
    case 'attach_connector': {
      const connectorId = clean(action.connectorId);
      if (!connectorId) return manifest;
      const resource = connectorFromAction(action);
      return { ...manifest, connectors: normalizeResourceList([...manifest.connectors, resource]), updatedAt };
    }
    case 'attach_url': {
      const url = cleanHttpUrl(action.url);
      if (!url) return manifest;
      const resource = {
        id: uniqueId('url', url),
        kind: 'url' as const,
        url,
        label: clean(action.label) || url,
      };
      return { ...manifest, urls: normalizeResourceList([...manifest.urls, resource]), updatedAt };
    }
    case 'attach_previous_run': {
      const runId = clean(action.runId);
      if (!runId) return manifest;
      const resource = {
        id: uniqueId('run', runId),
        kind: 'previous_run' as const,
        runId,
        label: clean(action.label) || runId,
      };
      return {
        ...manifest,
        previousRuns: normalizeResourceList([...manifest.previousRuns, resource]),
        updatedAt,
      };
    }
    case 'sync_connectors': {
      const configured = new Map(action.connectors.map((connector) => [connector.id, connector]));
      return {
        ...manifest,
        connectors: manifest.connectors.map((connector) => {
          const currentConnector = configured.get(connector.connectorId);
          return currentConnector
            ? { ...connector, label: currentConnector.label, available: currentConnector.available }
            : { ...connector, available: false };
        }),
        updatedAt,
      };
    }
    case 'remove': {
      const resourceId = clean(action.resourceId);
      return {
        ...manifest,
        workspace: manifest.workspace?.repository?.id === resourceId
          ? { ...manifest.workspace, repository: undefined }
          : manifest.workspace,
        files: manifest.files.filter((item) => item.id !== resourceId),
        tasks: manifest.tasks.filter((item) => item.id !== resourceId),
        connectors: manifest.connectors.filter((item) => item.id !== resourceId),
        urls: manifest.urls.filter((item) => item.id !== resourceId),
        previousRuns: manifest.previousRuns.filter((item) => item.id !== resourceId),
        updatedAt,
      };
    }
    case 'clear':
      return {
        ...createEmptyContextManifest(updatedAt),
        ...(action.preserveWorkspace && manifest.workspace && { workspace: manifest.workspace }),
      };
  }
}

export function summarizeContextManifest(manifestValue: ContextManifest): ContextManifestBrief {
  const manifest = normalizeContextManifest(manifestValue);
  const counts = {
    workspaces: manifest.workspace?.rootPath ? 1 : 0,
    repositories: manifest.workspace?.repository ? 1 : 0,
    files: manifest.files.length,
    tasks: manifest.tasks.length,
    connectors: manifest.connectors.length,
    urls: manifest.urls.length,
    previousRuns: manifest.previousRuns.length,
  };
  const lines: string[] = [];

  if (manifest.workspace?.rootPath) {
    lines.push(`Workspace: ${manifest.workspace.label} (${manifest.workspace.rootPath})`);
  }
  if (manifest.workspace?.repository) {
    const repository = manifest.workspace.repository;
    lines.push(`Repository: ${repository.locator}${repository.branch ? ` @ ${repository.branch}` : ''}`);
  }
  if (manifest.files.length > 0) {
    lines.push(`Files and folders: ${manifest.files.map((file) => `${file.label} [${file.path}]`).join(', ')}`);
  }
  if (manifest.tasks.length > 0) {
    lines.push(`Tasks: ${manifest.tasks.map((task) => task.reference).join(', ')}`);
  }
  if (manifest.connectors.length > 0) {
    lines.push(`Connectors: ${manifest.connectors.map((connector) =>
      `${connector.label}${connector.available ? '' : ' (not configured)'}`).join(', ')}`);
  }
  if (manifest.urls.length > 0) {
    lines.push(`URLs: ${manifest.urls.map((item) => item.url).join(', ')}`);
  }
  if (manifest.previousRuns.length > 0) {
    lines.push(`Previous runs: ${manifest.previousRuns.map((run) => run.label).join(', ')}`);
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    summary: total === 0 ? 'No Cargo resources attached.' : `${total} Cargo resource${total === 1 ? '' : 's'} attached.`,
    lines,
    counts,
  };
}

export function parseContextManifestAction(value: unknown): ContextManifestAction | null {
  if (!value || typeof value !== 'object') return null;
  const action = value as Record<string, unknown>;
  const type = clean(action.type, 64);
  const at = clean(action.at, 64) || undefined;
  const label = clean(action.label) || undefined;

  switch (type) {
    case 'set_workspace':
      return clean(action.rootPath) ? { type, rootPath: clean(action.rootPath), label, at } : null;
    case 'attach_repository':
      return clean(action.locator)
        ? { type, locator: clean(action.locator), label, branch: clean(action.branch) || undefined, at }
        : null;
    case 'attach_file':
      return clean(action.path)
        ? { type, path: clean(action.path), label, fileKind: action.fileKind === 'folder' ? 'folder' : 'file', at }
        : null;
    case 'attach_task':
      return clean(action.reference) ? { type, reference: clean(action.reference), label, at } : null;
    case 'attach_connector':
      return clean(action.connectorId)
        ? { type, connectorId: clean(action.connectorId), label, available: action.available === true, at }
        : null;
    case 'attach_url':
      return cleanHttpUrl(action.url) ? { type, url: cleanHttpUrl(action.url), label, at } : null;
    case 'attach_previous_run':
      return clean(action.runId) ? { type, runId: clean(action.runId), label, at } : null;
    case 'remove':
      return clean(action.resourceId) ? { type, resourceId: clean(action.resourceId), at } : null;
    case 'clear':
      return { type, preserveWorkspace: action.preserveWorkspace === true, at };
    default:
      return null;
  }
}
