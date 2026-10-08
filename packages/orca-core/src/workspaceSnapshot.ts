/**
 * Workspace snapshots — the runtime's own record of what changed on disk.
 *
 * Pappy previously judged file changes from what the agent reported (a write
 * tool's new content), which cannot show what was removed and cannot tell a
 * real edit from rewriting identical content. The runtime snapshots text files
 * at task start and again before each verification, and hands Pappy the actual
 * before/after contents. The agent cannot author this evidence.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { WorkspaceEvidence, WorkspaceFileChange } from "@clawde/pappy-core";

export interface WorkspaceSnapshot {
  available: boolean;
  reason?: string;
  files: Map<string, string>;
  testCommand?: string;
}

export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 5000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 50_000_000,
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", "target", ".idea", ".vscode",
]);

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return !sample.includes(0);
}

function readTestCommand(files: Map<string, string>): string | undefined {
  const pkg = files.get("package.json");
  if (!pkg) return undefined;
  try {
    const parsed = JSON.parse(pkg) as { scripts?: Record<string, unknown> };
    const test = parsed.scripts?.["test"];
    return typeof test === "string" && test.trim() && !/no test specified/i.test(test) ? test.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function captureWorkspaceSnapshot(
  root: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<WorkspaceSnapshot> {
  const files = new Map<string, string>();
  let totalBytes = 0;
  const fail = (reason: string): WorkspaceSnapshot => ({ available: false, reason, files: new Map() });

  const walk = async (dir: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return dir === root ? `cannot read workspace: ${(err as Error).message}` : null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const problem = await walk(full);
        if (problem) return problem;
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > limits.maxFileBytes) continue;
      if (files.size + 1 > limits.maxFiles) return `more than ${limits.maxFiles} files`;
      if (totalBytes + info.size > limits.maxTotalBytes) return `more than ${limits.maxTotalBytes} bytes of text`;
      const buffer = await readFile(full).catch(() => null);
      if (!buffer || !isProbablyText(buffer)) continue;
      totalBytes += buffer.length;
      files.set(relative(root, full).split(sep).join("/"), buffer.toString("utf8"));
    }
    return null;
  };

  const problem = await walk(root);
  if (problem) return fail(problem);
  return { available: true, files, testCommand: readTestCommand(files) };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceEvidence {
  if (!before.available || !after.available) {
    return { available: false, reason: before.reason ?? after.reason ?? "snapshot unavailable", changes: [] };
  }
  const changes: WorkspaceFileChange[] = [];
  for (const [path, previous] of before.files) {
    const current = after.files.get(path);
    if (current === undefined) changes.push({ path, status: "deleted", before: previous });
    else if (current !== previous) changes.push({ path, status: "modified", before: previous, after: current });
  }
  for (const [path, current] of after.files) {
    if (!before.files.has(path)) changes.push({ path, status: "added", after: current });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { available: true, changes, testCommand: before.testCommand };
}

/**
 * Baseline once at task start; every later call compares the current disk
 * state with that baseline (so repair passes are judged cumulatively).
 */
export function createWorkspaceEvidenceCollector(
  root: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): { ready: Promise<void>; collect: () => Promise<WorkspaceEvidence> } {
  let baseline: WorkspaceSnapshot | undefined;
  const ready = captureWorkspaceSnapshot(root, limits).then((s) => { baseline = s; });
  return {
    ready,
    async collect() {
      await ready;
      return diffWorkspaceSnapshots(baseline!, await captureWorkspaceSnapshot(root, limits));
    },
  };
}
