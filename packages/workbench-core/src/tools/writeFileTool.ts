import * as fs from "fs";
import * as path from "path";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file and any missing parent directories if they do not exist.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to the file.",
      },
      content: {
        type: "string",
        description: "Full content to write to the file.",
      },
    },
    required: ["path", "content"],
  },

  async execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    const rawPath = input["path"];
    const content = input["content"];

    if (typeof rawPath !== "string" || !rawPath) {
      return { ok: false, output: "", error: '"path" is required and must be a string' };
    }
    if (typeof content !== "string") {
      return { ok: false, output: "", error: '"content" must be a string' };
    }

    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ctx.workspaceRoot, rawPath);

    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      return {
        ok: true,
        output: `Wrote ${content.length} bytes to ${resolved}`,
      };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};
