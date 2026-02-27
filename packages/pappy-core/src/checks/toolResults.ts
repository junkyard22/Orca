import type { Issue, PappyInput } from "../types.js";

export function runToolResultChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  for (const event of input.toolEvents ?? []) {
    if (!event.ok) {
      issues.push({
        severity: "HIGH",
        code: "TOOL_FAILURE",
        message: `Tool "${event.tool}" reported a failure.`,
        evidence: event.summary,
        suggestedFix: `Investigate and resolve the failure in "${event.tool}" before proceeding.`,
      });
    }
  }

  return issues;
}
