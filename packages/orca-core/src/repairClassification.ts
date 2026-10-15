/**
 * What kind of problem a Pappy issue describes, for deciding whether a worker
 * repair pass can help.
 *
 *   code_defect         the output or the change is wrong; another edit may fix it
 *   missing_evidence    the work may be right but its proof is missing; a test or
 *                       validation run (not necessarily an edit) supplies it
 *   authorization       a tool call was not approved; only the user can change that
 *   evidence_integrity  the evidence itself could not be taken completely (for
 *                       example, processes of unknown ownership were still running);
 *                       it needs settlement or investigation, not code changes
 *
 * This decides only whether to dispatch a worker. It never changes a verdict:
 * Pappy's FAIL stands either way. An issue that is not recognised is treated as
 * a code defect, so an unknown issue keeps today's behaviour (a repair pass).
 */
import type { Issue as PappyIssue } from "@clawde/pappy-core";
import { summarizeRefusals, type ToolRefusal } from "./authorization.js";

export type RepairIssueClass = "code_defect" | "missing_evidence" | "authorization" | "evidence_integrity";

const EVIDENCE_INTEGRITY = new Set(["EVIDENCE_PARTIAL"]);

const MISSING_EVIDENCE = new Set([
  "FIX_TESTS_NOT_RERUN",
  "FIX_TEST_SUBSET_ONLY",
  "FIX_REPRODUCTION_MISSING",
  "FIX_BEHAVIOUR_EVIDENCE_MISSING",
  "REQUIRED_RECEIPT_MISSING",
  "REQUIRED_EVIDENCE_INSUFFICIENT",
  "RECEIPT_PARTIAL",
  "PROOF_NO_TRACE",
  "TOOL_MISSING",
]);

/** A tool failure whose recorded error says the user did not approve the call. */
const NOT_APPROVED = /\b(?:not approved|denied by (?:the )?user|approval (?:was )?(?:denied|refused|timed out)|was not approved)\b/i;

export function classifyRepairIssue(issue: Pick<PappyIssue, "code" | "message" | "description" | "evidence">): RepairIssueClass {
  if (EVIDENCE_INTEGRITY.has(issue.code)) return "evidence_integrity";
  if (issue.code === "TOOL_FAILURE" && NOT_APPROVED.test(`${issue.evidence ?? ""} ${issue.message ?? ""} ${issue.description ?? ""}`)) return "authorization";
  if (MISSING_EVIDENCE.has(issue.code)) return "missing_evidence";
  return "code_defect";
}

export interface RepairDecision {
  /** Whether a worker repair pass can address at least one blocking issue. */
  dispatch: boolean;
  blocking: Array<{ code: string; severity: string; class: RepairIssueClass }>;
  /** Why no worker was dispatched (only when `dispatch` is false). */
  reason?: string;
  /** Set when the task is blocked by the user's authorization (a refused operation it needs). */
  blockedByAuthorization?: boolean;
}

/** Issues that say the goal or its proof is missing — what a refused operation leaves behind. */
const GOAL_UNMET = new Set(["CORE_GOAL_MISSING", "COMPLETENESS_GOAL_COVERAGE"]);

/**
 * Decide whether a worker repair pass is worth dispatching for a FAIL. Only
 * blocking issues (CRITICAL / HIGH) count: when every one of them is about
 * authorization or evidence integrity, a worker cannot resolve it — editing
 * correct code to answer a process-ownership warning only adds risk — so no
 * pass is dispatched and the FAIL is reported for a person to act on. Any
 * code defect or missing evidence keeps the repair pass (unchanged bounds).
 */
export function decideRepair(issues: readonly PappyIssue[], refusals: readonly ToolRefusal[] = []): RepairDecision {
  const blocking = issues
    .filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH")
    .map((i) => ({ code: i.code, severity: i.severity, class: classifyRepairIssue(i) }));
  // The user refused (or did not answer) an operation in this task. When the
  // FAIL depends on it — the refusal itself, or the evidence or goal it left
  // missing — a repair pass could only ask for the same operation again, or a
  // substitute for it: no pass is dispatched and the task is reported as
  // blocked by the user's authorization. Pappy's verdict is unchanged. When
  // every blocking issue is a genuine defect unrelated to the refusal (the
  // refused operation was optional), the repair proceeds; the refused
  // operation is still never asked for again (runtime, authorization.ts).
  const unanswered = refusals.filter((r) => r.outcome !== "cancelled");
  if (unanswered.length > 0) {
    const dependent = blocking.filter((b) => b.class === "authorization" || b.class === "missing_evidence" || GOAL_UNMET.has(b.code));
    if (dependent.length > 0) {
      const genuine = blocking.filter((b) => !dependent.includes(b) && b.class === "code_defect").map((b) => b.code);
      const reason = `No repair pass: the task is blocked by your authorization — ${summarizeRefusals(unanswered)}. `
        + "Completing it needs that operation, and Orca does not ask again for something you refused or did not answer; start a new request if you want it to run."
        + (genuine.length > 0 ? ` Pappy also found ${[...new Set(genuine)].join(", ")}; it is reported, not repaired, because verifying a fix needs the same operation.` : "");
      return { dispatch: false, blocking, reason, blockedByAuthorization: true };
    }
    return { dispatch: true, blocking };
  }
  if (blocking.length === 0 || blocking.some((b) => b.class === "code_defect" || b.class === "missing_evidence")) {
    return { dispatch: true, blocking };
  }
  const integrity = blocking.filter((b) => b.class === "evidence_integrity").map((b) => b.code);
  const authorization = blocking.filter((b) => b.class === "authorization").map((b) => b.code);
  const parts = [
    ...(integrity.length > 0 ? [`the evidence could not be taken completely (${[...new Set(integrity)].join(", ")}): it needs the workspace to settle or a person to investigate, not code changes`] : []),
    ...(authorization.length > 0 ? ["a tool call was not approved: only the user can approve it"] : []),
  ];
  return { dispatch: false, blocking, reason: `No repair pass: ${parts.join("; and ")}.` };
}
