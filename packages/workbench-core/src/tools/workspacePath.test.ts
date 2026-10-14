/**
 * Workspace-relative paths that name the workspace folder itself. Found live
 * in the 1.7.0 rehearsal: the worker addressed "project/src/parse.js" inside
 * a workspace called "project", every read failed with ENOENT, and the task
 * was lost. The prefix is dropped only when the workspace has no subfolder of
 * its own name; a genuine subfolder keeps the literal meaning.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveWorkspacePath, stripWorkspaceFolderPrefix } from "./workspacePath.js";

function workspaceNamed(name: string): { root: string; real: string; dispose: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "orca-wsp-"));
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "parse.js"), "module.exports = {};\n");
  // The resolver returns real paths; Windows temp dirs may be handed out as 8.3 short names.
  return { root, real: realpathSync.native(root), dispose: () => rmSync(parent, { recursive: true, force: true }) };
}

describe("workspace folder prefix", () => {
  it("drops a leading segment that names the workspace when no such subfolder exists", () => {
    const ws = workspaceNamed("project");
    try {
      expect(stripWorkspaceFolderPrefix(ws.root, "project/src/parse.js")).toBe(["src", "parse.js"].join(sep));
      expect(stripWorkspaceFolderPrefix(ws.root, "project\\src")).toBe("src");
      expect(stripWorkspaceFolderPrefix(ws.root, "project")).toBe("project"); // a single segment is left alone
      expect(resolveWorkspacePath(ws.root, "project/src/parse.js")).toBe(join(ws.real, "src", "parse.js"));
      expect(resolveWorkspacePath(ws.root, "src/parse.js")).toBe(join(ws.real, "src", "parse.js"));
    } finally { ws.dispose(); }
  });

  it("keeps the literal path when the workspace really contains a subfolder of its own name", () => {
    const ws = workspaceNamed("project");
    try {
      mkdirSync(join(ws.root, "project"), { recursive: true });
      writeFileSync(join(ws.root, "project", "inner.txt"), "x");
      expect(stripWorkspaceFolderPrefix(ws.root, "project/inner.txt")).toBe("project/inner.txt");
      expect(resolveWorkspacePath(ws.root, "project/inner.txt")).toBe(join(ws.real, "project", "inner.txt"));
    } finally { ws.dispose(); }
  });

  it("never applies to other names, absolute paths, or paths escaping the workspace", () => {
    const ws = workspaceNamed("project");
    try {
      expect(stripWorkspaceFolderPrefix(ws.root, "other/src/parse.js")).toBe("other/src/parse.js");
      expect(resolveWorkspacePath(ws.root, join(ws.root, "src", "parse.js"))).toBe(join(ws.real, "src", "parse.js"));
      expect(() => resolveWorkspacePath(ws.root, "project/../../escape.txt")).toThrow(/outside the workspace/);
    } finally { ws.dispose(); }
  });
});
