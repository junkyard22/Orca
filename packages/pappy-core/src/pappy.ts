/**
 * Pappy — "Receipt Checker" QC Gate
 *
 * Identity: the old man at the exit door asking for your receipt.
 * Not creative. Not helpful. Checks receipts.
 *
 * PASS  → all required receipts exist, no HIGH issues
 * WARN  → receipts present but partial gaps or instrumentation missing
 * FAIL  → any required receipt missing, HIGH/CRITICAL issue, or unsafe behavior
 */

import type {
  PappyInput,
  PappyResult,
  Issue,
  Verdict,
  AcceptanceCriterion,
  Claim,
  ReceiptEntry,
} from "./types.js";
import { runSafetyChecks }       from "./checks/safety.js";
import { runToolResultChecks }   from "./checks/toolResults.js";
import { runCompletenessChecks, runSatisfactionChecks } from "./checks/completeness.js";
import { runStructureChecks }    from "./checks/structure.js";
import { runClaimProofChecks } from "./checks/claimProof.js";
import { buildRepairTask, repairTaskToString } from "./repair.js";

// ---------------------------------------------------------------------------
// Stable issue ID — FNV-1a 32-bit, no external dependencies.
// Same defect always hashes to the same ID so Doctor/Maestro can track
// which specific issues were fixed across repair passes.
// ---------------------------------------------------------------------------

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stampIssueIds(issues: Omit<Issue, "issueId">[]): Issue[] {
  return issues.map((issue) => ({
    ...issue,
    issueId: `${issue.code}:${fnv1a32(issue.evidence ?? issue.description)}`,
  }));
}

// ---------------------------------------------------------------------------
// Acceptance criteria — derived from task + goals + constraints
// ---------------------------------------------------------------------------

function deriveAcceptanceCriteria(input: PappyInput): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  let n = 0;

  // From goals (if provided)
  for (const goal of input.goals ?? []) {
    criteria.push({ id: `AC${++n}`, text: goal, required: true });
  }

  // From required files constraint
  for (const file of input.constraints?.requireFiles ?? []) {
    criteria.push({
      id: `AC${++n}`,
      text: `File "${file}" must be created or modified.`,
      required: true,
    });
  }

  // From required sections constraint
  for (const section of input.constraints?.requireSections ?? []) {
    criteria.push({
      id: `AC${++n}`,
      text: `Output must contain a section titled "${section}".`,
      required: true,
    });
  }

  // If no explicit criteria derivable, at minimum the task must produce output
  if (criteria.length === 0) {
    criteria.push({
      id: "AC1",
      text: "Task must produce non-empty output, file changes, or tool results.",
      required: true,
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// Receipt ledger — one entry per acceptance criterion
// ---------------------------------------------------------------------------

function buildCriteriaLedger(
  input: PappyInput,
  criteria: AcceptanceCriterion[],
): ReceiptEntry[] {
  const entries: ReceiptEntry[] = [];
  const hasOutput  = (input.outputText?.trim().length ?? 0) > 0;
  const hasFiles   = (input.filesChanged?.length ?? 0) > 0;
  const hasTools   = (input.toolEvents?.length ?? 0) > 0;
  const touched    = new Set((input.filesChanged ?? []).map((f) => f.path));

  for (const ac of criteria) {
    // Required file criterion
    const fileMatch = ac.text.match(/[Ff]ile ["`']?([^"`'\s]+)["`']? must be/);
    if (fileMatch) {
      const path = fileMatch[1] ?? "";
      const proved = touched.has(path);
      entries.push({
        ref: ac.id,
        required_receipt: { type: "file_exists", details: `filesChanged entry for "${path}"` },
        status: proved ? "PROVED" : "MISSING",
        evidence: proved ? [`filesChanged: ${path}`] : [],
      });
      continue;
    }

    // General output criterion
    const someProofExists = hasOutput || hasFiles || hasTools;
    entries.push({
      ref: ac.id,
      required_receipt: {
        type: "other",
        details: "Non-empty outputText, filesChanged, or toolEvents",
      },
      status: someProofExists ? "PROVED" : "MISSING",
      evidence: [
        ...(hasOutput ? ["outputText is non-empty"] : []),
        ...(hasFiles  ? [`filesChanged: ${input.filesChanged!.length} file(s)`] : []),
        ...(hasTools  ? [`toolEvents: ${input.toolEvents!.length} event(s)`] : []),
      ],
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Verdict + confidence
// ---------------------------------------------------------------------------

const HARD_FAIL_CODES = new Set([
  "TOOL_INSTRUMENTATION_MISSING",
  "AGENT_LOOP_DETECTED",
  "SAFETY_VIOLATION",
]);

function deriveVerdict(issues: Issue[]): Verdict {
  if (issues.some((issue) => HARD_FAIL_CODES.has(issue.code))) {
    return "FAIL";
  }
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

  const hasOutput = (input.outputText?.trim().length ?? 0) > 0;
  const hasFiles  = (input.filesChanged?.length ?? 0) > 0;
  const hasTools  = (input.toolEvents?.length ?? 0) > 0;
  if (!hasOutput && !hasFiles && !hasTools) score -= 0.3;

  const deductions: Record<string, number> = {
    CRITICAL: 0.4,
    HIGH:     0.2,
    MEDIUM:   0.1,
    LOW:      0.05,
  };

  for (const issue of issues) {
    score -= deductions[issue.severity] ?? 0;
  }

  return parseFloat(Math.max(0, Math.min(1, score)).toFixed(2));
}

function buildSummary(verdict: Verdict, issues: Issue[], hasTrace: boolean): string {
  if (verdict === "PASS") {
    return "All required receipts are present. Task output is verified.";
  }

  const highCount = issues.filter(
    (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
  ).length;
  const medCount = issues.filter((i) => i.severity === "MEDIUM").length;

  const parts: string[] = [];
  if (highCount > 0) parts.push(`${highCount} HIGH issue${highCount > 1 ? "s" : ""} require repair`);
  if (medCount  > 0) parts.push(`${medCount} MEDIUM issue${medCount > 1 ? "s" : ""} need attention`);
  if (!hasTrace)     parts.push("no run trace provided — claims cannot be verified");

  return `${verdict}: ${parts.join("; ")}.`;
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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function evaluateWithPappy(input: PappyInput): PappyResult {
  // Step 1: derive acceptance criteria
  const acceptance_criteria = deriveAcceptanceCriteria(input);

  // Step 2: run claim-proof checks — claims are extracted here as a by-product
  // (avoids iterating CLAIM_PATTERNS twice)
  const { issues: claimIssues, ledger: claimLedger, claims } = runClaimProofChecks(input);

  // Step 3: run all remaining checks

  const rawIssues = [
    ...claimIssues,
    ...runSafetyChecks(input),
    ...runToolResultChecks(input),
    ...runCompletenessChecks(input),
    ...runStructureChecks(input),
    ...runSatisfactionChecks(input),
  ];

  const issues = stampIssueIds(rawIssues);

  // Step 4: build receipt ledger (criteria + claim entries merged)
  const criteriaLedger = buildCriteriaLedger(input, acceptance_criteria);
  const receipt_ledger: ReceiptEntry[] = [...criteriaLedger, ...claimLedger];

  // Step 5: verdict
  const verdict  = deriveVerdict(issues);
  const confidence = deriveConfidence(input, issues);
  const hasTrace = (input.toolEvents?.length ?? 0) > 0 || (input.filesChanged?.length ?? 0) > 0;
  const summary  = buildSummary(verdict, issues, hasTrace);
  const internalSummary = buildInternalSummary(verdict, issues);

  // Step 6: repair task (only when not PASS)
  const repair_task   = verdict !== "PASS" ? buildRepairTask(input.task, issues) : null;
  const repairTaskStr = repair_task ? repairTaskToString(repair_task) : undefined;

  return {
    verdict,
    confidence,
    summary,
    acceptance_criteria,
    claims,
    receipt_ledger,
    issues,
    repair_task,
    internalSummary,
    repairTask: repairTaskStr,  // backward compat
  };
}

