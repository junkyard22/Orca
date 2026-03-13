import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { docsExtension } from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { workspaceRoot: process.cwd(), runId: "test-run" };

function tool(name: string) {
  const t = docsExtension.tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-docs-test-"));
  fs.writeFileSync(path.join(tmpDir, "hello.md"), "# Hello\n\nWorld");
  fs.writeFileSync(path.join(tmpDir, "data.csv"), "name,age\nAlice,30\nBob,25");
  fs.writeFileSync(path.join(tmpDir, "page.html"), "<html><body><p>Hello <b>World</b></p></body></html>");
  fs.writeFileSync(path.join(tmpDir, "notes.txt"), "plain text content");
  fs.mkdirSync(path.join(tmpDir, "sub"));
  fs.writeFileSync(path.join(tmpDir, "sub", "nested.md"), "nested file");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── docs_read ─────────────────────────────────────────────────────────────────

describe("docs_read", () => {
  const read = () => tool("docs_read");

  it("reads a markdown file verbatim", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "hello.md") }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Hello");
    expect(result.output).toContain("World");
  });

  it("reads a plain text file", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "notes.txt") }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("plain text content");
  });

  it("strips HTML tags and returns readable text", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "page.html") }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Hello");
    expect(result.output).toContain("World");
    expect(result.output).not.toContain("<html>");
    expect(result.output).not.toContain("<b>");
  });

  it("formats CSV as a markdown table", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "data.csv") }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("| name");
    expect(result.output).toContain("| Alice");
    expect(result.output).toContain("| Bob");
  });

  it("resolves relative paths against workspaceRoot", async () => {
    const cwdCtx = { workspaceRoot: tmpDir, runId: "test-run" };
    const result = await read().execute({ path: "hello.md" }, cwdCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("# Hello");
  });

  it("returns error for missing file", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "nonexistent.md") }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns error when path is missing", async () => {
    const result = await read().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path/);
  });

  it("respects maxChars truncation", async () => {
    const result = await read().execute({ path: path.join(tmpDir, "hello.md"), maxChars: 5 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(100); // truncated + message
    expect(result.output).toContain("truncated");
  });

  it("notes binary formats without crashing", async () => {
    const pdfPath = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.4 fake");
    const result = await read().execute({ path: pdfPath }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("PDF");
    expect(result.output).toContain("not yet implemented");
  });
});

// ── docs_list ─────────────────────────────────────────────────────────────────

describe("docs_list", () => {
  const list = () => tool("docs_list");

  it("lists document files in a directory (non-recursive)", async () => {
    const result = await list().execute({ dir: tmpDir }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello.md");
    expect(result.output).toContain("data.csv");
    expect(result.output).toContain("notes.txt");
    expect(result.output).not.toContain("nested.md"); // sub-dir excluded
  });

  it("lists recursively when asked", async () => {
    const result = await list().execute({ dir: tmpDir, recursive: true }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("nested.md");
  });

  it("returns a message when directory is empty of docs", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ext-docs-empty-"));
    fs.writeFileSync(path.join(empty, "script.js"), "// js");
    const result = await list().execute({ dir: empty }, ctx);
    fs.rmSync(empty, { recursive: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No document files found");
  });

  it("returns error when dir is missing", async () => {
    const result = await list().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dir/);
  });
});

// ── Extension metadata ────────────────────────────────────────────────────────

describe("docsExtension", () => {
  it("has correct id and name", () => {
    expect(docsExtension.id).toBe("@clawde/ext-docs");
    expect(docsExtension.name).toBe("Docs");
    expect(docsExtension.tools).toHaveLength(2);
  });
});
