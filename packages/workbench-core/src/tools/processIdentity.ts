/**
 * Process identity — telling a child process we started from a stranger that
 * inherited its pid.
 *
 * A pid alone is not an identity: once the original process exits the number
 * can be handed to anything. When a kill cannot be confirmed, the host
 * captures the process's creation time next to its pid; a later probe treats
 * "alive with a different creation time" as gone. Capture runs only on that
 * failure path, so the normal command run pays nothing.
 */
import { execFile } from "node:child_process";

export type ProcessLiveness = "alive" | "gone" | "unknown";

export interface ProcessIdentity {
  pid: number;
  /** Creation time as the OS reports it, or undefined when it could not be read. */
  identity?: string;
}

const PROBE_TIMEOUT_MS = 3000;
/** A full process enumeration is slower than a single probe; it runs off the tool's critical path. */
const SCAN_TIMEOUT_MS = 10_000;

function run(file: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? undefined : String(stdout).trim() || undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** The creation time of `pid` as the OS reports it, or undefined. Best effort, bounded. */
export async function captureProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToString('o')`]);
    return out && /^\d{4}-\d{2}-\d{2}T/.test(out) ? out : undefined;
  }
  const out = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
  return out || undefined;
}

/** Whether `pid` still exists at all, without reading its identity. */
export function processExists(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * Is the process we recorded still running? "gone" when the pid no longer
 * exists or belongs to a process with a different creation time; "alive"
 * when it exists and the identity matches or could not be compared; never
 * optimistic about an unknown.
 */
export async function probeProcess(record: ProcessIdentity): Promise<ProcessLiveness> {
  const exists = processExists(record.pid);
  if (exists !== "alive") return exists;
  if (!record.identity) return "alive";
  const current = await captureProcessIdentity(record.pid);
  if (!current) return "alive";
  return current === record.identity ? "alive" : "gone";
}

/**
 * Descendants of `rootPid` that are still alive after it exited. A parent's
 * exit says nothing about its children: a grandchild started detached keeps
 * running and keeps whatever file access it had.
 *
 * Windows keeps a process's original ParentProcessId after the parent dies,
 * so the tree can be rebuilt from one enumeration; a pid reused since the
 * root was spawned is excluded by creation time. POSIX reparents orphans to
 * init, so membership of the root's process group (the tool spawns the root
 * detached, as a group leader) finds the chain that stayed in the group, and
 * a process created while the command ran whose parent is gone is reported as
 * a suspected descendant ("orphan"), which is how a detached grandchild that
 * called setsid is caught. Processes started by something else during the
 * command window can be flagged the same way, and a process that stayed
 * hidden behind a live unrelated parent is not found: the caller reports the
 * scan as a lower bound, never as proof of a quiet tree.
 *
 * Returns null when the scan could not run (no PowerShell / ps, timeout):
 * "unknown", which the caller must not treat as "none".
 */
export interface SurvivingProcess extends ProcessIdentity {
  /** Executable name when the enumeration reports it (Windows). */
  name?: string;
  /** "descendant": reached from the root through live processes; "orphan": created while the command ran, parent dead, ancestry unprovable. */
  relation: "descendant" | "orphan";
}

type WindowsRow = { ProcessId: number; ParentProcessId: number; Name?: string; c: string };

/**
 * One enumeration serves every scan requested within a short window. The
 * enumeration starts only after the window closes, so its snapshot is taken
 * after each sharing request was made — i.e. after each command's shell had
 * exited — which is exactly what an individual scan would see. An
 * enumeration already in flight is never shared (its snapshot may predate
 * a later request). The guarantee is unchanged; the cost of a burst of
 * parallel commands drops from one enumeration per command to one.
 */
const COALESCE_WINDOW_MS = 150;
let scheduled: { promise: Promise<string | undefined>; timer: NodeJS.Timeout } | null = null;
const scanStats = { requests: 0, enumerations: 0 };

/** How many scans were requested and how many enumerations actually ran (diagnostics / tests). */
export function survivorScanStatistics(): { requests: number; enumerations: number } {
  return { ...scanStats };
}

function coalescedEnumeration(start: () => Promise<string | undefined>): Promise<string | undefined> {
  scanStats.requests++;
  if (scheduled) return scheduled.promise;
  let resolve!: (v: string | undefined) => void;
  const promise = new Promise<string | undefined>((r) => { resolve = r; });
  const timer = setTimeout(() => {
    scheduled = null;
    scanStats.enumerations++;
    start().then(resolve, () => resolve(undefined));
  }, COALESCE_WINDOW_MS);
  scheduled = { promise, timer };
  return promise;
}

export async function findSurvivingDescendants(rootPid: number, spawnedAtIso: string): Promise<SurvivingProcess[] | null> {
  if (process.env["ORCA_PROCESS_SCAN"] === "off") return null;
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  if (process.platform === "win32") {
    const out = await coalescedEnumeration(() => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; c=$(if($_.CreationDate){$_.CreationDate.ToString('o')}else{''}) } } | ConvertTo-Json -Compress"], SCAN_TIMEOUT_MS));
    if (!out) return null;
    let rows: WindowsRow[];
    try {
      const parsed = JSON.parse(out) as unknown;
      rows = Array.isArray(parsed) ? parsed as WindowsRow[] : [parsed as WindowsRow];
    } catch {
      return null;
    }
    const spawnedAt = Date.parse(spawnedAtIso);
    const alive = new Set<number>();
    const children = new Map<number, Array<{ pid: number; identity?: string; name?: string; parent: number }>>();
    const recent: Array<{ pid: number; identity?: string; name?: string; parent: number }> = [];
    for (const r of rows) {
      if (typeof r?.ProcessId !== "number" || typeof r?.ParentProcessId !== "number") continue;
      alive.add(r.ProcessId);
      // A process created before the root was spawned cannot be its descendant
      // (its parent pid was reused); 2 s of slack for clock granularity.
      const created = r.c ? Date.parse(r.c) : NaN;
      if (Number.isFinite(created) && Number.isFinite(spawnedAt) && created < spawnedAt - 2000) continue;
      const entry = { pid: r.ProcessId, ...(r.c ? { identity: r.c } : {}), ...(typeof r.Name === "string" ? { name: r.Name } : {}), parent: r.ParentProcessId };
      const list = children.get(r.ParentProcessId) ?? [];
      list.push(entry);
      children.set(r.ParentProcessId, list);
      recent.push(entry);
    }
    const found: SurvivingProcess[] = [];
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const c of children.get(parent) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        if (processExists(c.pid) === "alive") found.push({ pid: c.pid, ...(c.identity ? { identity: c.identity } : {}), ...(c.name ? { name: c.name } : {}), relation: "descendant" });
        queue.push(c.pid);
      }
    }
    // A chain through a dead intermediate (shell → node → grandchild, node
    // gone) cannot be walked. A process created while the command ran whose
    // parent no longer exists is reported as a suspected descendant: ancestry
    // cannot be established, and unknown is reported, not dropped.
    for (const c of recent) {
      if (seen.has(c.pid) || alive.has(c.parent) || c.pid === process.pid) continue;
      seen.add(c.pid);
      if (processExists(c.pid) === "alive") found.push({ pid: c.pid, ...(c.identity ? { identity: c.identity } : {}), ...(c.name ? { name: c.name } : {}), relation: "orphan" });
    }
    return found;
  }
  const out = await coalescedEnumeration(() => run("ps", ["-eo", "pid=,ppid=,pgid=,comm=,lstart="], SCAN_TIMEOUT_MS));
  if (!out) return null;
  return parsePosixSurvivors(out, rootPid, spawnedAtIso, process.pid, processExists);
}

/**
 * POSIX counterpart of the Windows walk. Group members are descendants; a
 * process created while the command ran whose parent is gone (reparented to
 * init, or to a subreaper) is a suspected descendant — a detached grandchild
 * calls setsid and leaves the group, which is exactly the case the scan
 * exists for, so group membership alone is a blind spot (CI on Linux showed
 * it). Exported for parsing tests; the enumeration itself is `ps`.
 */
export function parsePosixSurvivors(
  psOutput: string,
  rootPid: number,
  spawnedAtIso: string,
  selfPid: number,
  exists: (pid: number) => ProcessLiveness = processExists,
): SurvivingProcess[] {
  const spawnedAt = Date.parse(spawnedAtIso);
  type Row = { pid: number; ppid: number; pgid: number; name: string; started: string };
  const rows: Row[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), name: m[4]!, started: m[5]!.trim() });
  }
  const alive = new Set(rows.map((r) => r.pid));
  const found: SurvivingProcess[] = [];
  const seen = new Set<number>([rootPid]);
  for (const r of rows) {
    if (r.pgid !== rootPid || r.pid === rootPid) continue;
    seen.add(r.pid);
    found.push({ pid: r.pid, identity: r.started, name: r.name, relation: "descendant" });
  }
  for (const r of rows) {
    if (seen.has(r.pid) || r.pid === selfPid || alive.has(r.ppid) && r.ppid !== 1) continue;
    // Created before the command started: cannot be its descendant (2 s slack for `lstart` granularity).
    const created = Date.parse(r.started);
    if (Number.isFinite(created) && Number.isFinite(spawnedAt) && created < spawnedAt - 2000) continue;
    if (r.ppid === 1 && !Number.isFinite(created)) continue; // unparseable start time: say nothing about long-lived init children
    seen.add(r.pid);
    if (exists(r.pid) === "alive") found.push({ pid: r.pid, identity: r.started, name: r.name, relation: "orphan" });
  }
  return found;
}
