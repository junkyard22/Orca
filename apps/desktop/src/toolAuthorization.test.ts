import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authorizeToolCall,
  classifyTool,
  collectLocalPathArguments,
  enforceToolAuthorization,
  splitServerPrefix,
} from "./toolAuthorization";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxPolicy, evaluateCommandPolicy, runCommandTool } from "@yakstacks/workbench-core";

const WS = process.platform === "win32"
  ? "C:\\Users\\demo\\Documents\\project"
  : "/home/demo/project";
const OUTSIDE = process.platform === "win32" ? "C:\\Users\\demo\\.ssh\\id_rsa" : "/home/demo/.ssh/id_rsa";
const OUTSIDE_DIR = process.platform === "win32" ? "C:\\Users\\demo\\Documents\\a.txt" : "/home/demo/Documents/a.txt";
const SERVER_IDS = ["github-mcp", "desktop-commander", "search-tools", "context7"];

/**
 * Mirrors the wrapper in main.ts: authorization runs before tool.execute and a
 * refusal means execute is never reached. execute is a spy, so no real GitHub,
 * process or shell operation can happen in these tests.
 */
async function runGuarded(
  tool: string,
  args: Record<string, unknown>,
  opts: { approve?: boolean | (() => Promise<boolean>) } = {},
) {
  const execute = vi.fn(async () => ({ ok: true, output: "executed" }));
  const requestApproval = opts.approve === undefined
    ? undefined
    : vi.fn(typeof opts.approve === "function" ? opts.approve : async () => opts.approve as boolean);
  const refused = await enforceToolAuthorization(tool, args, { workspaceRoot: WS, mcpServerIds: SERVER_IDS, requestApproval });
  const result = refused ?? (await execute());
  return { result, refused, execute, requestApproval };
}

// Tool calls taken from the tool list offered to the debugger worker in the
// 2026-10-08 09:44 Live AI run (official GitHub MCP server + ext-github).
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
  ["github-mcp_star_repository", { owner: "o", repo: "r" }],
  ["github-mcp_add_sub_issue", { owner: "o", repo: "r", issue_number: 1, sub_issue_id: 2 }],
  ["github-mcp_assign_copilot_to_issue", { owner: "o", repo: "r", issue_number: 1 }],
  ["github-mcp_run_workflow", { owner: "o", repo: "r", workflow_id: "ci.yml", ref: "main" }],
  ["github-mcp_rerun_workflow_run", { owner: "o", repo: "r", run_id: 1 }],
  ["github-mcp_dismiss_notification", { thread_id: "1" }],
  ["github-mcp_request_copilot_review", { owner: "o", repo: "r", pull_number: 1 }],
  ["github_clone_repo", { repo: "o/r" }],
];

const GITHUB_READS = [
  "github-mcp_get_file_contents", "github-mcp_list_commits", "github-mcp_search_code", "github_list_prs",
  "github-mcp_get_tag", "github-mcp_get_release_by_tag", "github-mcp_get_latest_release", "github-mcp_list_releases",
  "github-mcp_get_label", "github-mcp_list_label", "github-mcp_get_workflow_run", "github-mcp_get_issue_comments",
  "github-mcp_list_pull_requests", "github-mcp_get_me",
];

const DC_PROCESS: Array<[string, Record<string, unknown>]> = [
  ["desktop-commander_start_process", { command: "Remove-Item C:\\Users\\demo\\Documents\\* -Recurse", timeout_ms: 1000 }],
  ["desktop-commander_interact_with_process", { pid: 1, input: "rm -rf /" }],
  ["desktop-commander_kill_process", { pid: 4 }],
  ["desktop-commander_force_terminate", { pid: 1 }],
];

describe("GitHub write bypass (regression)", () => {
  it.each(GITHUB_WRITES)("%s never executes without user approval", async (tool, args) => {
    const noApprover = await runGuarded(tool, args);
    expect(noApprover.execute).not.toHaveBeenCalled();
    expect(noApprover.result.ok).toBe(false);

    const declined = await runGuarded(tool, args, { approve: false });
    expect(declined.requestApproval).toHaveBeenCalledWith(tool, args, expect.any(String));
    expect(declined.execute).not.toHaveBeenCalled();
    expect(declined.result.ok).toBe(false);
  });

  it("push_files is classified as an external write (Miranda classified it as a read)", () => {
    expect(classifyTool("github-mcp_push_files", SERVER_IDS)).toBe("external_write");
  });

  it("an approved call proceeds exactly once", async () => {
    const r = await runGuarded("github-mcp_create_branch", { owner: "o", repo: "r", branch: "b" }, { approve: true });
    expect(r.requestApproval).toHaveBeenCalledTimes(1);
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.result.ok).toBe(true);
  });

  it.each(GITHUB_READS)("%s is a read: allowed without approval", async (tool) => {
    const r = await runGuarded(tool, { owner: "o", repo: "r" }, { approve: false });
    expect(r.requestApproval).not.toHaveBeenCalled();
    expect(r.execute).toHaveBeenCalledTimes(1);
  });

  it("a clone cannot target a folder outside the workspace", () => {
    expect(authorizeToolCall("github_clone_repo", { repo: "o/r", dest: "../../elsewhere" }, { workspaceRoot: WS }).decision).toBe("deny");
  });
});

describe("Desktop Commander bypass (regression)", () => {
  it.each(DC_PROCESS)("%s never executes without user approval", async (tool, args) => {
    const r = await runGuarded(tool, args, { approve: false });
    expect(r.requestApproval).toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("set_config_value is always denied, even with approval", async () => {
    const r = await runGuarded("desktop-commander_set_config_value", { key: "allowedDirectories", value: [] }, { approve: true });
    expect(r.requestApproval).not.toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.refused?.authorization).toBe("deny");
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

  it("process reads and config reads are allowed", async () => {
    for (const tool of ["desktop-commander_list_sessions", "desktop-commander_get_config", "desktop-commander_read_process_output"]) {
      const r = await runGuarded(tool, { pid: 1 }, { approve: false });
      expect(r.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("unrecognised Desktop Commander tools default to approval, not execution", async () => {
    const r = await runGuarded("desktop-commander_some_future_tool", {}, { approve: false });
    expect(r.execute).not.toHaveBeenCalled();
  });
});

describe("other MCP servers", () => {
  it("unknown tools from any server require approval and cannot bypass authorization", async () => {
    for (const tool of ["acme_frobnicate", "sequentialthinking", "resolve-library-id", "puppeteer_navigate", "browser_click"]) {
      expect(authorizeToolCall(tool, {}, { workspaceRoot: WS }).decision).toBe("approve");
      const r = await runGuarded(tool, {});
      expect(r.execute).not.toHaveBeenCalled();
      expect(r.refused?.authorization).toBe("approval_unavailable");
    }
  });

  it("verb-named reads are allowed, verb-named writes need approval, hyphens count as boundaries", async () => {
    for (const tool of ["brave_web_search", "fetch", "query", "list_tables", "read_graph", "context7_get-library-docs"]) {
      expect(classifyTool(tool, SERVER_IDS), tool).toBe("external_read");
    }
    for (const tool of ["slack_post_message", "memory_create_entities", "execute_sql", "send_email"]) {
      expect(classifyTool(tool, SERVER_IDS), tool).toBe("external_write");
    }
  });

  it("strips a configured server id before reading verbs, so an id containing a verb cannot mislead", () => {
    expect(splitServerPrefix("search-tools_delete_index", SERVER_IDS)).toEqual({ serverId: "search-tools", operation: "delete_index" });
    expect(classifyTool("search-tools_delete_index", SERVER_IDS)).toBe("external_write");
    expect(classifyTool("search-tools_add_document", SERVER_IDS)).toBe("external_write");
    expect(classifyTool("search-tools_get_document", SERVER_IDS)).toBe("external_read");
    // Without the id the leading verb would be "search" (a read): the id list is what makes this safe.
    expect(classifyTool("search-tools_add_document", [])).toBe("external_read");
  });
});

describe("workspace boundary for core tools", () => {
  it("allows workspace reads/writes and denies escapes", () => {
    expect(authorizeToolCall("write_file", { path: "src/bookings.js", content: "x" }, { workspaceRoot: WS }).decision).toBe("allow");
    expect(authorizeToolCall("write_file", { path: "../../orca-settings.json", content: "x" }, { workspaceRoot: WS }).decision).toBe("deny");
    expect(authorizeToolCall("read_file", { path: OUTSIDE }, { workspaceRoot: WS }).decision).toBe("deny");
  });

  it("leaves run_command to its own command policy, except a working directory outside the workspace", () => {
    expect(authorizeToolCall("run_command", { command: "npm test" }, { workspaceRoot: WS }).decision).toBe("allow");
    expect(authorizeToolCall("run_command", { command: "npm test", cwd: "src" }, { workspaceRoot: WS }).decision).toBe("allow");
    expect(authorizeToolCall("run_command", { command: "npm test", cwd: OUTSIDE_DIR }, { workspaceRoot: WS }).decision).toBe("deny");
  });

  it("collects arrays, nested objects and source/destination pairs", () => {
    expect(collectLocalPathArguments({ paths: ["a", "b"], source: "c", destination: "d", options: { cwd: "e" }, content: "not-a-path" }))
      .toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not deny on non-path strings under path-like keys", () => {
    expect(authorizeToolCall("some_tool", { target: "main" }, { workspaceRoot: WS }).decision).toBe("approve");
    expect(authorizeToolCall("some_tool", { source: "https://example.com/data.json" }, { workspaceRoot: WS }).decision).toBe("approve");
  });
});

describe("denials and timeouts are failed results, never successful execution", () => {
  it("a denial is an ok:false tool result with the reason, and execute is never called", async () => {
    const r = await runGuarded("github-mcp_push_files", { owner: "o", repo: "r" }, { approve: false });
    expect(r.result).toMatchObject({ ok: false, output: "", authorization: "approval_denied" });
    expect(r.result.error).toMatch(/not approved/);
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("an approval timeout (the approver resolves false later) is a denial", async () => {
    vi.useFakeTimers();
    try {
      const timeoutApprover = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000));
      const pending = runGuarded("desktop-commander_start_process", { command: "echo hi" }, { approve: timeoutApprover });
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pending;
      expect(r.result.ok).toBe(false);
      expect(r.refused?.authorization).toBe("approval_denied");
      expect(r.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an approver that throws refuses the call instead of letting it through", async () => {
    const r = await runGuarded("github-mcp_create_issue", { owner: "o", repo: "r", title: "t" }, { approve: async () => { throw new Error("renderer gone"); } });
    expect(r.result.ok).toBe(false);
    expect(r.execute).not.toHaveBeenCalled();
  });

  it("a truthy non-boolean approval does not count", async () => {
    const r = await runGuarded("github-mcp_create_issue", { owner: "o", repo: "r", title: "t" }, { approve: (async () => "yes") as unknown as () => Promise<boolean> });
    expect(r.execute).not.toHaveBeenCalled();
  });
});

describe("end to end: a real shell command behind the same guard (normal mode)", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "orca-auth-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node -e \"console.log('ok')\"" } }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function guardedRun(command: string, approve: boolean, cwd?: string) {
    const approvals: string[] = [];
    const requestApproval = async (_tool: string, args: Record<string, unknown>) => { approvals.push(String(args["command"])); return approve; };
    const args = cwd ? { command, cwd } : { command };
    const refused = await enforceToolAuthorization("run_command", args, { workspaceRoot: root, requestApproval });
    if (refused) return { result: refused, approvals };
    const result = await runCommandTool.execute(args, { workspaceRoot: root, runId: "t", requestApproval: (t: string, a: Record<string, unknown>) => requestApproval(t, a) });
    return { result, approvals };
  }

  it("run_command keeps its own policy: npm test needs approval and runs once approved", async () => {
    expect(evaluateCommandPolicy("npm test", createSandboxPolicy()).requiresApproval).toBe(true);
    const { result, approvals } = await guardedRun("npm test", true);
    expect(approvals).toEqual(["npm test"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
  }, 60_000);

  it("does not run when the user declines", async () => {
    const { result } = await guardedRun("npm test", false);
    expect(result.ok).toBe(false);
  });

  it("a working directory outside the workspace is refused before any approval is requested", async () => {
    const { result, approvals } = await guardedRun("npm test", true, OUTSIDE_DIR);
    expect(result.ok).toBe(false);
    expect(approvals).toEqual([]);
  });

  it("a denied process-control call never creates its side effect", async () => {
    const marker = join(root, "marker.txt");
    const execute = vi.fn(async () => { writeFileSync(marker, "ran"); return { ok: true, output: "" }; });
    const refused = await enforceToolAuthorization("desktop-commander_start_process", { command: `echo x > ${marker}` }, { workspaceRoot: root, requestApproval: async () => false });
    if (!refused) await execute();
    expect(existsSync(marker)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
