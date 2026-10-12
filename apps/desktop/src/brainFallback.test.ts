/**
 * Brain failure classification and fallback — every way Brain can fail to
 * plan, what it is called, and what the replacement route carries. A
 * cancellation is never a fallback. No prompt phrase is hardcoded anywhere.
 */
import { describe, expect, it } from "vitest";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import { classifyBrainError, classifyMissingDecision, resolveBrainRoute } from "./brainFallback";

const abort = (message = "Stopped.") => Object.assign(new Error(message), { name: "AbortError" });
const task = (message: string, goals: string[] = ["cancelBooking must remove the booking"]): OrcaTaskSpec => ({
  originalUserMessage: message,
  intent: message,
  goals,
  permissions: { fileRead: true, fileWrite: true, shellExec: false, networkAccess: false },
  context: { restrictions: ["do not modify the existing tests"] },
} as unknown as OrcaTaskSpec);

describe("Brain error classification", () => {
  it("names each failure, and reports cancellation as cancellation", () => {
    expect(classifyBrainError(Object.assign(new Error("401 Unauthorized: invalid API key"), { name: "ProviderAuthError" }))).toEqual({ kind: "provider_failed", detail: "401 Unauthorized: invalid API key" });
    expect(classifyBrainError(new Error("Request timed out after 60000 ms"))).toEqual({ kind: "timed_out", detail: "Request timed out after 60000 ms" });
    expect(classifyBrainError(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }))).toEqual({ kind: "provider_failed", detail: "connect ECONNRESET" });
    expect(classifyBrainError(new Error("fetch failed: ETIMEDOUT"))).toEqual({ kind: "timed_out", detail: "fetch failed: ETIMEDOUT" });
    expect(classifyBrainError(new Error("503 Service Unavailable"))).toEqual({ kind: "provider_failed", detail: "503 Service Unavailable" });
    expect(classifyBrainError("string error")).toEqual({ kind: "provider_failed", detail: "string error" });
    expect(classifyBrainError(abort())).toEqual({ kind: "cancelled" });
    // A budget refusal before dispatch is neither a provider failure nor a reason to fall back: the task stops with the budget reason.
    expect(classifyBrainError(Object.assign(new Error("Budget refused_limit: reserving $279 would exceed the remaining task budget"), { name: "BudgetRefusedError" }))).toEqual({ kind: "budget_refused", detail: "Budget refused_limit: reserving $279 would exceed the remaining task budget" });
    expect(classifyBrainError(abort("Stopped. timed out"))).toEqual({ kind: "cancelled" }); // cancellation wins over any wording
    // An adapter may wrap the abort in its own error (budget accounting of a request that failed after dispatch): with the signal aborted it is still a cancellation.
    expect(classifyBrainError(Object.assign(new Error("Budget refused_unreconciled: the request failed after dispatch (Stopped.)"), { name: "BudgetRefusedError" }), true)).toEqual({ kind: "cancelled" });
    expect(classifyBrainError(Object.assign(new Error("Budget refused_unreconciled: the request failed after dispatch (fetch failed)"), { name: "BudgetRefusedError" }), false)).toEqual({ kind: "budget_refused", detail: "Budget refused_unreconciled: the request failed after dispatch (fetch failed)" });
    expect(classifyBrainError(Object.assign(new Error("fetch failed"), { name: "ProviderRequestError" }), false)).toEqual({ kind: "provider_failed", detail: "fetch failed" });
  });

  it("a missing decision is invalid_plan after a repair attempt, no_decision otherwise", () => {
    expect(classifyMissingDecision(true)).toBe("invalid_plan");
    expect(classifyMissingDecision(false)).toBe("no_decision");
  });
});

describe("Brain fallback resolution", () => {
  it("a successful plan is used as is: no fallback, Brain's criteria kept", () => {
    const t = task("Fix the crash in src/parse.js when the input is empty.");
    const r = resolveBrainRoute(t, { routing: "direct", role: "debugger", done_criteria: ["parse('') returns null"] }, null, undefined);
    expect(r.fallback).toBeUndefined();
    expect(r.routing.decision).toMatchObject({ routing: "direct", role: "debugger", done_criteria: ["parse('') returns null"] });
  });

  it.each(["invalid_plan", "provider_failed", "timed_out", "no_decision"] as const)("%s: the fallback is explicit, chosen by the work, and carries the user's goals; the task itself is untouched", (cause) => {
    const t = task("Fix the crash in src/parse.js when the input is empty.");
    const frozen = JSON.stringify(t);
    const r = resolveBrainRoute(t, null, null, cause);
    expect(r.fallback).toEqual({ cause, role: "debugger", reason: `Brain ${cause}; routing to debugger with the original goals as acceptance criteria`, preservedCriteria: ["cancelBooking must remove the booking"] });
    expect(r.routing.decision).toMatchObject({ routing: "direct", role: "debugger", done_criteria: ["cancelBooking must remove the booking"] });
    expect(r.routing.remapReason).toBe("missing_decision");
    expect(JSON.stringify(t)).toBe(frozen); // objective, goals, permissions, restrictions unchanged
  });

  it("a deterministic audit decomposition replaces Brain for audit-shaped work, with the cause named", () => {
    const t = task("Audit this project", []);
    const audit = { routing: "decompose" as const, departments: [{ head: "reviewer" as const, subtask: "Audit code" }], done_criteria: ["findings listed"] };
    const r = resolveBrainRoute(t, null, audit, "provider_failed");
    expect(r.fallback).toMatchObject({ cause: "provider_failed", role: "reviewer", reason: "Brain provider_failed; using deterministic audit decomposition", preservedCriteria: ["findings listed"] });
  });

  it("without a cause the fallback is reported as no_decision, never silently", () => {
    const r = resolveBrainRoute(task("What should I cook tonight?", []), null, null, undefined);
    expect(r.fallback?.cause).toBe("no_decision");
    expect(r.fallback?.role).toBe("narrator");
  });
});
