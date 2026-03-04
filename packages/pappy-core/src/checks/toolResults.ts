import type { Issue, PappyInput } from "../types.js";

/**
 * Detect if a task implies the use of specific tools.
 * Returns an array of { tool, reason } pairs that should be present.
 */
function detectExpectedTools(task: string): Array<{ tool: string; reason: string }> {
  const expected: Array<{ tool: string; reason: string }> = [];
  const lower = task.toLowerCase();

  // File read/write tasks
  if (/\b(read (file|contents)|load|parse (json|yaml|xml)|read from)\b/.test(lower)) {
    expected.push({ tool: "read_file", reason: "Task involves reading file contents" });
  }
  if (/\b(write|create|save|generate|update (file|code)|add (file|code)|implement)\b/.test(lower)) {
    expected.push({ tool: "write_file", reason: "Task involves writing/creating files" });
  }

  // Command execution tasks
  if (/\b(run|execute|build|compile|test|install|npm|pnpm|yarn|pip|make|cargo)\b/.test(lower)) {
    expected.push({ tool: "run_command", reason: "Task involves running commands" });
  }

  // Directory/listing tasks
  if (/\b(list|explore|browse|find (file|dir)|what (file|files)|directory structure)\b/.test(lower)) {
    expected.push({ tool: "list_directory", reason: "Task involves exploring directories" });
  }

  // Search tasks
  if (/\b(search|find|grep|locate|look for|scan for)\b/.test(lower)) {
    expected.push({ tool: "search_files", reason: "Task involves searching files" });
  }

  return expected;
}

export function runToolResultChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  // ── Existing check: tool failures ─────────────────────────────────────────
  for (const event of input.toolEvents ?? []) {
    if (!event.ok) {
      issues.push({
        severity: "HIGH",
        code: "TOOL_FAILURE",
        category: "Tooling",
        description: `Tool "${event.tool}" reported a failure. Downstream results cannot be trusted.`,
        expected_receipt: `tool_event for "${event.tool}" with ok=true.`,
        evidence: event.summary,
        fix_hint: `Investigate and resolve the failure in "${event.tool}". Re-run and confirm ok=true in the tool event.`,
        message: `Tool "${event.tool}" reported a failure.`,
        suggestedFix: `Investigate and resolve the failure in "${event.tool}" before proceeding.`,
      });
    }
  }

  // ── 4.3 Tool event correlation — verify expected tools were called ───────
  const expectedTools = detectExpectedTools(input.task);
  const actualTools = new Set((input.toolEvents ?? []).map((e) => e.tool));

  for (const expected of expectedTools) {
    if (!actualTools.has(expected.tool)) {
      issues.push({
        severity: "MEDIUM",
        code: "TOOL_MISSING",
        category: "Tooling",
        description: `Task implies using "${expected.tool}" but no such tool was called.`,
        expected_receipt: `tool_event for "${expected.tool}" with ok=true.`,
        evidence: `Task: "${input.task}". Expected tool: ${expected.tool} (${expected.reason}). Actual tools: ${Array.from(actualTools).join(", ") || "none"}.`,
        fix_hint: `Use the ${expected.tool} tool to ${expected.reason.toLowerCase()}.`,
        message: `Expected tool "${expected.tool}" was not called.`,
        suggestedFix: `Call ${expected.tool} to ${expected.reason.toLowerCase()}.`,
      });
    }
  }

  // ── Instrumentation check: task implies tool use but no tools recorded ───
  const hasToolUsePatterns = /\b(read|write|run|execute|create|save|list|search|find|build|test)\b/i.test(input.task);
  const hasNoToolEvents = (input.toolEvents?.length ?? 0) === 0;
  const hasNoFiles = (input.filesChanged?.length ?? 0) === 0;

  if (hasToolUsePatterns && hasNoToolEvents && hasNoFiles) {
    issues.push({
      severity: "MEDIUM",
      code: "TOOL_INSTRUMENTATION_MISSING",
      category: "Tooling",
      description: "Task implies tool use but no tool events were recorded.",
      expected_receipt: "At least one tool event or file change.",
      evidence: `Task: "${input.task}". No toolEvents, no filesChanged.`,
      fix_hint: "Use appropriate tools to complete the task and capture tool events.",
      message: "Task implies tool use but produced no tool events.",
      suggestedFix: "Ensure tools are properly wired and tool events are captured.",
    });
  }

  return issues;
}
