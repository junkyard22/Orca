import * as fs from "fs";
import * as path from "path";
import type { Tool, ToolResult, ToolRunCtx } from "./types.js";

// Directories never worth descending into.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".cache", "coverage"]);

const MAX_RESULTS = 50;

function matchesGlob(filename: string, glob: string): boolean {
  // Support *.ext patterns and simple prefix/suffix wildcards.
  if (glob.startsWith("*.")) {
    return filename.endsWith(glob.slice(1));
  }
  if (glob.endsWith(".*")) {
    return filename.startsWith(glob.slice(0, -2));
  }
  // No wildcard — treat as exact filename match.
  return filename === glob;
}

function walk(
  dir: string,
  glob: string | undefined,
  pattern: string,
  results: string[],
): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), glob, pattern, results);
      }
    } else if (entry.isFile()) {
      if (glob !== undefined && !matchesGlob(entry.name, glob)) continue;

      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue; // skip binary / unreadable files
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(pattern)) {
          results.push(`${filePath}:${i + 1}: ${lines[i]!.trim()}`);
          if (results.length >= MAX_RESULTS) break;
        }
      }
    }
  }
}

export const searchFilesTool: Tool = {
  name: "search_files",
  description: "Search for a text pattern across files in the workspace. Returns file:line matches.",
  schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Literal text to search for.",
      },
      directory: {
        type: "string",
        description: "Directory to search within (defaults to workspace root).",
      },
      glob: {
        type: "string",
        description: "Filename glob to limit search, e.g. '*.ts' or '*.md'.",
      },
    },
    required: ["pattern"],
  },

  async execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult> {
    const pattern = input["pattern"];
    if (typeof pattern !== "string" || !pattern) {
      return { ok: false, output: "", error: '"pattern" is required and must be a string' };
    }

    const rawDir =
      typeof input["directory"] === "string" ? input["directory"] : ".";
    const searchDir = path.isAbsolute(rawDir)
      ? rawDir
      : path.resolve(ctx.workspaceRoot, rawDir);

    const glob =
      typeof input["glob"] === "string" ? input["glob"] : undefined;

    const results: string[] = [];
    walk(searchDir, glob, pattern, results);

    if (results.length === 0) {
      return { ok: true, output: "No matches found." };
    }

    const note =
      results.length >= MAX_RESULTS
        ? `\n(results limited to first ${MAX_RESULTS} matches)`
        : "";

    return { ok: true, output: results.join("\n") + note };
  },
};
