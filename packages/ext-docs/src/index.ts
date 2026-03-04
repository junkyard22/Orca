/**
 * @clawde/ext-docs — Orca extension for document reading
 *
 * Tools:
 *   docs_read — read a local document file with format-aware extraction
 *               (.md .txt → raw, .html → tags stripped, .csv → table)
 *   docs_list — list document files in a directory
 *
 * Planned (not yet implemented):
 *   .pdf  — requires pdf-parse or pdfjs (add as dependency when needed)
 *   .docx — requires mammoth or docx (add as dependency when needed)
 *
 * Usage:
 *   import { docsExtension } from "@clawde/ext-docs";
 *   const reg = await createExtensionRegistry([docsExtension]);
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OrcaExtension, ExtTool, ExtToolRunCtx, ExtToolResult } from "@clawde/orca-core";

// ── Parse helpers ─────────────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseCsv(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (!lines.length) return "(empty CSV)";
  const rows = lines.map((l) =>
    l.split(",").map((c) => c.trim().replace(/^"|"$/g, "").replace(/""/g, '"')),
  );
  const colWidths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i] ?? 0, cell.length);
    });
  }
  const fmt = (row: string[]) =>
    "| " + row.map((c, i) => c.padEnd(colWidths[i] ?? 0)).join(" | ") + " |";
  const sep = "| " + (colWidths.map((w) => "-".repeat(w))).join(" | ") + " |";

  const [header, ...body] = rows;
  return [fmt(header ?? []), sep, ...body.map(fmt)].join("\n");
}

const DOC_EXTENSIONS = [".md", ".txt", ".html", ".htm", ".csv", ".pdf", ".docx", ".rst", ".log"];
const READABLE_EXTS  = new Set([".md", ".txt", ".html", ".htm", ".csv", ".rst", ".log"]);
const BINARY_EXTS    = new Set([".pdf", ".docx"]);

// ── Tool: docs_read ───────────────────────────────────────────────────────

const docsReadTool: ExtTool = {
  name: "docs_read",
  description:
    "Read a local document file and return its text content. " +
    "Supports .md, .txt, .log, .rst (raw), .html/.htm (HTML stripped), " +
    ".csv (formatted as markdown table). " +
    ".pdf and .docx are noted but not yet extractable.",
  schema: {
    type: "object",
    properties: {
      path:     { type: "string", description: "Absolute or workspace-relative file path." },
      maxChars: { type: "number", description: "Maximum characters to return (default 12 000, max 40 000)." },
    },
    required: ["path"],
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const rawPath = input["path"];
    if (typeof rawPath !== "string" || !rawPath) {
      return { ok: false, output: "", error: '"path" is required.' };
    }
    const maxChars = Math.min(
      typeof input["maxChars"] === "number" ? input["maxChars"] : 12_000,
      40_000,
    );

    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ctx.workspaceRoot, rawPath);

    const ext = path.extname(resolved).toLowerCase();

    if (BINARY_EXTS.has(ext)) {
      return {
        ok: true,
        output: `[${ext.slice(1).toUpperCase()} file detected: ${resolved}]\n` +
          `Binary extraction for ${ext} is not yet implemented. ` +
          `Copy the text manually or convert to .txt/.md first.`,
      };
    }

    try {
      const raw = fs.readFileSync(resolved, "utf8");

      let text: string;
      if (ext === ".html" || ext === ".htm") {
        text = stripHtmlTags(raw);
      } else if (ext === ".csv") {
        text = parseCsv(raw);
      } else {
        text = raw;
      }

      const truncated = text.length > maxChars
        ? text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars — full file is ${text.length} chars]`
        : text;

      return { ok: true, output: truncated };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ── Tool: docs_list ───────────────────────────────────────────────────────

const docsListTool: ExtTool = {
  name: "docs_list",
  description: "List document files in a directory (recursively optional). " +
    "Finds .md, .txt, .html, .csv, .pdf, .docx, .rst, .log files.",
  schema: {
    type: "object",
    properties: {
      dir:       { type: "string", description: "Absolute or workspace-relative directory path." },
      recursive: { type: "boolean", description: "Recurse into subdirectories (default false)." },
    },
    required: ["dir"],
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const rawDir = input["dir"];
    if (typeof rawDir !== "string" || !rawDir) {
      return { ok: false, output: "", error: '"dir" is required.' };
    }
    const recursive = input["recursive"] === true;

    const resolved = path.isAbsolute(rawDir)
      ? rawDir
      : path.resolve(ctx.workspaceRoot, rawDir);

    const found: string[] = [];

    function walk(dir: string, depth: number): void {
      if (depth > 8) return; // safety cap
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (["node_modules", "dist", "__pycache__", ".git"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) walk(full, depth + 1);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (DOC_EXTENSIONS.includes(ext)) {
            const rel = path.relative(resolved, full);
            const readable = READABLE_EXTS.has(ext) ? "" : " [binary — not directly readable]";
            found.push(`${rel}${readable}`);
          }
        }
      }
    }

    walk(resolved, 0);

    if (!found.length) {
      return { ok: true, output: `No document files found in ${rawDir}.` };
    }

    return {
      ok: true,
      output: `Document files in ${rawDir}${recursive ? " (recursive)" : ""}:\n\n` +
        found.join("\n"),
    };
  },
};

// ── Extension export ──────────────────────────────────────────────────────

export const docsExtension: OrcaExtension = {
  id:      "@clawde/ext-docs",
  name:    "Docs",
  version: "0.1.0",
  tools:   [docsReadTool, docsListTool],
};

export default docsExtension;
