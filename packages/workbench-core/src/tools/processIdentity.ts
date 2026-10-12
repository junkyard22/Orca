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
 * detached, as a group leader) is used instead. Processes that left the
 * group (`setsid`) or were started by something else are not found: the
 * caller reports the scan as a lower bound, never as proof of a quiet tree.
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

export async function findSurvivingDescendants(rootPid: number, spawnedAtIso: string): Promise<SurvivingProcess[] | null> {
  if (process.env["ORCA_PROCESS_SCAN"] === "off") return null;
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  if (process.platform === "win32") {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; c=$(if($_.CreationDate){$_.CreationDate.ToString('o')}else{''}) } } | ConvertTo-Json -Compress"], SCAN_TIMEOUT_MS);
    if (!out) return null;
    let rows: Array<{ ProcessId: number; ParentProcessId: number; Name?: string; c: string }>;
    try {
      const parsed = JSON.parse(out) as unknown;
      rows = Array.isArray(parsed) ? parsed as typeof rows : [parsed as typeof rows[number]];
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
  const out = await run("ps", ["-eo", "pid=,pgid=,lstart="], SCAN_TIMEOUT_MS);
  if (!out) return null;
  const found: SurvivingProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number(m[2]) !== rootPid || pid === rootPid) continue;
    found.push({ pid, identity: m[3]!.trim(), relation: "descendant" });
  }
  return found;
}
