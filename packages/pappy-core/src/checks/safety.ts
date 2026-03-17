import type { Issue, PappyInput } from "../types.js";

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf/i,
  /rm\s+--recursive/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  />\s*\/dev\/[sh]d[a-z]/i,
  /format\s+[a-z]:/i,
  /diskpart/i,
  // "wipe" only flags disk/drive/partition targets — not prose like "wipe the counter"
  /\bwipe\s+(--?[\w-]+|[\/~]|disk\b|drive\b|partition\b|\/dev\/)/i,
  // "shred" only flags when followed by a flag (-u, --remove) or path — not "shred into bite-sized pieces"
  /\bshred\s+(--?[\w-]+|[\/~]|\.\/)/i,
  /del\s+\/[sf]/i,
  /rd\s+\/s/i,
  /rmdir\s+\/s/i,
];

export function runSafetyChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  if (input.constraints?.forbidDeletes) {
    for (const file of input.filesChanged ?? []) {
      if (file.changeType === "D") {
        issues.push({
          severity: "CRITICAL",
          code: "SAFETY_FORBIDDEN_DELETE",
          category: "Safety",
          description: `File deletion is forbidden by constraints but "${file.path}" was deleted.`,
          expected_receipt: "No deletion entries in filesChanged.",
          evidence: `changeType=D path=${file.path}`,
          fix_hint: `Restore "${file.path}" or remove the deletion from the changeset.`,
          message: `File deletion is forbidden but "${file.path}" was deleted.`,
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
          category: "Safety",
          description: `Output contains a potentially destructive command pattern: ${match[0]}`,
          expected_receipt: "No destructive command patterns in output. If required, explicit user-approval gate must exist.",
          evidence: `Matched: "${match[0]}" (pattern: ${pattern.source})`,
          fix_hint: "Remove or replace the dangerous command. If intentional, add an explicit user-confirmation gate and note it in the output.",
          message: `Output contains a potentially destructive command pattern (${pattern.source}).`,
          suggestedFix: "Remove or replace the dangerous command with a safe alternative.",
        });
      }
    }
  }

  return issues;
}
