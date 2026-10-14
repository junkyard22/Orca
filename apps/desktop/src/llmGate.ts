import { composeMirandaGates, currentBudgetLedger, withBudgetAttribution } from "@clawde/miranda-core";
import type { LLMCallGateContext, MirandaGate } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";

export interface GatedLLMCallOptions<T> {
  stage: string;
  model?: string;
  /** Role the request is made for (Brain, a worker role, narrator, utility); attributed in the budget ledger. */
  role?: string;
  budgetUsed?: number;
  budgetLimit?: number;
  outputOf(result: T): string;
}

export { composeMirandaGates };

/** Miranda's budget fields from the ledger active for this call, if any. */
function budgetFields(options: { budgetUsed?: number; budgetLimit?: number }): { budgetUsed: number; budgetLimit: number } {
  const ledger = currentBudgetLedger();
  if (!ledger) return { budgetUsed: options.budgetUsed ?? 0, budgetLimit: options.budgetLimit ?? Infinity };
  const s = ledger.snapshot();
  return { budgetUsed: s.accountedUsd + s.reservedUsd, budgetLimit: s.limitUsd ?? Infinity };
}

/**
 * Execute one live desktop model call through Miranda's before/after gates.
 * The callback is never invoked when the pre-call gate blocks. The budget
 * fields come from the task ledger; the request itself is reserved by the
 * budgeted provider adapter inside `invoke`, which passes the ledger's
 * decision through the same gate at stage `budget:<stage>` before dispatch.
 */
export async function runGatedLLMCall<T>(
  ctx: Pick<OrcaRunCtx, "gate" | "model" | "recordTrace">,
  options: GatedLLMCallOptions<T>,
  invoke: () => Promise<T>,
): Promise<T> {
  const gate = ctx.gate;
  if (!gate) {
    throw new Error(`Miranda gate is required for live LLM stage "${options.stage}".`);
  }

  const gateContext: LLMCallGateContext = {
    stage: options.stage,
    model: options.model ?? ctx.model ?? "unknown",
    ...budgetFields(options),
  };
  const beforeGate = gate.beforeLLMCall(gateContext);
  ctx.recordTrace?.("miranda.before_llm_call", {
    ...gateContext,
    allowed: beforeGate.allowed,
    verdict: beforeGate.verdict,
    reason: beforeGate.reason,
  });
  if (!beforeGate.allowed) {
    throw new Error(`Miranda gate blocked LLM call: ${beforeGate.reason}`);
  }

  const result = await withBudgetAttribution({ stage: options.stage, role: options.role, gate }, invoke);
  const after = budgetFields(options);
  const output = options.outputOf(result);
  const valid = output.trim().length > 0;
  const afterGate = gate.afterLLMCall(
    { ...gateContext, ...after },
    output,
    valid ? { valid: true } : { valid: false, errors: ["LLM output is empty"] },
  );
  ctx.recordTrace?.("miranda.after_llm_call", {
    ...gateContext,
    ...after,
    allowed: afterGate.allowed,
    verdict: afterGate.verdict,
    reason: afterGate.reason,
  });
  if (!afterGate.allowed) {
    throw new Error(`Miranda gate blocked LLM output: ${afterGate.reason}`);
  }

  return result;
}
