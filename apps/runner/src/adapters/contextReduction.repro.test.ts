/**
 * Reproduction fixture — the incident that started this milestone.
 *
 * A documentation-audit request against a Node app caused a single specialist
 * call's tool catalog to balloon to hundreds of thousands of estimated
 * credits, because every role received the full tool catalog: 5 core tools +
 * ext-github/ext-docs/ext-web (9 tools) + every enabled MCP server's full
 * tool set (Desktop Commander + GitHub MCP), unfiltered, on every call.
 *
 * This test builds that "before" catalog using the REAL ToolRegistry
 * formatting function (packages/workbench-core/src/tools/registry.ts) so the
 * character counts are authentic, not hand-estimated. The Desktop
 * Commander / GitHub MCP tool lists below are a representative mock — these
 * servers are dynamic (stdio-connected at runtime) and are not invoked in
 * tests, so the exact live tool count may differ. The point demonstrated
 * here is architectural (role-scoped filtering measurably shrinks the
 * payload), not a specific target percentage — no percentage is hardcoded
 * or asserted; the test reports the real measured numbers.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "@yakstacks/workbench-core";
import type { Tool } from "@yakstacks/workbench-core";
import { createFilteredToolService } from "@clawde/orca-core";
import { getRolePrompt } from "maestro-core";
import { resolveRoleToolNames, type OrcaSettings } from "./maestroAdapter.js";
import type { OrcaTaskSpec } from "@clawde/orca-core";

function stubTool(name: string, description: string, params: Record<string, string> = {}): Tool {
  return {
    name,
    description,
    schema: {
      type: "object",
      required: Object.keys(params),
      properties: Object.fromEntries(
        Object.entries(params).map(([k, desc]) => [k, { type: "string" as const, description: desc }]),
      ),
    },
    execute: async () => ({ ok: true, output: "" }),
  };
}

// ── Core + static-extension tools (real names, this codebase ships today) ──
const CORE_AND_STATIC_TOOLS: Tool[] = [
  stubTool("read_file", "Read a file's contents.", { path: "File path" }),
  stubTool("write_file", "Write content to a file.", { path: "File path", content: "File content" }),
  stubTool("run_command", "Run a shell command.", { command: "Command to run" }),
  stubTool("list_directory", "List a directory's contents.", { path: "Directory path" }),
  stubTool("search_files", "Search files by content or name.", { pattern: "Search pattern" }),
  stubTool("github_list_prs", "List pull requests for a repo.", { repo: "owner/repo" }),
  stubTool("github_get_pr", "Get a single pull request.", { repo: "owner/repo", number: "PR number" }),
  stubTool("github_list_issues", "List issues for a repo.", { repo: "owner/repo" }),
  stubTool("github_list_repos", "List repos for a user/org.", { owner: "Owner name" }),
  stubTool("github_clone_repo", "Clone a repo into the workspace.", { repo: "owner/repo" }),
  stubTool("docs_read", "Read a documentation page.", { path: "Doc path" }),
  stubTool("docs_list", "List available documentation pages.", {}),
  stubTool("web_fetch", "Fetch a URL's content.", { url: "URL to fetch" }),
  stubTool("web_search", "Search the web.", { query: "Search query" }),
];

// ── Representative MCP tool catalogs (mocked — not live-introspected) ──────
const DESKTOP_COMMANDER_TOOLS: Tool[] = [
  "read_file", "write_file", "edit_block", "list_directory", "search_code", "search_files",
  "get_file_info", "move_file", "create_directory",
  "execute_command", "read_output", "force_terminate", "list_sessions", "list_processes",
  "kill_process", "start_process", "interact_with_process",
].map((n) => stubTool(`desktop-commander_${n}`, `Desktop Commander: ${n.replace(/_/g, " ")}.`, { arg: "argument" }));

const GITHUB_MCP_TOOLS: Tool[] = [
  "get_pull_request", "list_pull_requests", "get_issue", "list_issues", "search_repositories",
  "search_code", "get_file_contents", "list_commits", "get_commit",
  "create_pull_request", "merge_pull_request", "create_issue", "update_issue", "create_branch",
  "push_files", "delete_file", "create_or_update_file",
].map((n) => stubTool(`github-mcp_${n}`, `GitHub MCP: ${n.replace(/_/g, " ")}.`, { arg: "argument" }));

const ALL_TOOLS: Tool[] = [...CORE_AND_STATIC_TOOLS, ...DESKTOP_COMMANDER_TOOLS, ...GITHUB_MCP_TOOLS];

function buildRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

describe("reproduction: documentation-audit context reduction", () => {
  it("role-scoped + read-only-task filtering measurably shrinks the narrator's tool payload", () => {
    // ── BEFORE — today's runner/CLI production behavior for any role: the
    // full catalog (core + static ext + every enabled MCP server), unfiltered.
    const fullRegistry = buildRegistry(ALL_TOOLS);
    const beforeCatalog = fullRegistry.formatForPrompt();
    const beforeToolCount = ALL_TOOLS.length;
    const beforeChars = beforeCatalog.length;

    // ── AFTER — narrator role, read-only documentation-audit task.
    const allToolNames = ALL_TOOLS.map((t) => t.name);
    const settings: OrcaSettings = { roles: { narrator: { provider: "test", model: "test", label: "narrator" } } };
    const auditTask: OrcaTaskSpec = {
      originalUserMessage: "Assess whether the README covers production deployment and rollback.",
      intent: "answer",
      goals: ["Assess deployment documentation coverage"],
      permissions: { fileRead: true, fileWrite: false, shellExec: false },
    };

    const allowedToolNames = resolveRoleToolNames("narrator", settings, allToolNames, auditTask);
    const rawToolService = {
      execute: async () => ({ ok: true, output: "" }),
      formatForPrompt: () => beforeCatalog,
    };
    const filteredToolService = createFilteredToolService(rawToolService, allowedToolNames);
    const afterCatalog = filteredToolService.formatForPrompt();
    const afterToolCount = allowedToolNames.length;
    const afterChars = afterCatalog.length;

    const toolCountReduction = 1 - afterToolCount / beforeToolCount;
    const charReduction = 1 - afterChars / beforeChars;

    // Report the real measured numbers (no hardcoded target percentage).
    console.log(
      "[context-reduction repro]\n" +
        `  before: tools=${beforeToolCount}  chars=${beforeChars}\n` +
        `  after:  tools=${afterToolCount}  chars=${afterChars}\n` +
        `  reduction: tools=${(toolCountReduction * 100).toFixed(1)}%  chars=${(charReduction * 100).toFixed(1)}%`,
    );

    // Narrator has no github-read/github-write capability at all, so no
    // GitHub MCP tool survives regardless of read/write classification —
    // this is the exact incident scenario (a docs specialist should never
    // see the GitHub MCP catalog).
    expect(allowedToolNames.some((n) => n.startsWith("github-mcp_"))).toBe(false);
    // Narrator DOES have filesystem-read, so Desktop Commander's read-only
    // tools legitimately survive (semantic parity with the core read_file
    // tool — capability groups classify by what a tool DOES, not by which
    // server it came from) — but every write/shell-classified Desktop
    // Commander tool is excluded, same as the core write_file/run_command.
    expect(allowedToolNames).not.toContain("write_file");
    expect(allowedToolNames).not.toContain("run_command");
    expect(allowedToolNames).not.toContain("desktop-commander_write_file");
    expect(allowedToolNames).not.toContain("desktop-commander_execute_command");
    expect(allowedToolNames).not.toContain("desktop-commander_kill_process");
    expect(allowedToolNames).toContain("read_file");
    expect(allowedToolNames).toContain("docs_read");

    expect(afterToolCount).toBeLessThan(beforeToolCount);
    expect(afterChars).toBeLessThan(beforeChars);
  });

  it("a write-intent documentation task still gets filesystem-write, but no MCP write catalog", () => {
    const allToolNames = ALL_TOOLS.map((t) => t.name);
    const settings: OrcaSettings = { roles: { narrator: { provider: "test", model: "test", label: "narrator" } } };
    const updateTask: OrcaTaskSpec = {
      originalUserMessage: "Update README.md with the missing deployment instructions.",
      intent: "answer",
      goals: ["Update README.md"],
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    };

    const allowedToolNames = resolveRoleToolNames("narrator", settings, allToolNames, updateTask);

    expect(allowedToolNames).toContain("write_file");
    expect(allowedToolNames.some((n) => n.startsWith("github-mcp_"))).toBe(false);
    expect(allowedToolNames).not.toContain("run_command");
    expect(allowedToolNames.length).toBeLessThan(ALL_TOOLS.length);
  });

  it("Dynamic Tool Prompt Hygiene companion: the final system prompt for the same task no longer advertises filtered-out tools", () => {
    // Same documentation-audit scenario as above — this test measures the
    // ROLE PROMPT itself (packages/maestro-core/src/prompts/rolePrompts.ts),
    // not just the tool catalog, since that's what this milestone targets:
    // TOOL_USAGE_REMINDER previously hardcoded all 5 core tool names into
    // every role's prompt regardless of actual filtered availability.
    const allToolNames = ALL_TOOLS.map((t) => t.name);
    const settings: OrcaSettings = { roles: { narrator: { provider: "test", model: "test", label: "narrator" } } };
    const auditTask: OrcaTaskSpec = {
      originalUserMessage: "Assess whether the README covers production deployment and rollback.",
      intent: "answer",
      goals: ["Assess deployment documentation coverage"],
      permissions: { fileRead: true, fileWrite: false, shellExec: false },
    };
    const allowedToolNames = resolveRoleToolNames("narrator", settings, allToolNames, auditTask);

    // "Before": the legacy call shape (role name only) — every role prompt
    // unconditionally claimed all 5 core tools were available.
    const beforePrompt = getRolePrompt("narrator");
    // "After": the actual resolved allowlist for this invocation.
    const afterPrompt = getRolePrompt("narrator", allowedToolNames);

    console.log(
      "[prompt-hygiene repro]\n" +
        `  before: systemPromptChars=${beforePrompt.length}\n` +
        `  after:  systemPromptChars=${afterPrompt.length}\n` +
        `  reduction: ${((1 - afterPrompt.length / beforePrompt.length) * 100).toFixed(1)}%`,
    );

    // The old blanket claim must be gone.
    expect(beforePrompt).toContain("You have access to tools (read_file, write_file, run_command");
    expect(afterPrompt).not.toContain("You have access to tools (read_file, write_file, run_command");
    // No stale mutation/shell tool reference — write_file/run_command were
    // filtered out for this read-only narrator task.
    expect(afterPrompt).not.toContain("write_file");
    expect(afterPrompt).not.toContain("run_command");
    // No duplicated tool schema/name list in the role prompt itself — the
    // dynamic reminder points at the catalog instead of re-naming tools.
    expect(afterPrompt).toContain("Use the available tools listed in this prompt");
    expect(afterPrompt.length).toBeLessThanOrEqual(beforePrompt.length);
  });
});
