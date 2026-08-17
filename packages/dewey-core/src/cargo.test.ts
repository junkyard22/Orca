import { describe, expect, it } from 'vitest';
import {
  applyContextManifestAction,
  createEmptyContextManifest,
  normalizeContextManifest,
  parseContextManifestAction,
  summarizeContextManifest,
} from './cargo.js';

describe('ContextManifest', () => {
  it('adds and deduplicates typed resources', () => {
    let manifest = createEmptyContextManifest('2026-01-01T00:00:00Z');
    manifest = applyContextManifestAction(manifest, {
      type: 'attach_repository',
      locator: 'junkyard22/Orca',
      at: '2026-01-01T00:00:01Z',
    });
    manifest = applyContextManifestAction(manifest, {
      type: 'attach_file',
      path: 'ARCHITECTURE.md',
      at: '2026-01-01T00:00:02Z',
    });
    manifest = applyContextManifestAction(manifest, {
      type: 'attach_file',
      path: 'ARCHITECTURE.md',
      at: '2026-01-01T00:00:03Z',
    });

    expect(manifest.workspace?.repository?.locator).toBe('junkyard22/Orca');
    expect(manifest.files).toHaveLength(1);
    expect(manifest.updatedAt).toBe('2026-01-01T00:00:03.000Z');
  });

  it('supports every graphical Add action in the first slice', () => {
    const actions = [
      { type: 'attach_repository', locator: 'junkyard22/Orca' },
      { type: 'attach_file', path: 'ARCHITECTURE.md', fileKind: 'file' },
      { type: 'attach_file', path: 'packages', fileKind: 'folder' },
      { type: 'attach_task', reference: '#142' },
      { type: 'attach_connector', connectorId: 'github', available: true },
      { type: 'attach_url', url: 'https://example.com/spec' },
      { type: 'attach_previous_run', runId: 'run-123', label: 'Prior audit' },
    ] as const;
    const manifest = actions.reduce(
      (current, action) => applyContextManifestAction(current, action),
      createEmptyContextManifest(),
    );

    expect(manifest.workspace?.repository?.locator).toBe('junkyard22/Orca');
    expect(manifest.files.map((item) => item.kind)).toEqual(['file', 'folder']);
    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.connectors).toHaveLength(1);
    expect(manifest.urls).toHaveLength(1);
    expect(manifest.previousRuns).toHaveLength(1);
  });

  it('removes resources by stable ID without removing the configured workspace', () => {
    let manifest = applyContextManifestAction(createEmptyContextManifest(), {
      type: 'set_workspace',
      rootPath: 'C:\\Orca',
    });
    manifest = applyContextManifestAction(manifest, { type: 'attach_task', reference: '#142' });
    const resourceId = manifest.tasks[0]!.id;
    manifest = applyContextManifestAction(manifest, { type: 'remove', resourceId });

    expect(manifest.tasks).toEqual([]);
    expect(manifest.workspace?.rootPath).toBe('C:\\Orca');
  });

  it('normalizes untrusted persisted input and drops raw resource content', () => {
    const manifest = normalizeContextManifest({
      files: [{ path: 'notes.md', label: 'Notes', content: 'secret raw contents' }],
      urls: [{ url: 'file:///secret.txt' }],
    });
    expect(manifest.files[0]).toEqual(expect.objectContaining({ path: 'notes.md', label: 'Notes' }));
    expect(manifest.files[0]).not.toHaveProperty('content');
    expect(manifest.urls).toEqual([]);
  });

  it('produces a compact pre-flight briefing', () => {
    let manifest = applyContextManifestAction(createEmptyContextManifest(), {
      type: 'attach_connector',
      connectorId: 'github',
      label: 'GitHub',
      available: true,
    });
    manifest = applyContextManifestAction(manifest, { type: 'attach_task', reference: '#142' });
    const brief = summarizeContextManifest(manifest);

    expect(brief.summary).toBe('2 Cargo resources attached.');
    expect(brief.lines).toContain('Connectors: GitHub');
    expect(brief.lines).toContain('Tasks: #142');
  });

  it('counts the settings-owned workspace shown in the tray', () => {
    const manifest = applyContextManifestAction(createEmptyContextManifest(), {
      type: 'set_workspace',
      rootPath: 'C:\\Orca',
    });
    const brief = summarizeContextManifest(manifest);
    expect(brief.summary).toBe('1 Cargo resource attached.');
    expect(brief.counts.workspaces).toBe(1);
  });

  it('rejects malformed actions at the IPC boundary', () => {
    expect(parseContextManifestAction({ type: 'attach_file', path: '' })).toBeNull();
    expect(parseContextManifestAction({ type: 'attach_url', url: 'file:///secret.txt' })).toBeNull();
    expect(parseContextManifestAction({ type: 'unknown', path: 'x' })).toBeNull();
  });
});
