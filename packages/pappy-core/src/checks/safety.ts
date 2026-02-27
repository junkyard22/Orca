import type { Issue, PappyInput } from "../types.js";

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf/i,
  /rm\s+--recursive/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  />\s*\/dev\/[sh]d[a-z]/i,
  /format\s+[a-z]:/i,
  /diskpart/i,
  /wipe\s+/i,
  /shred\s+/i,
  /del\s+\/[sf]/i,
  /rd\s+\/s/i,
  /rmdir\s+\/s/i,
];

export function runSafetyChecks(input: PappyInput): Issue[] {
  const issues: Issue[] = [];

  if (input.constraints?.forbidDeletes) {
    for (const file of input.filesChanged ?? []) {
      if (file.changeType === "D") {
        issues.push({
          severity: "CRITICAL",
          code: "SAFETY_FORBIDDEN_DELETE",
          message: `File deletion is forbidden but "${file.path}" was deleted.`,
          evidence: `changeType: D, path: ${file.path}`,
          suggestedFix: `Restore "${file.path}" or remove the deletion from the changeset.`,
        });
      }
    }
  }

  if (input.outputText) {
    for (const pattern of DANGEROUS_PATTERNS) {
      const match = input.outputText.match(pattern);
      if (match) {
        issues.push({
          severity: "CRITICAL",
          code: "SAFETY_DANGEROUS_COMMAND",
          message: `Output contains a potentially destructive command pattern (${pattern.source}).`,
          evidence: match[0],
          suggestedFix: "Remove or replace the dangerous command with a safe alternative.",
        });
      }
    }
  }

  return issues;
}
