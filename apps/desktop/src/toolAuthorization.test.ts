import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authorizeToolCall,
  classifyTool,
  collectLocalPathArguments,
  enforceToolAuthorization,
  evaluateStrictCommand,
} from "./toolAuthorization";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxPolicy, evaluateCommandPolicy, runCommandTool } from "@yakstacks/workbench-core";

const WS = process.platform === "win32"
  ? "C:\\Users\\demo\\AppData\\Roaming\\@clawde\\desktop\\orca-demo\\workspace"
  : "/home/demo/.config/@clawde/desktop/orca-demo/workspace";
const OUTSIDE = process.platform === "win32" ? "C:\\Users\\demo\\.ssh\\id_rsa" : "/home/demo/.ssh/id_rsa";
const OUTSIDE_DIR = process.platform === "win32" ? "C:\\Users\\demo\\Documents\\a.txt" : "/home/demo/Documents/a.txt";

/**
 * Mirrors the wrapper in main.ts: authorization runs before tool.execute and a
 * refusal means execute is never reached. execute here is a spy, so no real
 * GitHub or process operation can happen in these tests.
 */
async function runGuarded(
  tool: string,
  args: Record<string, unknown>,
  opts: { approve?: boolean | undefined; strict?: boolean } = {},
) {
  const execute = vi.fn(async () => ({ ok: true, output: "executed" }));
  const requestApproval = opts.approve === undefined ? undefined : vi.fn(async () => opts.approve!);
  const refused = await enforceToolAuthorization(tool, args, { workspaceRoot: WS, strict: opts.strict, requestApproval });
  const result = refused ?? (await execute());
  return { result, execute, requestApproval };
}

// Tool calls taken from the tool list offered to the debugger worker in the
// 2026-10-08 09:44 Live AI run.
const GITHUB_WRITES: Array<[string, Record<string, unknown>]> = [
  ["github-mcp_push_files", { owner: "o", repo: "r", branch: "main", files: [{ path: "README.md", content: "x" }], message: "m" }],
  ["github-mcp_merge_pull_request", { owner: "o", repo: "r", pull_number: 1 }],
  ["github-mcp_create_or_update_file", { owner: "o", repo: "r", path: "src/x.js", content: "x", message: "m", branch: "main" }],
  ["github-mcp_create_repository", { name: "demo" }],
  ["github-mcp_fork_repository", { owner: "o", repo: "r" }],
  ["github-mcp_create_branch", { owner: "o", repo: "r", branch: "b" }],
  ["github-mcp_add_issue_comment", { owner: "o", repo: "r", issue_number: 1, body: "x" }],
  ["github-mcp_update_issue", { owner: "o", repo: "r", issue_number: 1, state: "closed" }],
  ["github-mcp_create_pull_request_review", { owner: "o", repo: "r", pull_number: 1, event: "APPROVE" }],
  ["github-mcp_update_pull_request_branch", { owner: "o", repo: "r", pull_number: 1 }],
  ["github_clone_repo", { repo: "o/r" }],
];

const DC_PROCESS: Array<[string, Record<string, unknown>]> = [
  ["desktop-commander_start_process", { command: "Remove-Item C:\\Users\\demo\\Documents\\* -Recurse", timeout_ms: 1000 }],
  ["desktop-commander_interact_with_process", { pid: 1, input: "rm -rf /" }],
  ["desktop-commander_kill_process", { pid: 4 }],
  ["desktop-commander_force_terminate", { pid: 1 }],
];

describe("GitHub write bypass (regression)", () => {
  it.each(GITHUB_WRITES)("%s never executes without presenter approval", async (tool, args) => {
    const noApprover = await runGuarded(tool, args);
    expect(noApprover.execute).not.toHaveBeenCalled();
    expect(noApprover.result.ok).toBe(false);

    const declined = await runGuarded(tool, args, { approve: false });
    expect(declined.requestApproval).toHaveBeenCalledWith(tool, args);
    expect(declined.execute).not.toHaveBeenCalled();
  });

  it.each(GITHUB_WRITES)("%s is blocked outright in strict (demo) mode, even if approved", async (tool, args) => {
    const r = await runGuarded(tool, args, { approve: true, strict: true });
    expect(r.requestApproval).not.toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.result.ok).toBe(false);
  });

  it("push_files is classified as an external write (Miranda classified it as a read)", () => {
    expect(classifyTool("github-mcp_push_files")).toBe("external_write");
  });

  it("an approved call proceeds exactly once", async () => {
    const r = await runGuarded("github-mcp_create_branch", { owner: "o", repo: "r", branch: "b" }, { approve: true });
    expect(r.execute).toHaveBeenCalledTimes(1);
  });

  it("read-only GitHub tools are allowed without approval", async () => {
    for (const tool of ["github-mcp_get_file_contents", "github-mcp_list_commits", "github-mcp_search_code", "github_list_prs"]) {
      const r = await runGuarded(tool, { owner: "o", repo: "r" }, { approve: false });
      expect(r.requestApproval).not.toHaveBeenCalled();
      expect(r.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("a clone cannot target a folder outside the workspace", () => {
    expect(authorizeToolCall("github_clone_repo", { repo: "o/r", dest: "../../elsewhere" }, { workspaceRoot: WS }).decision).toBe("deny");
  });
});

describe("Desktop Commander bypass (regression)", () => {
  it.each(DC_PROCESS)("%s never executes without presenter approval", async (tool, args) => {
    const r = await runGuarded(tool, args, { approve: false });
    expect(r.requestApproval).toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
  });

  it.each(DC_PROCESS)("%s is blocked outright in strict (demo) mode", async (tool, args) => {
    const r = await runGuarded(tool, args, { approve: true, strict: true });
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("set_config_value is always denied, even with approval", async () => {
    const r = await runGuarded("desktop-commander_set_config_value", { key: "allowedDirectories", value: [] }, { approve: true });
    expect(r.requestApproval).not.toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("read_multiple_files cannot read outside the workspace via the `paths` array", async () => {
    const r = await runGuarded("desktop-commander_read_multiple_files", { paths: [`${WS}/src/a.js`, OUTSIDE] }, { approve: true });
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.result.error).toMatch(/outside the workspace/);
  });

  it("move_file checks the source as well as the destination", async () => {
    const r = await runGuarded("desktop-commander_move_file", { source: OUTSIDE_DIR, destination: `${WS}/a.txt` }, { approve: true });
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("workspace-confined Desktop Commander edits are allowed", async () => {
    const r = await runGuarded("desktop-commander_edit_block", { file_path: `${WS}/src/bookings.js`, old_string: "<=", new_string: "<" });
    expect(r.execute).toHaveBeenCalledTimes(1);
  });

  it("unrecognised Desktop Commander tools default to approval, not execution", async () => {
    const r = await runGuarded("desktop-commander_some_future_tool", {}, { approve: false });
    expect(r.execute).not.toHaveBeenCalled();
  });
});

describe("workspace boundary for core tools", () => {
  it("allows workspace reads/writes and denies escapes", () => {
    expect(authorizeToolCall("write_file", { path: "src/bookings.js", content: "x" }, { workspaceRoot: WS }).decision).toBe("allow");
    expect(authorizeToolCall("write_file", { path: "../../orca-settings.json", content: "x" }, { workspaceRoot: WS }).decision).toBe("deny");
    expect(authorizeToolCall("read_file", { path: OUTSIDE }, { workspaceRoot: WS }).decision).toBe("deny");
  });

  it("leaves run_command to its own command policy", () => {
    expect(authorizeToolCall("run_command", { command: "npm test" }, { workspaceRoot: WS }).capability).toBe("shell_policy");
  });

  it("unknown tools from any MCP server require approval", () => {
    expect(authorizeToolCall("acme_frobnicate", {}, { workspaceRoot: WS }).decision).toBe("approve");
    expect(authorizeToolCall("acme_frobnicate", {}, { workspaceRoot: WS, strict: true }).decision).toBe("deny");
  });

  it("collects arrays, nested objects and source/destination pairs", () => {
    expect(collectLocalPathArguments({ paths: ["a", "b"], source: "c", destination: "d", options: { cwd: "e" }, content: "not-a-path" }))
      .toEqual(["a", "b", "c", "d", "e"]);
  });
});

// ── Strict (public Demo Mode) command policy ────────────────────────────────

describe("strict mode: run_command", () => {
  const strict = (command: string, extra: Record<string, unknown> = {}) =>
    authorizeToolCall("run_command", { command, ...extra }, { workspaceRoot: WS, strict: true });

  it.each(["npm test", "npm run test", "pnpm test", "node --test", "node --test --test-name-pattern=overlap", "npm test 2>&1", "npm test | tail -20", "cat src/bookings.js", "git diff", "ls test"])(
    "permits %s (tests or read-only inspection inside the workspace)", (command) => {
      expect(strict(command).decision).toBe("allow");
    });

  it.each([
    ["git push origin main", /not a test or read-only/],
    ["npx some-package", /not a test or read-only/],
    ["npm install left-pad", /not a test or read-only/],
    ["curl https://example.com", /not a test or read-only/],
    ["node -e \"require('fs').rmSync('/', {recursive:true})\"", /not a test or read-only/],
    ["node --require ./x.js --test", /not a test or read-only/],
    ["npm test && rm -rf src", /not a test or read-only/],
    ["npm test > out.txt", /redirection/],
    ["cat $HOME/.ssh/id_rsa", /variable expansion/],
    ["cat %USERPROFILE%\.ssh\id_rsa", /variable expansion/],
    ["cat ~/.ssh/id_rsa", /outside the workspace/],
    ["cat ../../orca-settings.json", /outside the workspace/],
    [`cat ${OUTSIDE}`, /outside the workspace/],
    ["npm test & calc", /background/],
  ])("refuses %s", (command, reason) => {
    const r = strict(command);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(reason);
  });

  it("refuses a working directory outside the workspace, in every mode", () => {
    expect(strict("npm test", { cwd: "../.." }).decision).toBe("deny");
    expect(authorizeToolCall("run_command", { command: "npm test", cwd: OUTSIDE_DIR }, { workspaceRoot: WS }).decision).toBe("deny");
  });

  it("a relative cwd inside the workspace is resolved against the workspace", () => {
    expect(evaluateStrictCommand("cat bookings.js", "src", WS).ok).toBe(true);
    expect(evaluateStrictCommand("cat ../../../x", "src", WS).ok).toBe(false);
  });

  it("test commands still require presenter approval from run_command's own policy", () => {
    // Strict mode narrows what may run; it does not auto-approve test execution.
    expect(evaluateCommandPolicy("npm test", createSandboxPolicy()).requiresApproval).toBe(true);
    expect(evaluateCommandPolicy("node --test", createSandboxPolicy()).requiresApproval).toBe(true);
    expect(evaluateCommandPolicy("cat src/bookings.js", createSandboxPolicy()).requiresApproval).toBe(false);
  });
});

describe("strict mode: everything else", () => {
  const strictDecision = (tool: string, args: Record<string, unknown> = {}) =>
    authorizeToolCall(tool, args, { workspaceRoot: WS, strict: true }).decision;

  it("denies every GitHub write, Desktop Commander process tool, and unknown tool outright", () => {
    for (const [tool, args] of [...GITHUB_WRITES, ...DC_PROCESS]) expect(strictDecision(tool, args)).toBe("deny");
    for (const tool of ["acme_frobnicate", "desktop-commander_some_future_tool", "linear_do_thing"]) expect(strictDecision(tool)).toBe("deny");
    expect(strictDecision("desktop-commander_set_config_value", { key: "allowedDirectories", value: [] })).toBe("deny");
  });

  it("keeps workspace file work and read-only lookups available", () => {
    expect(strictDecision("write_file", { path: "src/bookings.js", content: "x" })).toBe("allow");
    expect(strictDecision("desktop-commander_edit_block", { file_path: `${WS}/src/bookings.js` })).toBe("allow");
    expect(strictDecision("github-mcp_get_file_contents", { owner: "o", repo: "r", path: "README.md" })).toBe("allow");
  });
});

describe("strict mode end to end: a real test run in the demo workspace", () => {
  const FIX = join(__dirname, "..", "..", "..", "packages", "pappy-core", "src", "checks", "__fixtures__", "find-fix");
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "orca-strict-"));
    mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "room-booking", type: "module", scripts: { test: "node --test" } }));
    writeFileSync(join(root, "src", "bookings.js"), readFileSync(join(FIX, "bookings.fixed.txt"), "utf8"));
    writeFileSync(join(root, "test", "bookings.test.js"), readFileSync(join(FIX, "bookings.test.base.txt"), "utf8"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function guardedRun(command: string, approve: boolean) {
    const approvals: string[] = [];
    const requestApproval = async (tool: string, args: Record<string, unknown>) => { approvals.push(String(args["command"])); return approve; };
    const refused = await enforceToolAuthorization("run_command", { command }, { workspaceRoot: root, strict: true, requestApproval });
    if (refused) return { result: refused, approvals };
    const result = await runCommandTool.execute({ command }, { workspaceRoot: root, runId: "t", requestApproval: (t: string, a: Record<string, unknown>) => requestApproval(t, a) });
    return { result, approvals };
  }

  it("runs npm test after presenter approval", async () => {
    const { result, approvals } = await guardedRun("npm test", true);
    expect(approvals).toEqual(["npm test"]);
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/# pass 8/);
  }, 60_000);

  it("does not run npm test when the presenter declines", async () => {
    const { result } = await guardedRun("npm test", false);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-test command before asking anyone", async () => {
    const { result, approvals } = await guardedRun("git push origin main", true);
    expect(result.ok).toBe(false);
    expect(approvals).toEqual([]);
  });
});
