/**
 * Miranda's argument validation for MCP tools (audit F-02) and the workspace
 * boundary for path arguments (audit F-14: traversal and symlinks).
 * Schemas go through the real MCP → Orca conversion shape; paths are real
 * temporary directories and links.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirandaGate } from "./mirandaGate.js";

const dirs: string[] = [];
const tmp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `orca-${name}-`))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// What mcp-client's convertSchema produces: integer → number, array/object kept, everything else string.
const pushFiles = {
  required: ["owner", "repo", "files"],
  properties: { owner: { type: "string" }, repo: { type: "string" }, files: { type: "array" }, perPage: { type: "number" }, draft: { type: "boolean" }, options: { type: "object" } },
};
const validPush = { owner: "o", repo: "r", files: [{ path: "a.txt", content: "x" }], perPage: 10, draft: false, options: { labels: ["bug"], nested: { deep: [1, 2, { k: "v" }] } } };

describe("argument types", () => {
  const gate = createMirandaGate();
  const check = (args: Record<string, unknown>, schema = pushFiles) => gate.beforeToolRun({ tool: "github-mcp_push_files", args, schema });

  it("accepts native arrays, nested objects, numbers and booleans", () => {
    expect(check(validPush)).toMatchObject({ allowed: true });
    expect(gate.beforeToolRun({ tool: "desktop-commander_read_multiple_files", args: { paths: ["src/a.ts", "src/b.ts"] }, schema: { required: ["paths"], properties: { paths: { type: "array" } } } }))
      .toMatchObject({ allowed: true });
    expect(check({ ...validPush, files: [] })).toMatchObject({ allowed: true });
  });

  it("accepts an integer for a raw JSON-schema integer and rejects a fraction", () => {
    const schema = { required: ["n"], properties: { n: { type: "integer" } } };
    expect(gate.beforeToolRun({ tool: "srv_get_page", args: { n: 3 }, schema })).toMatchObject({ allowed: true });
    expect(gate.beforeToolRun({ tool: "srv_get_page", args: { n: 3.5 }, schema })).toMatchObject({ allowed: false });
  });

  it.each([
    ["an object where an array is declared", { files: { path: "a.txt" } }],
    ["a string where an array is declared", { files: "a.txt" }],
    ["a JSON string smuggled in place of an array", { files: JSON.stringify([{ path: "/etc/passwd" }]) }],
    ["an array where an object is declared", { options: ["x"] }],
    ["a JSON string where an object is declared", { options: "{\"a\":1}" }],
    ["a string where a number is declared", { perPage: "10" }],
    ["NaN where a number is declared", { perPage: Number.NaN }],
    ["a number where a string is declared", { owner: 7 }],
    ["an array where a string is declared", { repo: ["r"] }],
    ["a string where a boolean is declared", { draft: "false" }],
  ])("rejects %s", (_name, override) => {
    const result = check({ ...validPush, ...override });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/must be/);
  });

  it("still rejects missing required fields and null arguments", () => {
    expect(check({ owner: "o", repo: "r" }).allowed).toBe(false);
    expect(check({ ...validPush, files: null }).allowed).toBe(false);
  });
});

describe("valid argument shapes do not buy permissions", () => {
  const connectorTools = ["github-mcp_push_files", "github-mcp_list_issues"];
  const gateFor = (p: { fileWrite: boolean; networkAccess: boolean }) =>
    createMirandaGate({ taskPermissions: { fileRead: true, shellExec: false, ...p }, connectorTools });

  it("blocks a well-formed connector write when the task may not write or use the network", () => {
    const args = { tool: "github-mcp_push_files", args: validPush, schema: pushFiles };
    expect(gateFor({ fileWrite: false, networkAccess: true }).beforeToolRun(args)).toMatchObject({ allowed: false, reason: expect.stringMatching(/Connector writes are not permitted/) });
    expect(gateFor({ fileWrite: true, networkAccess: false }).beforeToolRun(args)).toMatchObject({ allowed: false, reason: expect.stringMatching(/Connector access is not permitted/) });
    expect(gateFor({ fileWrite: true, networkAccess: true }).beforeToolRun(args)).toMatchObject({ allowed: true });
  });

  it("blocks well-formed MCP file writes and shell calls the task did not permit, and allows reads", () => {
    const gate = gateFor({ fileWrite: false, networkAccess: false });
    const arr = { required: ["paths"], properties: { paths: { type: "array" } } };
    expect(gate.beforeToolRun({ tool: "desktop-commander_write_file", args: { path: "a.txt", content: "x" } })).toMatchObject({ allowed: false });
    expect(gate.beforeToolRun({ tool: "desktop-commander_start_process", args: { command: "ls", args: ["-la"] }, schema: { properties: { args: { type: "array" } } } })).toMatchObject({ allowed: false });
    expect(gate.beforeToolRun({ tool: "desktop-commander_read_multiple_files", args: { paths: ["a.ts"] }, schema: arr })).toMatchObject({ allowed: true });
    expect(gate.beforeToolRun({ tool: "github-mcp_list_issues", args: { labels: ["bug"] }, schema: { properties: { labels: { type: "array" } } } })).toMatchObject({ allowed: false });
  });

  it("checks paths inside arrays and nested objects against the workspace", () => {
    const ws = tmp("ws");
    const gate = createMirandaGate();
    const arr = { required: ["paths"], properties: { paths: { type: "array" } } };
    expect(gate.beforeToolRun({ tool: "desktop-commander_read_multiple_files", args: { paths: ["src/a.ts", "../outside.ts"] }, schema: arr, workspaceRoot: ws })).toMatchObject({ allowed: false });
    expect(gate.beforeToolRun({ tool: "github-mcp_push_files", args: { ...validPush, files: [{ path: "/etc/passwd", content: "x" }] }, schema: pushFiles, workspaceRoot: ws })).toMatchObject({ allowed: false });
    expect(gate.beforeToolRun({ tool: "srv_apply", args: { options: { target: { path: join(ws, "..", "elsewhere") } } }, schema: { properties: { options: { type: "object" } } }, workspaceRoot: ws })).toMatchObject({ allowed: false });
    expect(gate.beforeToolRun({ tool: "desktop-commander_read_multiple_files", args: { paths: ["src/a.ts", "b.ts"] }, schema: arr, workspaceRoot: ws })).toMatchObject({ allowed: true });
  });
});

describe("the workspace boundary follows the filesystem, not the spelling of the path", () => {
  const write = (ws: string, path: string) => createMirandaGate().beforeToolRun({ tool: "desktop-commander_write_file", args: { path, content: "x" }, workspaceRoot: ws });

  it("blocks traversal out of the workspace", () => {
    const ws = tmp("ws");
    expect(write(ws, "../escape.txt").allowed).toBe(false);
    expect(write(ws, "src/../../escape.txt").allowed).toBe(false);
    expect(write(ws, join(ws, "..", "escape.txt")).allowed).toBe(false);
  });

  it("blocks a path that leaves the workspace through a symlinked directory", () => {
    const ws = tmp("ws"); const outside = tmp("outside");
    symlinkSync(outside, join(ws, "link"));
    expect(write(ws, "link/escaped.txt").allowed).toBe(false);
    expect(write(ws, join(ws, "link", "deep", "new.txt")).allowed).toBe(false);
  });

  it("blocks a symlinked file that points outside the workspace", () => {
    const ws = tmp("ws"); const outside = tmp("outside");
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(ws, "notes.txt"));
    expect(write(ws, "notes.txt").allowed).toBe(false);
  });

  it("allows links that stay inside, new files, and a workspace that is itself reached through a link", () => {
    const ws = tmp("ws"); const parent = tmp("parent");
    mkdirSync(join(ws, "real"));
    symlinkSync(join(ws, "real"), join(ws, "alias"));
    expect(write(ws, "alias/new.txt").allowed).toBe(true);
    expect(write(ws, "not/yet/created.txt").allowed).toBe(true);
    symlinkSync(ws, join(parent, "ws-link"));
    expect(write(join(parent, "ws-link"), "real/file.txt").allowed).toBe(true);
  });
});
