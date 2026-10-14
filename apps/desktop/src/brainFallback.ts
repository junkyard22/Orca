/**
 * Brain failure classification and the explicit fallback decision — the
 * pure part of `brainRoute` (main.ts), kept out of the Electron process so
 * it can be tested.
 *
 * A cancelled Brain is a cancelled task: it is never classified, never a
 * fallback. Everything else that stops Brain from producing a usable plan is
 * named (so the UI and the trace say what happened) and replaced by a
 * deterministic route that carries the user's own goals as the acceptance
 * criteria. The task specification itself is never changed: permissions,
 * restrictions and the objective travel with the task, not with the route.
 */
import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { DecomposeDecision } from "maestro-core";
import { isAbortError } from "@clawde/orca-core";
import { normalizeDesktopRoutingForExecution } from "./routingPolicy";
import type { RoutingPolicyResult } from "./routingPolicy";

export type BrainFailure = "invalid_plan" | "provider_failed" | "timed_out" | "no_decision";

export type BrainErrorClassification =
  | { kind: "cancelled" }
  /** The budget refused the planning request before dispatch: no model can run for this task, so there is nothing to fall back to. */
  | { kind: "budget_refused"; detail: string }
  | { kind: "timed_out"; detail: string }
  | { kind: "provider_failed"; detail: string };

/**
 * What a thrown Brain error means. Cancellation is reported, never absorbed:
 * an AbortError, or any error raised while the task's signal is already
 * aborted (an adapter may wrap the abort in its own accounting error), is a
 * cancellation — never a provider failure, never a fallback.
 */
export function classifyBrainError(err: unknown, signalAborted = false): BrainErrorClassification {
  if (signalAborted || isAbortError(err)) return { kind: "cancelled" };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "BudgetRefusedError") return { kind: "budget_refused", detail: message };
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return { kind: "timed_out", detail: message };
  return { kind: "provider_failed", detail: message };
}

/** The cause when Brain produced nothing usable without throwing. */
export function classifyMissingDecision(repairAttempted: boolean): BrainFailure {
  return repairAttempted ? "invalid_plan" : "no_decision";
}

export interface BrainFallbackResolution {
  routing: RoutingPolicyResult;
  /** Present when Brain's plan was replaced; absent when Brain's own plan is used. */
  fallback?: { cause: BrainFailure; role: string; reason: string; preservedCriteria: string[] };
}

/**
 * Resolve the route from Brain's decision (or its absence). When there is no
 * usable decision the fallback is explicit: cause, replacement role, and the
 * criteria it carries — Brain's criteria when Brain gave some, otherwise the
 * user's goals. `task` is read, never mutated.
 */
export function resolveBrainRoute(
  task: OrcaTaskSpec,
  decision: DecomposeDecision | null,
  auditFallback: DecomposeDecision | null,
  failure: BrainFailure | undefined,
): BrainFallbackResolution {
  const routing = normalizeDesktopRoutingForExecution(task, decision, auditFallback);
  if (decision) return { routing };
  const resolved = routing.decision;
  const role = resolved.routing === "direct" ? resolved.role : resolved.departments.map((d) => d.head).join("+");
  const cause = failure ?? "no_decision";
  const reason = auditFallback
    ? `Brain ${cause}; using deterministic audit decomposition`
    : `Brain ${cause}; routing to ${role} with the original goals as acceptance criteria`;
  return { routing, fallback: { cause, role, reason, preservedCriteria: resolved.done_criteria ?? [] } };
}
