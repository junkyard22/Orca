import type { CargoReference } from '@clawde/benson-core';
import type {
  ContextManifest,
  ContextManifestAction,
  ContextManifestBrief,
} from '@clawde/dewey-core';

export interface CargoConnectorOption {
  id: string;
  label: string;
  available: boolean;
}

export function isClientCargoAction(action: ContextManifestAction): boolean {
  return !['set_workspace', 'sync_connectors', 'clear'].includes(action.type);
}

interface CargoSettingsView {
  workspaceRoot?: string;
  mcpServers?: Array<{ id: string; name: string; enabled?: boolean }>;
}

interface CargoTaskLike {
  context?: Record<string, unknown>;
  permissions?: unknown;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function connectorToolNames(
  allTools: string[],
  mcpTools: string[],
): string[] {
  return [...new Set([
    ...mcpTools,
    ...allTools.filter((tool) => /^(?:github|web)_/.test(tool)),
  ])];
}

export function configuredCargoConnectors(
  settings: CargoSettingsView,
  allTools: string[],
  mcpTools: string[],
): CargoConnectorOption[] {
  const byId = new Map<string, CargoConnectorOption>();
  const mcpToolSet = new Set(mcpTools);

  for (const server of settings.mcpServers ?? []) {
    if (server.enabled === false) continue;
    const available = [...mcpToolSet].some((tool) => tool.startsWith(`${server.id}_`));
    byId.set(server.id, { id: server.id, label: server.name || titleCase(server.id), available });
  }

  for (const prefix of ['github', 'web']) {
    const available = allTools.some((tool) => tool.startsWith(`${prefix}_`));
    if (available && !byId.has(prefix)) {
      byId.set(prefix, { id: prefix, label: titleCase(prefix), available: true });
    }
  }

  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function cargoReferenceAction(
  reference: CargoReference,
  connectors: CargoConnectorOption[],
): ContextManifestAction {
  switch (reference.kind) {
    case 'repository':
      return { type: 'attach_repository', locator: reference.value };
    case 'file':
      return { type: 'attach_file', path: reference.value, fileKind: 'file' };
    case 'task':
      return { type: 'attach_task', reference: reference.value };
    case 'connector': {
      const configured = connectors.find((connector) => connector.id.toLowerCase() === reference.value.toLowerCase());
      return {
        type: 'attach_connector',
        connectorId: configured?.id ?? reference.value,
        label: configured?.label ?? reference.value,
        available: configured?.available ?? false,
      };
    }
  }
}

export function enrichTaskWithCargo<T extends CargoTaskLike>(
  task: T,
  manifest: ContextManifest,
  brief: ContextManifestBrief,
  workspaceRoot?: string,
): T {
  let permissions = Array.isArray(task.permissions)
    ? [...new Set(task.permissions.filter((item): item is string => typeof item === 'string'))]
    : task.permissions;
  const hasNetworkResource = Boolean(
    manifest.workspace?.repository ||
    manifest.connectors.length > 0 ||
    manifest.urls.length > 0,
  );

  if (Array.isArray(permissions)) {
    if (manifest.files.length > 0 && !permissions.includes('read')) permissions.push('read');
    if (hasNetworkResource && !permissions.includes('network')) permissions.push('network');
  } else if (permissions && typeof permissions === 'object' && hasNetworkResource) {
    Object.assign(permissions = { ...(permissions as Record<string, unknown>) }, { networkAccess: true });
  }

  return {
    ...task,
    ...(permissions !== undefined && { permissions }),
    context: {
      ...(task.context ?? {}),
      ...(workspaceRoot && { workspaceRoot }),
      contextManifest: manifest,
      deweyBrief: brief,
    },
  };
}
