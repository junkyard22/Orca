import type { Issue } from "./types.js";

export function buildRepairTask(task: string, issues: Issue[]): string {
  const lines: string[] = [
    `Original task: ${task}`,
    "",
    "The following issues must be resolved:",
    "",
  ];

  for (const issue of issues) {
    lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    if (issue.evidence) {
      lines.push(`  Evidence: ${issue.evidence}`);
    }
    if (issue.suggestedFix) {
      lines.push(`  Fix: ${issue.suggestedFix}`);
    }
  }

  lines.push("");
  lines.push("Return ONLY updated artifacts/output that resolve the issues.");

  return lines.join("\n");
}
