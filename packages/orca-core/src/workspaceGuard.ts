/**
 * Workspace guard — who may write to a workspace, kept apart from task state.
 *
 * A task's lifecycle says what the task is doing. It does not say whether the
 * workspace is quiet: a task marked INTERRUPTED may have left a tool running
 * in this process, or a child process whose exit was never confirmed. Both
 * can still write. The guard records that fact per workspace root and refuses
 * to let another task own the same workspace until one of three things
 * happens:
 *
 *   settlement    the in-process operations ended and no resource is left;
 *   verification  the external processes were probed and found gone (a
 *                 reused pid with a different identity counts as gone);
 *   user release  the user, told exactly what was left running, took
 *                 responsibility. Recorded as such, never silent.
 *
 * Protection survives a restart (the record is a file): after a restart the
 * in-process operations are gone by definition, so only external processes
 * are re-probed. There is no automatic reset.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ActiveOperation, TaskLifecycle, UnsettledResource } from "./lifecycle.js";

export type ProcessLiveness = "alive" | "gone" | "unknown";
/** Whether the process a resource names is still running. */
export type ProcessProbe = (resource: UnsettledResource) => Promise<ProcessLiveness> | ProcessLiveness;

export type ProtectedOperation = Pick<ActiveOperation, "kind" | "label" | "startedAt">;

export interface WorkspaceProtection {
  root: string;
  taskId: string;
  since: string;
  reason: string;
  /** Operations in this process that never settled (empty after a restart). */
  operations: ProtectedOperation[];
  /** External processes not confirmed stopped. */
  resources: UnsettledResource[];
  /** What was verified since the record was made. */
  notes: string[];
}

export interface WorkspaceRelease {
  root: string;
  taskId: string;
  at: string;
  by: "settlement" | "verification" | "user";
  reason: string;
}

export type WorkspaceGuardEvent =
  | { type: "protected"; protection: WorkspaceProtection }
  | { type: "released"; protection: WorkspaceProtection; release: WorkspaceRelease };

export interface ProtectRecord {
  taskId: string;
  reason: string;
  /** When given, the guard follows the lifecycle: settlement lifts the protection on its own. */
  lifecycle?: TaskLifecycle;
  operations?: ProtectedOperation[];
  resources?: UnsettledResource[];
}

export interface WorkspaceGuard {
  /** Protect `root` on behalf of a task whose operations or processes did not settle. */
  protect(root: string, record: ProtectRecord): WorkspaceProtection;
  /** Current protections for `root`, after re-probing their external processes. Empty when the workspace may be used. */
  status(root: string): Promise<WorkspaceProtection[]>;
  /** Every protection on record, without probing. */
  list(): WorkspaceProtection[];
  /** The user takes responsibility for `root`. Returns what was released. */
  release(root: string, reason: string): Promise<WorkspaceRelease[]>;
  /** The host saw task `taskId`'s in-process work settle; its processes, if any, are still verified before release. */
  settle(root: string, taskId: string, reason: string): Promise<WorkspaceRelease | null>;
  /** Re-read protections a previous process left, dropping the ones whose processes are verified gone. */
  recover(): Promise<{ kept: WorkspaceProtection[]; released: WorkspaceRelease[] }>;
  subscribe(listener: (event: WorkspaceGuardEvent) => void): () => void;
  /** Human-readable account of a protection and what to do about it. */
  describe(protections: WorkspaceProtection[]): string;
}

export interface WorkspaceGuardOptions {
  /** Where protections persist. In-memory only when omitted. */
  filePath?: string;
  probe?: ProcessProbe;
  now?: () => Date;
}

interface GuardFile {
  version: 1;
  protections: Array<Omit<WorkspaceProtection, "notes"> & { notes?: string[] }>;
}

/** pid existence only: a reused pid looks alive, which is the safe error. */
export const existenceProbe: ProcessProbe = (resource) => {
  try {
    process.kill(resource.pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
};

function rootKey(root: string): string {
  const absolute = resolve(root);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function describeProtections(protections: WorkspaceProtection[]): string {
  if (protections.length === 0) return "";
  const lines: string[] = [];
  for (const p of protections) {
    const what: string[] = [];
    if (p.operations.length > 0) what.push(`${p.operations.length} operation(s) never settled: ${p.operations.map((o) => `${o.kind} ${o.label}`).join(", ")}`);
    if (p.resources.length > 0) what.push(`process(es) not confirmed stopped: ${p.resources.map((r) => `pid ${r.pid} (${r.label})`).join(", ")}`);
    lines.push(`Workspace ${p.root} is protected: task ${p.taskId} ${p.reason}${what.length ? ` — ${what.join("; ")}` : ""}.`);
    for (const note of p.notes) lines.push(`  ${note}`);
  }
  lines.push("Nothing will run in this workspace until it is quiet. What to check:");
  lines.push("  1. Wait: protection lifts on its own when the listed operations end or their processes are verified gone.");
  lines.push("  2. If a process is listed, look for it (Task Manager, or `ps`) and end it if it is still writing to the workspace.");
  lines.push("  3. Review what changed before continuing (for example `git status` / `git diff`); a stopped worker may have left a partial edit.");
  lines.push("  4. Once you have verified nothing is still writing, release the workspace. The release is recorded as a manual decision.");
  return lines.join("\n");
}

export function createWorkspaceGuard(options: WorkspaceGuardOptions = {}): WorkspaceGuard {
  const now = options.now ?? (() => new Date());
  const probe = options.probe ?? existenceProbe;
  const protections = new Map<string, WorkspaceProtection>(); // key: rootKey + "\0" + taskId
  const followers = new Map<string, () => void>();
  const lifecycles = new Map<string, TaskLifecycle>();
  const listeners: Array<(event: WorkspaceGuardEvent) => void> = [];

  const keyOf = (root: string, taskId: string) => `${rootKey(root)}\0${taskId}`;

  const persist = (): void => {
    if (!options.filePath) return;
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
      const file: GuardFile = { version: 1, protections: [...protections.values()] };
      const tmp = `${options.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), "utf8");
      renameSync(tmp, options.filePath);
    } catch {
      // Persistence is best effort; the in-memory record still protects this process.
    }
  };

  const readFile = (): WorkspaceProtection[] => {
    if (!options.filePath || !existsSync(options.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(options.filePath, "utf8")) as Partial<GuardFile>;
      return Array.isArray(parsed.protections)
        ? parsed.protections
            .filter((p): p is GuardFile["protections"][number] => !!p && typeof p.root === "string" && typeof p.taskId === "string")
            .map((p) => ({ ...p, operations: p.operations ?? [], resources: p.resources ?? [], notes: p.notes ?? [] }))
        : [];
    } catch {
      return [];
    }
  };

  const emit = (event: WorkspaceGuardEvent): void => {
    for (const l of listeners) l(event);
  };

  const drop = (p: WorkspaceProtection, by: WorkspaceRelease["by"], reason: string): WorkspaceRelease => {
    const key = keyOf(p.root, p.taskId);
    protections.delete(key);
    followers.get(key)?.();
    followers.delete(key);
    lifecycles.delete(key);
    persist();
    const release: WorkspaceRelease = { root: p.root, taskId: p.taskId, at: now().toISOString(), by, reason };
    emit({ type: "released", protection: p, release });
    return release;
  };

  /** Re-probe a protection's processes; returns true when nothing is left and it was released. */
  const verify = async (p: WorkspaceProtection, lifecycle?: TaskLifecycle): Promise<boolean> => {
    if (!protections.has(keyOf(p.root, p.taskId))) return true;
    const remaining: UnsettledResource[] = [];
    for (const r of p.resources) {
      let liveness: ProcessLiveness;
      try { liveness = await probe(r); } catch { liveness = "unknown"; }
      if (liveness === "gone") {
        p.notes.push(`process ${r.pid} (${r.label}) verified gone at ${now().toISOString()}`);
        lifecycle?.releaseResource(r.pid, "verified gone");
      } else {
        remaining.push(r);
      }
    }
    p.resources = remaining;
    if (lifecycle) p.operations = lifecycle.activeOperations().map(({ kind, label, startedAt }) => ({ kind, label, startedAt }));
    persist();
    if (p.operations.length === 0 && p.resources.length === 0) {
      drop(p, lifecycle ? "settlement" : "verification", lifecycle ? "every operation settled and every process was verified gone" : "every process was verified gone");
      return true;
    }
    return false;
  };

  const protect = (root: string, record: ProtectRecord): WorkspaceProtection => {
    const key = keyOf(root, record.taskId);
    const existing = protections.get(key);
    if (existing) return existing;
    const lifecycle = record.lifecycle;
    const p: WorkspaceProtection = {
      root: resolve(root),
      taskId: record.taskId,
      since: now().toISOString(),
      reason: record.reason,
      operations: lifecycle ? lifecycle.activeOperations().map(({ kind, label, startedAt }) => ({ kind, label, startedAt })) : [...(record.operations ?? [])],
      resources: lifecycle ? lifecycle.unsettledResources() : [...(record.resources ?? [])],
      notes: [],
    };
    protections.set(key, p);
    if (lifecycle) {
      // Follow the task: when its last operation ends, re-verify; settlement
      // releases the workspace by itself.
      const unsub = lifecycle.subscribe(() => {
        if (!protections.has(key)) return;
        p.operations = lifecycle.activeOperations().map(({ kind, label, startedAt }) => ({ kind, label, startedAt }));
        p.resources = lifecycle.unsettledResources();
        persist();
        if (p.operations.length === 0) void verify(p, lifecycle);
      });
      followers.set(key, unsub);
      lifecycles.set(key, lifecycle);
    }
    persist();
    emit({ type: "protected", protection: p });
    return p;
  };

  const status = async (root: string): Promise<WorkspaceProtection[]> => {
    const key = rootKey(root);
    const matching = [...protections.values()].filter((p) => rootKey(p.root) === key);
    const still: WorkspaceProtection[] = [];
    for (const p of matching) {
      if (!(await verify(p, lifecycles.get(keyOf(p.root, p.taskId))))) still.push(p);
    }
    return still;
  };

  const release = async (root: string, reason: string): Promise<WorkspaceRelease[]> => {
    const key = rootKey(root);
    const matching = [...protections.values()].filter((p) => rootKey(p.root) === key);
    return matching.map((p) => drop(p, "user", reason));
  };

  const settle = async (root: string, taskId: string, reason: string): Promise<WorkspaceRelease | null> => {
    const p = protections.get(keyOf(root, taskId));
    if (!p) return null;
    if (lifecycles.has(keyOf(root, taskId))) return null; // the lifecycle itself decides
    p.operations = [];
    p.notes.push(`${reason} at ${now().toISOString()}`);
    persist();
    if (p.resources.length === 0) return drop(p, "settlement", reason);
    return (await verify(p)) ? { root: p.root, taskId, at: now().toISOString(), by: "verification", reason } : null;
  };

  const recover = async (): Promise<{ kept: WorkspaceProtection[]; released: WorkspaceRelease[] }> => {
    const kept: WorkspaceProtection[] = [];
    const released: WorkspaceRelease[] = [];
    for (const p of readFile()) {
      const key = keyOf(p.root, p.taskId);
      if (protections.has(key)) continue;
      // Operations of a previous process cannot still be running; its child
      // processes can, and only those are re-probed.
      if (p.operations.length > 0) {
        p.notes.push(`${p.operations.length} in-process operation(s) ended with the previous Orca process (${p.operations.map((o) => `${o.kind} ${o.label}`).join(", ")}); their last writes may be partial`);
        p.operations = [];
      }
      protections.set(key, p);
      if (await verify(p)) {
        released.push({ root: p.root, taskId: p.taskId, at: now().toISOString(), by: "verification", reason: "no process survived the restart" });
      } else {
        kept.push(p);
      }
    }
    persist();
    return { kept, released };
  };

  return {
    protect,
    status,
    list: () => [...protections.values()],
    release,
    settle,
    recover,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    describe: describeProtections,
  };
}

/** Thrown by the runtime when a task would start in a protected workspace. No model was called. */
export class WorkspaceProtectedError extends Error {
  readonly protections: WorkspaceProtection[];
  constructor(protections: WorkspaceProtection[]) {
    super(describeProtections(protections));
    this.name = "WorkspaceProtectedError";
    this.protections = protections;
  }
}
