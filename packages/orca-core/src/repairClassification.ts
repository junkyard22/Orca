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
}

/**
 * Decide whether a worker repair pass is worth dispatching for a FAIL. Only
 * blocking issues (CRITICAL / HIGH) count: when every one of them is about
 * authorization or evidence integrity, a worker cannot resolve it — editing
 * correct code to answer a process-ownership warning only adds risk — so no
 * pass is dispatched and the FAIL is reported for a person to act on. Any
 * code defect or missing evidence keeps the repair pass (unchanged bounds).
 */
export function decideRepair(issues: readonly PappyIssue[]): RepairDecision {
  const blocking = issues
    .filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH")
    .map((i) => ({ code: i.code, severity: i.severity, class: classifyRepairIssue(i) }));
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
