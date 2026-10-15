import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";
import { evaluateCommandPolicy, createSandboxPolicy } from "./sandbox.js";
import { createAbortError, throwIfAborted } from "./abort.js";
import { captureProcessIdentity, findSurvivingDescendants } from "./processIdentity.js";

/** A process the command left behind, in the shape the task lifecycle records. */
interface UnsettledProcess { kind: "process"; pid: number; label: string; startedAt: string; identity?: string; reason: string; ownership?: "confirmed" | "suspected" | "unknown" }
import { resolveWorkspacePath } from "./workspacePath.js";

/** How a survivor is named and why it is kept, by what the scan could establish about who started it. */
export function describeSurvivor(name: string | undefined, ownership: "confirmed" | "suspected" | "unknown", command: string): { label: string; reason: string } {
  const exe = name ? `${name} ` : "";
  if (ownership === "confirmed") return {
    label: `${exe}(descendant of: ${command})`,
    reason: "started by the command and still running after the command's shell exited",
  };
  if (ownership === "suspected") return {
    label: `${exe}(suspected: names the workspace; created while ${command} ran)`,
    reason: "created while the command ran and its command line names the workspace, but its parent has exited so its ancestry cannot be established; treated as the command's until verified gone",
  };
  return {
    label: `${exe}(ownership unknown: created while ${command} ran)`,
    reason: "created while the command ran under a parent that has exited; nothing ties it to the command beyond timing, but that cannot be ruled out, so it is kept until verified gone",
  };
}

const COMMAND_ENV_ALLOWLIST = new Set([
  "appdata", "ci", "colorterm", "commonprogramfiles", "comspec", "force_color",
  "home", "homedrive", "homepath", "lang", "lc_all", "localappdata", "no_color",
  "number_of_processors", "os", "path", "pathext", "processor_architecture",
  "programdata", "programfiles", "programfiles(x86)", "shell", "systemroot", "temp",
  "term", "tmp", "tmpdir", "user", "username", "userprofile", "windir",
]);

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) => value !== undefined && COMMAND_ENV_ALLOWLIST.has(name.toLowerCase()),
    ),
  );
}

/**
 * Parse a shell command to detect file redirections (e.g., > file.py, >> file.py).
 * Returns an array of { path, changeType } for files that are created or modified.
 */
function detectFileChanges(command: string, cwd: string): Array<{ path: string; changeType: "A" | "M" }> {
  const changes: Array<{ path: string; changeType: "A" | "M" }> = [];
  
  // Match redirections like: > file.txt, >> file.txt, 2> file.txt, etc.
  // Also handles heredocs and other shell redirections
  const redirectionPattern = /(?:^|\s|;)\s*(\d*>)\s*(['"`])?(.+?)\2\s*(?=$|;|\s)/g;
  let match: RegExpExecArray | null;
  
  while ((match = redirectionPattern.exec(command)) !== null) {
    const filePath = match[3];
    if (filePath) {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      // Check if file exists before command execution
      const existsBefore = fs.existsSync(resolved);
      changes.push({
        path: path.relative(cwd, resolved),
        changeType: existsBefore ? "M" : "A",
      });
    }
  }
  
  // Also check for echo/cat with redirection: echo "..." > file.py
  const echoPattern = /echo\s+['"`]?(.*?)['"`]?\s*>\s*['"`]?(.+?)['"`]?\s*(?=$|;)/;
  const echoMatch = command.match(echoPattern);
  if (echoMatch) {
    const filePath = echoMatch[2];
    if (filePath) {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const existsBefore = fs.existsSync(resolved);
      changes.push({
        path: path.relative(cwd, resolved),
        changeType: existsBefore ? "M" : "A",
      });
    }
  }
  
  return changes;
}

function terminateChildProcess(child: ChildProcess): void {
  if (process.platform === "win32") {
    const pid = child.pid;
    if (pid != null) {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        child.kill();
      });
      return;
    }
    child.kill();
    return;
  }

  const pid = child.pid;
  if (pid != null) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall back to killing the shell process if the process group is gone or
      // unavailable. The close/error handlers remain responsible for settling.
    }
  }
  child.kill("SIGKILL");
}

export const runCommandTool: Tool = {
  name: "run_command",
  description: "Execute a shell command and capture its stdout and stderr.",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      cwd: {
        type: "string",
        description: "Working directory (defaults to workspace root).",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds before the process is killed (default: 30000).",
      },
    },
    required: ["command"],
  },

  async execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    throwIfAborted(ctx.abortSignal);
    const command = input["command"];
    if (typeof command !== "string" || !command) {
      return {
        ok: false,
        output: "",
        error: '"command" is required and must be a string',
      };
    }

    // Evaluate command against sandbox policy
    const sandbox = ctx.sandbox ?? createSandboxPolicy();
    const policyResult = evaluateCommandPolicy(command, sandbox);
    
    if (!policyResult.allowed) {
      return {
        ok: false,
        output: "",
        error: `Command blocked: ${policyResult.reason}`,
      };
    }
    
    // Request approval if required
    if (policyResult.requiresApproval) {
      if (!ctx.requestApproval) {
        return {
          ok: false,
          output: "",
          error: `Command requires approval, but no approval handler is configured: ${policyResult.reason}`,
        };
      }

      const approved = await ctx.requestApproval("run_command", input, policyResult.reason);
      throwIfAborted(ctx.abortSignal);
      if (!approved) {
        return {
          ok: false,
          output: "",
          error: "Command execution denied by user",
        };
      }
    }

    const rawCwd = input["cwd"];
    let cwd: string;
    try {
      cwd = resolveWorkspacePath(
        ctx.workspaceRoot,
        typeof rawCwd === "string" ? rawCwd : ".",
      );
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }

    // Cap timeout at sandbox max
    const requestedTimeout =
      typeof input["timeout"] === "number" && input["timeout"] > 0
        ? input["timeout"]
        : 30_000;
    const timeout = Math.min(requestedTimeout, sandbox.maxTimeout);

    // Detect file changes before executing the command
    const fileChanges = detectFileChanges(command, cwd);

    return new Promise<ToolResult>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let abortError: Error | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let abortFailTimer: NodeJS.Timeout | undefined;

      const spawnedAt = new Date().toISOString();
      const child = spawn(command, [], {
        cwd,
        env: commandEnvironment(process.env),
        detached: process.platform !== "win32",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const label = command.length > 120 ? `${command.slice(0, 117)}...` : command;

      // The shell's exit says nothing about what it started: a detached
      // grandchild keeps running with whatever file access it had. After the
      // shell is gone, its surviving descendants are looked up (one
      // enumeration, off the tool's critical path) and handed to the caller
      // as a non-enumerable `pendingResources` promise on the result or the
      // error. The task lifecycle tracks that scan as an operation and records
      // every survivor as an unsettled resource; "unknown" (scan unavailable)
      // is reported as such, never as "none".
      const attachScan = <T extends object>(target: T): T => {
        const pid = child.pid;
        if (pid == null) return target;
        let scan: Promise<{ status: "done" | "unknown"; resources: UnsettledProcess[] }>;
        try {
          scan = findSurvivingDescendants(pid, spawnedAt, { workspaceRoot: ctx.workspaceRoot }).then(
            (found) => found === null
              ? { status: "unknown" as const, resources: [] as UnsettledProcess[] }
              : {
                  status: "done" as const,
                  resources: found.map((f): UnsettledProcess => ({
                    kind: "process",
                    pid: f.pid,
                    ...describeSurvivor(f.name, f.ownership, label),
                    startedAt: spawnedAt,
                    ...(f.identity ? { identity: f.identity } : {}),
                    ownership: f.ownership,
                  })),
                },
            () => ({ status: "unknown" as const, resources: [] as UnsettledProcess[] }),
          );
        } catch {
          scan = Promise.resolve({ status: "unknown" as const, resources: [] as UnsettledProcess[] });
        }
        Object.defineProperty(target, "pendingResources", { value: scan, enumerable: false, configurable: true });
        return target;
      };

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortFailTimer) clearTimeout(abortFailTimer);
        if (ctx.abortSignal) {
          ctx.abortSignal.removeEventListener("abort", onAbort);
        }
        resolve(attachScan(result));
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortFailTimer) clearTimeout(abortFailTimer);
        if (ctx.abortSignal) {
          ctx.abortSignal.removeEventListener("abort", onAbort);
        }
        reject(attachScan(error));
      };

      const onAbort = (): void => {
        aborted = true;
        abortError = createAbortError(ctx.abortSignal?.reason);
        terminateChildProcess(child);
        // The kill was requested; only the child's close confirms it. If that
        // confirmation does not come, the tool gives up waiting but says so:
        // the error names the process (pid and creation time) so the task
        // lifecycle can keep the workspace protected until it is verified gone.
        abortFailTimer = setTimeout(() => {
          void (async () => {
            const pid = child.pid;
            if (settled || pid == null || child.exitCode !== null || child.signalCode !== null) {
              fail(abortError ?? createAbortError(ctx.abortSignal?.reason));
              return;
            }
            const identity = await captureProcessIdentity(pid);
            if (settled) return;
            const error = abortError ?? createAbortError(ctx.abortSignal?.reason);
            (error as Error & { unsettledResource?: unknown }).unsettledResource = {
              kind: "process",
              pid,
              label,
              startedAt: spawnedAt,
              ...(identity ? { identity } : {}),
              reason: "its termination was requested on Stop but the process had not exited after 750 ms",
            };
            fail(error);
          })();
        }, 750);
      };

      if (ctx.abortSignal?.aborted) {
        onAbort();
        return;
      }

      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      timer = setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
        const timeoutText = `Timed out after ${timeout}ms`;
        const outputWithTimeout = combined
          ? `[${timeoutText}]\n${combined}`
          : `[${timeoutText}]`;
        finish({ ok: false, output: outputWithTimeout, error: timeoutText });
      }, timeout);

      child.on("error", (err) => {
        if (aborted) {
          fail(abortError ?? createAbortError(ctx.abortSignal?.reason));
          return;
        }
        finish({ ok: false, output: "", error: err.message });
      });

      child.on("close", (code) => {
        if (aborted) {
          fail(abortError ?? createAbortError(ctx.abortSignal?.reason));
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

        if (timedOut) {
          // Preserve partial output as diagnostic evidence, but never describe
          // a timed-out command as a successful tool receipt.
          const timeoutText = `Timed out after ${timeout}ms`;
          const outputWithTimeout = combined
            ? `[${timeoutText}]\n${combined}`
            : `[${timeoutText}]`;
          finish({ ok: false, output: outputWithTimeout, error: timeoutText });
        } else if ((code ?? -1) !== 0) {
          // A non-zero process exit is a failed tool result. Keep stdout/stderr
          // in output so the agent and Pappy can diagnose the failure.
          const exitCode = code ?? -1;
          const outputWithCode = combined
            ? `[Exit code ${exitCode}]\n${combined}`
            : `[Exit code ${exitCode}]`;
          finish({
            ok: false,
            output: outputWithCode,
            error: `Command failed with exit code ${exitCode}`,
            exitCode,
          });
        } else {
          // Include file changes in the output for the caller to parse
          const outputWithChanges = fileChanges.length > 0
            ? `${combined}\n\n<!-- Files changed: ${JSON.stringify(fileChanges)} -->`
            : combined;
          finish({ ok: true, output: outputWithChanges, exitCode: 0 });
        }
      });
    });
  },
};
