import type { Issue, PappyInput } from "../types.js";

export function runCompletenessChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  // ── required files from constraints ──────────────────────────────────────
  const requiredFiles = input.constraints?.requireFiles ?? [];
  const touched = new Set((input.filesChanged ?? []).map((f) => f.path));

  for (const requiredPath of requiredFiles) {
    if (!touched.has(requiredPath)) {
      issues.push({
        severity: "HIGH",
        code: "COMPLETENESS_MISSING_FILE",
        category: "Completeness",
        description: `Required file "${requiredPath}" was not changed or created.`,
        expected_receipt: `file_exists or diff showing changes to "${requiredPath}"`,
        evidence: "No entry for this path in filesChanged.",
        fix_hint: `Create or modify "${requiredPath}" and include it in the changeset.`,
        message: `Required file "${requiredPath}" was not present in filesChanged.`,
        suggestedFix: `Ensure "${requiredPath}" is created or modified as part of this task.`,
      });
    }
  }

  // ── task goals completeness: warn if no output and no files ──────────────
  const hasOutput = (input.outputText?.trim().length ?? 0) > 0;
  const hasFiles  = (input.filesChanged?.length ?? 0) > 0;
  const hasTools  = (input.toolEvents?.length ?? 0) > 0;

  if (!hasOutput && !hasFiles && !hasTools) {
    issues.push({
      severity: "HIGH",
      code: "COMPLETENESS_NO_OUTPUT",
      category: "Completeness",
      description: "No output, no file changes, and no tool events were produced.",
      expected_receipt: "At least one of: outputText, filesChanged, or toolEvents must be non-empty.",
      evidence: "outputText is empty, filesChanged is empty, toolEvents is empty.",
      fix_hint: "Re-run the task and capture output/artifacts.",
      message: "Run produced no output of any kind.",
    });
  }

  return issues;
}
