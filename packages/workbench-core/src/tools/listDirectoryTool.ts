import * as fs from "fs";
import * as path from "path";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";

export const listDirectoryTool: Tool = {
  name: "list_directory",
  description: "List the files and subdirectories at a path.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to the directory.",
      },
    },
    required: ["path"],
  },

  async execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    const rawPath = input["path"];
    if (typeof rawPath !== "string" || !rawPath) {
      return { ok: false, output: "", error: '"path" is required and must be a string' };
    }

    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ctx.workspaceRoot, rawPath);

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `d  ${e.name}/` : `f  ${e.name}`));
      return { ok: true, output: lines.join("\n") || "(empty directory)" };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};
