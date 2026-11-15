/**
 * Workspace authority (stage 2): a filesystem tool runs only in a workspace
 * that was explicitly established and really is a usable folder. Nothing is
 * substituted for a missing one. Real temporary directories throughout; the
 * filesystem root is only ever assessed (one stat), never used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  assessWorkspaceRoot,
  composeMirandaGates,
  createMirandaGate,
  createWorkspaceAuthorityGate,
  toolMayModifyFilesystem,
  WORKSPACE_REQUIRED_CODE,
  WORKSPACE_REQUIRED_PREFIX,
} from "./mirandaGate.js";

const dirs: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "orca-authority-"))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fsRoot = parse(tmpdir()).root;

describe("assessWorkspaceRoot", () => {
  it("accepts an existing folder and nothing else", () => {
    const ws = tmp();
    writeFileSync(join(ws, "file.txt"), "x");
    expect(assessWorkspaceRoot(ws)).toMatchObject({ status: "ok", root: ws });
    expect(assessWorkspaceRoot(undefined).status).toBe("not_configured");
    expect(assessWorkspaceRoot("").status).toBe("not_configured");
    expect(assessWorkspaceRoot("   ").status).toBe("not_configured");
    expect(assessWorkspaceRoot(join(ws, "not-created")).status).toBe("missing");
    expect(assessWorkspaceRoot(join(ws, "file.txt")).status).toBe("not_a_directory");
    expect(assessWorkspaceRoot(fsRoot).status).toBe("filesystem_root");
  });

  it("explains what establishes a workspace", () => {
    expect(assessWorkspaceRoot(undefined).message).toMatch(/no workspace is configured.*Settings.*WORKSPACE_ROOT/s);
    expect(assessWorkspaceRoot("/definitely/not/here").message).toContain("/definitely/not/here");
  });
});

describe("the workspace authority gate", () => {
  const gate = createWorkspaceAuthorityGate();
  const fsCalls: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "a.txt" }],
    ["write_file", { path: "a.txt", content: "x" }],
    ["list_directory", { path: "." }],
    ["run_command", { command: "ls" }],
    ["desktop-commander_write_file", { path: "a.txt", content: "x" }],
    ["desktop-commander_read_multiple_files", { paths: ["a.txt"] }],
    ["desktop-commander_start_process", { command: "ls" }],
  ];

  it.each([
    ["no workspace", undefined],
    ["an empty workspace setting", ""],
    ["a workspace that does not exist", "/definitely/not/here"],
    ["the filesystem root", fsRoot],
  ])("refuses every filesystem tool with %s, with a structured reason", (_name, workspaceRoot) => {
    for (const [tool, args] of fsCalls) {
      const result = gate.beforeToolRun({ tool, args, workspaceRoot });
      expect(result, tool).toMatchObject({ allowed: false, verdict: "BLOCK", code: WORKSPACE_REQUIRED_CODE });
      expect(result.reason.startsWith(WORKSPACE_REQUIRED_PREFIX)).toBe(true);
      expect(result.reason).toMatch(/Settings/);
    }
  });

  it("refuses a file given as the workspace", () => {
    const ws = tmp();
    writeFileSync(join(ws, "file.txt"), "x");
    expect(gate.beforeToolRun({ tool: "read_file", args: { path: "a" }, workspaceRoot: join(ws, "file.txt") })).toMatchObject({ allowed: false, code: WORKSPACE_REQUIRED_CODE });
  });

  it("allows filesystem tools in an established workspace", () => {
    const ws = tmp();
    for (const [tool, args] of fsCalls) expect(gate.beforeToolRun({ tool, args, workspaceRoot: ws }).allowed, tool).toBe(true);
  });

  it("does not require a workspace for tools that do not touch local files", () => {
    expect(gate.beforeToolRun({ tool: "web_fetch", args: { url: "https://example.com" } }).allowed).toBe(true);
    expect(gate.beforeToolRun({ tool: "github-mcp_list_issues", args: { owner: "o", repo: "r", labels: ["bug"] } }).allowed).toBe(true);
    expect(gate.beforeToolRun({ tool: "github-mcp_get_file_contents", args: { owner: "o", repo: "r", path: "README.md" } }).allowed).toBe(true);
  });

  it("refuses any call that names an absolute local path when no workspace is established", () => {
    expect(gate.beforeToolRun({ tool: "srv_export", args: { destination: join(tmpdir(), "out.txt") } })).toMatchObject({ allowed: false, code: WORKSPACE_REQUIRED_CODE });
    expect(gate.beforeToolRun({ tool: "srv_export", args: { options: { files: [{ path: join(tmpdir(), "out.txt") }] } } })).toMatchObject({ allowed: false });
  });

  it("is not moved by anything in the tool call's own arguments", () => {
    const ws = tmp();
    for (const key of ["workspaceRoot", "workspace", "cwd", "root"]) {
      expect(gate.beforeToolRun({ tool: "write_file", args: { path: "a.txt", content: "x", [key]: ws } }), key).toMatchObject({ allowed: false, code: WORKSPACE_REQUIRED_CODE });
    }
  });

  it("adds a refusal and no permission when composed with a host gate", () => {
    const ws = tmp();
    const readOnly = createMirandaGate({ taskPermissions: { fileRead: true, fileWrite: false, shellExec: false, networkAccess: false } });
    const composed = composeMirandaGates(createWorkspaceAuthorityGate(), readOnly)!;
    expect(composed.beforeToolRun({ tool: "write_file", args: { path: "a.txt", content: "x" } })).toMatchObject({ allowed: false, code: WORKSPACE_REQUIRED_CODE });
    expect(composed.beforeToolRun({ tool: "write_file", args: { path: "a.txt", content: "x" }, workspaceRoot: ws })).toMatchObject({ allowed: false, reason: expect.stringMatching(/File writes are not permitted/) });
    expect(composed.beforeToolRun({ tool: "read_file", args: { path: "a.txt" }, workspaceRoot: ws }).allowed).toBe(true);
    // The other checkpoints are the host gate's alone.
    expect(composed.beforeQC({ taskId: "t", outputText: "" }).allowed).toBe(false);
    expect(createWorkspaceAuthorityGate().beforeQC({ taskId: "t", outputText: "" }).allowed).toBe(true);
  });
});

describe("toolMayModifyFilesystem", () => {
  it("separates tools that can change files from those that cannot", () => {
    for (const tool of ["write_file", "run_command", "desktop-commander_edit_block", "desktop-commander_start_process", "srv_apply_patch", "sequentialthinking"]) expect(toolMayModifyFilesystem(tool), tool).toBe(true);
    for (const tool of ["read_file", "list_directory", "web_fetch", "github-mcp_get_file_contents", "desktop-commander_read_multiple_files"]) expect(toolMayModifyFilesystem(tool), tool).toBe(false);
  });
});
