import type { Issue, PappyInput } from "../types.js";

export function runToolResultChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

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

  return issues;
}
