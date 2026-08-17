import { describe, expect, it } from 'vitest';
import { applyContextManifestAction, createEmptyContextManifest, summarizeContextManifest } from '@clawde/dewey-core';
import {
  cargoReferenceAction,
  configuredCargoConnectors,
  connectorToolNames,
  enrichTaskWithCargo,
  isClientCargoAction,
} from './cargoContext';

describe('desktop Cargo actions', () => {
  it('keeps workspace and connector synchronization owned by Settings/the host', () => {
    expect(isClientCargoAction({ type: 'attach_file', path: 'README.md' })).toBe(true);
    expect(isClientCargoAction({ type: 'set_workspace', rootPath: 'C:\\Other' })).toBe(false);
    expect(isClientCargoAction({ type: 'sync_connectors', connectors: [] })).toBe(false);
    expect(isClientCargoAction({ type: 'clear' })).toBe(false);
  });

  it('derives connector choices from settings and loaded tools', () => {
    const connectors = configuredCargoConnectors(
      { mcpServers: [{ id: 'linear-mcp', name: 'Linear', enabled: true }] },
      ['github_list_prs', 'linear-mcp_get_issue'],
      ['linear-mcp_get_issue'],
    );
    expect(connectors).toEqual([
      { id: 'github', label: 'Github', available: true },
      { id: 'linear-mcp', label: 'Linear', available: true },
    ]);
  });

  it('maps @ connector references to configured connector metadata', () => {
    expect(cargoReferenceAction(
      { kind: 'connector', value: 'github' },
      [{ id: 'github', label: 'GitHub', available: true }],
    )).toEqual({
      type: 'attach_connector',
      connectorId: 'github',
      label: 'GitHub',
      available: true,
    });
  });

  it('injects Dewey compact context and expands only the required permissions', () => {
    let manifest = applyContextManifestAction(createEmptyContextManifest(), {
      type: 'attach_repository',
      locator: 'junkyard22/Orca',
    });
    manifest = applyContextManifestAction(manifest, { type: 'attach_file', path: 'ARCHITECTURE.md' });
    const brief = summarizeContextManifest(manifest);
    const task = enrichTaskWithCargo(
      { context: { existing: true }, permissions: ['read'] },
      manifest,
      brief,
      'C:\\Orca',
    );

    expect(task.permissions).toEqual(['read', 'network']);
    expect(task.context?.workspaceRoot).toBe('C:\\Orca');
    expect(task.context?.deweyBrief).toEqual(brief);
    expect(task.context?.contextManifest).toEqual(manifest);
  });

  it('marks MCP and network extensions as connector-gated tools', () => {
    expect(connectorToolNames(
      ['read_file', 'github_list_prs', 'web_fetch', 'linear_get_issue'],
      ['linear_get_issue'],
    )).toEqual(['linear_get_issue', 'github_list_prs', 'web_fetch']);
  });
});
