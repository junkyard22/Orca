import type { PappyInput, PappyResult, Issue, Verdict } from "./types.js";
import { runSafetyChecks } from "./checks/safety.js";
import { runToolResultChecks } from "./checks/toolResults.js";
import { runCompletenessChecks } from "./checks/completeness.js";
import { runStructureChecks } from "./checks/structure.js";
import { buildRepairTask } from "./repair.js";

export function evaluateWithPappy(input: PappyInput): PappyResult {
  const issues: Issue[] = [
    ...runSafetyChecks(input),
    ...runToolResultChecks(input),
    ...runCompletenessChecks(input),
    ...runStructureChecks(input),
  ];

  const verdict = deriveVerdict(issues);
  const confidence = deriveConfidence(input, issues);
  const repairTask = verdict !== "PASS" ? buildRepairTask(input.task, issues) : undefined;
  const internalSummary = buildInternalSummary(verdict, issues);

  return { verdict, confidence, issues, repairTask, internalSummary };
}

function deriveVerdict(issues: Issue[]): Verdict {
  if (issues.some((i) => i.severity === "CRITICAL" || i.severity === "HIGH")) {
    return "FAIL";
  }
  if (issues.some((i) => i.severity === "MEDIUM")) {
    return "WARN";
  }
  return "PASS";
}

function deriveConfidence(input: PappyInput, issues: Issue[]): number {
  let score = 1.0;

  // Less confident if we had nothing concrete to evaluate
  const hasOutput = !!input.outputText;
  const hasFiles = (input.filesChanged?.length ?? 0) > 0;
  const hasTools = (input.toolEvents?.length ?? 0) > 0;
  if (!hasOutput && !hasFiles && !hasTools) score -= 0.3;

  const deductions: Record<string, number> = {
    CRITICAL: 0.4,
    HIGH: 0.2,
    MEDIUM: 0.1,
    LOW: 0.05,
  };

  for (const issue of issues) {
    score -= deductions[issue.severity] ?? 0;
  }

  return parseFloat(Math.max(0, Math.min(1, score)).toFixed(2));
}

function buildInternalSummary(verdict: Verdict, issues: Issue[]): string {
  if (issues.length === 0) return `verdict=${verdict} no_issues`;

  const counts = issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {});

  const tally = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]}x${s}`)
    .join(" ");

  return `verdict=${verdict} ${tally}`;
}
