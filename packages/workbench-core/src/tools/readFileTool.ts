import * as fs from "fs";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";
import { resolveWorkspacePath } from "./workspacePath.js";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the full contents of a file.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to the file.",
      },
    },
    required: ["path"],
  },

  async execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    const rawPath = input["path"];
    if (typeof rawPath !== "string" || !rawPath) {
      return { ok: false, output: "", error: '"path" is required and must be a string' };
    }

    try {
      const resolved = resolveWorkspacePath(ctx.workspaceRoot, rawPath);
      const content = fs.readFileSync(resolved, "utf8");
      return { ok: true, output: content };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};
