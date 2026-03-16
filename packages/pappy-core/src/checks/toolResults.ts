import type { Issue, PappyInput } from "../types.js";

/**
 * Detect if a task implies the use of specific tools.
 *
 * Each entry carries:
 *  - tool: the exact Workbench tool name expected
 *  - reason: human-readable rationale
 *  - satisfiedByFilesChanged: when true, a non-empty filesChanged list is
 *    accepted as equivalent proof (e.g. a write_file call whose event was
 *    not captured but clearly produced output).
 *
 * Patterns are intentionally narrow to avoid flagging on common English words
 * like "get", "test", "run", or "build" that appear in almost every task.
 */
function detectExpectedTools(
  task: string,
): Array<{ tool: string; reason: string; satisfiedByFilesChanged?: boolean }> {
  const expected: Array<{ tool: string; reason: string; satisfiedByFilesChanged?: boolean }> = [];
  const lower = task.toLowerCase();

  // File read — only narrow phrases that unambiguously mean "open a file"
  if (
    /\bread (the |a |this |that )?(file|contents?|source code)|load (the |a )?(file|config|json|yaml|csv)|parse (the )?(json|yaml|xml|csv) (file|from)/.test(
      lower,
    )
  ) {
    expected.push({ tool: "read_file", reason: "Task involves reading file contents" });
  }

  // File write — require unambiguously file-centric phrasing.
  // "write a function" / "implement a class" / "create a method" must NOT match.
  // We look for: explicit file noun OR save/persist/generate phrasing with a file target.
  if (
    /\b(write|save|output)\b.{0,30}\b(file|files|module|script|config|json|yaml|csv|log)\b/.test(lower) ||
    /\bcreate (a |the |an )?(new )?(file|module|script|config)\b/.test(lower) ||
    /\b(save|persist|write) (to|into) (a |the |disk|file)/.test(lower) ||
    /\bgenerate (a |the |an )?(file|report|output file)\b/.test(lower)
  ) {
    expected.push({
      tool: "write_file",
      reason: "Task involves writing/creating files",
      satisfiedByFilesChanged: true, // filesChanged populated = write tool ran
    });
  }

  // Command execution — only explicit package-manager / build-tool invocations
  if (/\b(npm|pnpm|yarn|pip3?|cargo|make|gradle|mvn)\b|\bcompile and run\b|\brun the tests?\b|\bexecute the script\b/.test(lower)) {
    expected.push({ tool: "run_command", reason: "Task involves running commands" });
  }

  // Directory listing — specific phrases only
  if (/\blist (all |the )?(files?|directories|folders?)|\bdirectory structure\b|\bwhat files? (are|exist) in\b/.test(lower)) {
    expected.push({ tool: "list_directory", reason: "Task involves exploring directories" });
  }

  // Search — specific phrases that can't be confused with ordinary English
  if (/\b(grep|ripgrep)\b|\bsearch (for|through) (files?|the (repo|codebase|source))|\bfind all (occurrences?|references?|usages?)\b/.test(lower)) {
    expected.push({ tool: "search_files", reason: "Task involves searching files" });
  }

  return expected;
}

export function runToolResultChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  // ── Existing check: tool failures ─────────────────────────────────────────
  for (const event of input.toolEvents ?? []) {
    if (!event.ok) {
      // Permission-denied responses are intentional gates, not execution errors.
      // The model received a clear "not permitted" message and adapted — this is
      // correct behaviour, not a failure worth flagging.
      const isPermissionDenied = event.summary?.includes("is not permitted");

      // Navigation errors (EISDIR = tried to read a directory, ENOENT = file not found)
      // are model path-exploration mistakes. The model gets an error message and
      // recovers on the next call — no systemic failure, don't flag HIGH.
      const isNavigationError =
        event.summary?.includes("EISDIR") ||
        event.summary?.includes("ENOENT") ||
        event.summary?.includes("no such file or directory");

      if (isPermissionDenied || isNavigationError) continue;

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
  const hasFilesChanged = (input.filesChanged?.length ?? 0) > 0;

  for (const expected of expectedTools) {
    const toolWasCalled = actualTools.has(expected.tool);
    const satisfiedByFiles = expected.satisfiedByFilesChanged === true && hasFilesChanged;

    if (!toolWasCalled && !satisfiedByFiles) {
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
  // MEDIUM only — this is a heuristic and has known false positives.
  // Excludes "write", "create", and noun-form "test" to avoid matching
  // code-gen phrases like "write a function" or "a test file".
  // "test" is only matched as a verb (run/execute tests), not as a noun.
  const hasToolUsePatterns = (
    /\b(read|run|execute|save|list|search|find|build)\b/i.test(input.task) ||
    /\b(run|execute)\s+(the\s+)?(tests?|specs?|suite)\b/i.test(input.task)
  );
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
