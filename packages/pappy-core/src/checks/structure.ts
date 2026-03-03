import type { Issue, PappyInput } from "../types.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function runStructureChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  const sections = input.constraints?.requireSections ?? [];
  if (sections.length === 0 || !input.outputText) return issues;

  for (const section of sections) {
    const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(section)}`, "im");
    if (!headingPattern.test(input.outputText)) {
      issues.push({
        severity: "MEDIUM",
        code: "STRUCTURE_MISSING_SECTION",
        category: "Completeness",
        description: `Required section heading "${section}" is absent from the output.`,
        expected_receipt: `Markdown heading matching "${section}" present in outputText.`,
        evidence: `Searched outputText for /^#{1,6}\\s+${section}/im — not found.`,
        fix_hint: `Add a markdown heading for "${section}" to the output.`,
        message: `Required section heading "${section}" was not found in outputText.`,
        suggestedFix: `Add a markdown heading for "${section}" to the output.`,
      });
    }
  }

  return issues;
}
