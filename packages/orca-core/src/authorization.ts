/**
 * The user's answers to tool-call approvals, per task (1.7.0, after packaged
 * check H1, where a denied command was asked for again by an automatic repair
 * pass).
 *
 * Rules:
 *   - No means no: a call the user denied is not asked for again in the same
 *     task — not by the same worker, not by a repair pass. The worker is told
 *     it was not approved; the card is not shown again.
 *   - Silence is not yes, and not no: a call whose approval timed out was not
 *     authorized. It is reported as timed out (not as a denial) and is not
 *     retried automatically either.
 *   - Stop is neither: a call refused because the task was stopping is
 *     reported as cancelled.
 *
 * Approval answers reach the runtime as a decision with an outcome; below the
 * runtime every consumer still receives a plain boolean, and only `true` (or a
 * decision whose `approved` is exactly `true`) authorizes a call.
 */

export type ApprovalOutcome = "approved" | "denied" | "timed_out" | "cancelled" | "refused" | "not_approved";

/** What an approval host may return instead of a bare boolean. */
export interface ToolApprovalDecision {
  approved: boolean;
  outcome: ApprovalOutcome;
  /** The host's own words (for example "denied by the user", "timed out"). */
  reason?: string;
}

export interface ToolRefusal {
  tool: string;
  /** The operation as asked: the exact command for run_command, else the arguments. */
  operation: string;
  outcome: Exclude<ApprovalOutcome, "approved">;
  reason?: string;
  at: string;
  /** Requests for the same operation that were refused without asking again. */
  repeats: number;
}

const OUTCOMES = new Set<ApprovalOutcome>(["approved", "denied", "timed_out", "cancelled", "refused", "not_approved"]);

/**
 * Normalize what an approval host returned. Fail-safe: anything other than
 * `true` or `{ approved: true }` is not an approval. A bare `false` carries no
 * reason, so it is "not_approved" rather than a claim that the user denied it.
 */
export function normalizeApproval(raw: unknown): ToolApprovalDecision {
  if (raw === true) return { approved: true, outcome: "approved" };
  if (raw && typeof raw === "object") {
    const r = raw as { approved?: unknown; outcome?: unknown; reason?: unknown };
    const reason = typeof r.reason === "string" ? r.reason : undefined;
    if (r.approved === true) return { approved: true, outcome: "approved", ...(reason ? { reason } : {}) };
    const outcome = typeof r.outcome === "string" && OUTCOMES.has(r.outcome as ApprovalOutcome) && r.outcome !== "approved" ? (r.outcome as ApprovalOutcome) : "not_approved";
    return { approved: false, outcome, ...(reason ? { reason } : {}) };
  }
  return { approved: false, outcome: "not_approved" };
}

/** The operation a request is for: run_command by its exact command, anything else by tool + arguments. */
export function operationOf(tool: string, args: Record<string, unknown>): string {
  const command = args["command"];
  if (typeof command === "string") return command.trim();
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

/** What the worker is told about a call that was not approved. Every message says "not approved". */
export function describeRefusal(r: Pick<ToolRefusal, "outcome" | "reason">, repeated = false): string {
  const again = repeated ? " It had already been refused in this task, so it was not asked for again." : "";
  const dont = " Do not request it again or substitute another operation for it; report that it was not approved.";
  switch (r.outcome) {
    case "denied":
      return `Not run: not approved — the user denied this call.${again}${dont}`;
    case "timed_out":
      return `Not run: not approved — approval timed out (the user did not answer). That is not a denial, and not an approval.${again}${dont}`;
    case "cancelled":
      return `Not run: not approved — the task was stopped before the call could be authorized.${again}`;
    case "refused":
      return `Not run: not approved — the answer could not be accepted${r.reason ? ` (${r.reason})` : ""}.${again}${dont}`;
    default:
      return `Not run: not approved.${again}${dont}`;
  }
}

export interface AuthorizationRecord {
  /** A refusal already recorded for this operation in this task, if any. */
  refusalFor(tool: string, args: Record<string, unknown>): ToolRefusal | undefined;
  record(tool: string, args: Record<string, unknown>, decision: ToolApprovalDecision): ToolRefusal;
  /** Every refused operation of the task, in order. */
  refusals(): ToolRefusal[];
  /** The most recent refusal and a counter that changes with each refusal or repeat. */
  last(): { refusal: ToolRefusal; repeated: boolean; seq: number } | undefined;
  noteRepeat(refusal: ToolRefusal): void;
}

export function createAuthorizationRecord(now: () => Date = () => new Date()): AuthorizationRecord {
  const byKey = new Map<string, ToolRefusal>();
  let latest: { refusal: ToolRefusal; repeated: boolean; seq: number } | undefined;
  let seq = 0;
  const key = (tool: string, args: Record<string, unknown>) => `${tool}\u0000${operationOf(tool, args)}`;
  return {
    refusalFor: (tool, args) => byKey.get(key(tool, args)),
    record(tool, args, decision) {
      const refusal: ToolRefusal = {
        tool,
        operation: operationOf(tool, args),
        outcome: decision.outcome === "approved" ? "not_approved" : decision.outcome,
        ...(decision.reason ? { reason: decision.reason } : {}),
        at: now().toISOString(),
        repeats: 0,
      };
      byKey.set(key(tool, args), refusal);
      latest = { refusal, repeated: false, seq: ++seq };
      return refusal;
    },
    refusals: () => [...byKey.values()],
    last: () => latest,
    noteRepeat(refusal) {
      refusal.repeats += 1;
      latest = { refusal, repeated: true, seq: ++seq };
    },
  };
}

/** One line for the user: which operation was not authorized, and how. */
export function summarizeRefusals(refusals: readonly ToolRefusal[]): string {
  const how = (r: ToolRefusal) =>
    r.outcome === "denied" ? "you denied it"
      : r.outcome === "timed_out" ? "its approval timed out without an answer"
        : r.outcome === "cancelled" ? "the task was stopped first"
          : "it was not approved";
  return refusals.map((r) => `${r.tool} \`${r.operation.length > 120 ? `${r.operation.slice(0, 117)}…` : r.operation}\` (${how(r)})`).join("; ");
}
