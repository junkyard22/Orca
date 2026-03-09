import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";

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

  execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    const command = input["command"];
    if (typeof command !== "string" || !command) {
      return Promise.resolve({
        ok: false,
        output: "",
        error: '"command" is required and must be a string',
      });
    }

    const rawCwd = input["cwd"];
    const cwd =
      typeof rawCwd === "string"
        ? path.isAbsolute(rawCwd)
          ? rawCwd
          : path.resolve(ctx.workspaceRoot, rawCwd)
        : ctx.workspaceRoot;

    const timeout =
      typeof input["timeout"] === "number" && input["timeout"] > 0
        ? input["timeout"]
        : 30_000;

    // Detect file changes before executing the command
    const fileChanges = detectFileChanges(command, cwd);

    return new Promise<ToolResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const child = spawn(command, [], {
        cwd,
        env: process.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: "", error: err.message });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

        if (timedOut) {
          resolve({ ok: false, output: combined, error: `Timed out after ${timeout}ms` });
        } else if ((code ?? -1) !== 0) {
          resolve({ ok: false, output: combined, error: `Exit code ${code ?? -1}` });
        } else {
          // Include file changes in the output for the caller to parse
          const outputWithChanges = fileChanges.length > 0
            ? `${combined}\n\n<!-- Files changed: ${JSON.stringify(fileChanges)} -->`
            : combined;
          resolve({ ok: true, output: outputWithChanges });
        }
      });
    });
  },
};
