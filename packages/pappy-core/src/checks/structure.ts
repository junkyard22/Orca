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
        message: `Required section heading "${section}" was not found in outputText.`,
        evidence: `Expected heading: "${section}"`,
        suggestedFix: `Add a markdown heading for "${section}" to the output.`,
      });
    }
  }

  return issues;
}
