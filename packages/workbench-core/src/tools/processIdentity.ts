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

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
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
