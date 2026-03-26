import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";
import { evaluateCommandPolicy, createSandboxPolicy } from "./sandbox.js";
import { createAbortError, throwIfAborted } from "./abort.js";

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
    if (policyResult.requiresApproval && ctx.requestApproval) {
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
    const cwd =
      typeof rawCwd === "string"
        ? path.isAbsolute(rawCwd)
          ? rawCwd
          : path.resolve(ctx.workspaceRoot, rawCwd)
        : ctx.workspaceRoot;

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

      const child = spawn(command, [], {
        cwd,
        env: process.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortFailTimer) clearTimeout(abortFailTimer);
        if (ctx.abortSignal) {
          ctx.abortSignal.removeEventListener("abort", onAbort);
        }
        resolve(result);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortFailTimer) clearTimeout(abortFailTimer);
        if (ctx.abortSignal) {
          ctx.abortSignal.removeEventListener("abort", onAbort);
        }
        reject(error);
      };

      const onAbort = (): void => {
        aborted = true;
        abortError = createAbortError(ctx.abortSignal?.reason);
        terminateChildProcess(child);
        abortFailTimer = setTimeout(() => {
          fail(abortError ?? createAbortError(ctx.abortSignal?.reason));
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
          finish({ ok: false, output: combined, error: `Timed out after ${timeout}ms` });
        } else if ((code ?? -1) !== 0) {
          finish({ ok: false, output: combined, error: `Exit code ${code ?? -1}` });
        } else {
          // Include file changes in the output for the caller to parse
          const outputWithChanges = fileChanges.length > 0
            ? `${combined}\n\n<!-- Files changed: ${JSON.stringify(fileChanges)} -->`
            : combined;
          finish({ ok: true, output: outputWithChanges });
        }
      });
    });
  },
};
