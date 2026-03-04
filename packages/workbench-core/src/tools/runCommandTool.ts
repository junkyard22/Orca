import { spawn } from "child_process";
import * as path from "path";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";

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
          resolve({ ok: true, output: combined });
        }
      });
    });
  },
};
