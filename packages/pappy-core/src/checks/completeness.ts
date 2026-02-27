import type { Issue, PappyInput } from "../types.js";

export function runCompletenessChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  const required = input.constraints?.requireFiles ?? [];
  if (required.length === 0) return issues;

  const touched = new Set((input.filesChanged ?? []).map((f) => f.path));

  for (const requiredPath of required) {
    if (!touched.has(requiredPath)) {
      issues.push({
        severity: "HIGH",
        code: "COMPLETENESS_MISSING_FILE",
        message: `Required file "${requiredPath}" was not present in filesChanged.`,
        evidence: `Expected path: ${requiredPath}`,
        suggestedFix: `Ensure "${requiredPath}" is created or modified as part of this task.`,
      });
    }
  }

  return issues;
}
