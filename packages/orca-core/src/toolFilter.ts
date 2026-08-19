import type { OrcaToolService } from "./types.js";

/**
 * Matches a `**tool_name**` marker in a formatted tool-catalog prompt block
 * (see packages/workbench-core/src/tools/registry.ts's formatForPrompt()).
 * Tool names include hyphens for MCP-namespaced tools (e.g.
 * "desktop-commander_execute_command", "github-mcp_create_pull_request" —
 * see ARCHITECTURE.md's documented `${serverId}_` prefix convention), so the
 * character class must include `-`, not just `\w` (word characters alone
 * silently fail to match any hyphenated name, which would leave every
 * disallowed MCP tool's schema unstripped from the prompt).
 */
const TOOL_NAME_MARKER_RE = /\*\*([\w-]+)\*\*/g;

/**
 * Wrap an OrcaToolService so only tools in `allowed` are executable, and so
 * the prompt-facing tool catalog (`formatForPrompt()`) never mentions a
 * disallowed tool. Blocked calls fail with a descriptive error instead of
 * reaching the underlying tool — the model finds out the tool isn't
 * available without the caller having to pre-validate tool names.
 *
 * Shared by task-level filtering (packages/orca-core/src/runtime.ts, driven
 * by taskSpec.permissions.toolsAllowed) and role-level filtering
 * (apps/runner/src/adapters/maestroAdapter.ts, driven by capability-group
 * resolution) so both layers compose through the same, single implementation
 * instead of duplicating the regex-based prompt stripping.
 *
 * This wrapper is an authorization filter, not a new tool-execution entry
 * point: it does not call Miranda's beforeToolRun gate itself, because the
 * only caller that invokes execute() on the OrcaToolService it wraps is
 * packages/agent-loop-core/src/loop.ts, which already calls
 * ctx.gate?.beforeToolRun(...) immediately before every tools.execute(...)
 * call. Adding a second beforeToolRun call here would gate the same
 * execution twice rather than adding coverage.
 */
export function createFilteredToolService(
  tools: OrcaToolService,
  allowed: string[],
): OrcaToolService {
  return {
    execute(name: string, input: Record<string, unknown>) {
      if (!allowed.includes(name)) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `Tool "${name}" is not permitted for this request. Allowed: ${allowed.join(", ")}. Output the result in your response instead.`,
        });
      }
      return tools.execute(name, input);
    },

    formatForPrompt() {
      const full = tools.formatForPrompt();
      const allToolNames = [...full.matchAll(TOOL_NAME_MARKER_RE)].map(
        (match) => match[1] as string,
      );
      let filtered = full;
      for (const toolName of allToolNames) {
        if (!allowed.includes(toolName)) {
          filtered = filtered.replace(
            new RegExp(`\\*\\*${toolName}\\*\\*[^\\n]*(?:\\n  -[^\\n]*)*\\n?`, "g"),
            "",
          );
        }
      }
      return filtered;
    },
  };
}

/**
 * Extract the tool names currently mentioned in a formatted prompt block
 * (the same `**tool_name**` markers createFilteredToolService strips on).
 * Used for telemetry (counting tools actually exposed) without requiring
 * OrcaToolService to expose a separate listToolNames() method.
 */
export function extractToolNamesFromPrompt(formatted: string): string[] {
  return [...formatted.matchAll(TOOL_NAME_MARKER_RE)].map((match) => match[1] as string);
}
