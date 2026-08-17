import { composeMirandaGates } from "@clawde/miranda-core";
import type { LLMCallGateContext, MirandaGate } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";

export interface GatedLLMCallOptions<T> {
  stage: string;
  model?: string;
  budgetUsed?: number;
  budgetLimit?: number;
  outputOf(result: T): string;
}

export { composeMirandaGates };

/**
 * Execute one live desktop model call through Miranda's before/after gates.
 * The callback is never invoked when the pre-call gate blocks.
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
    budgetUsed: options.budgetUsed ?? 0,
    budgetLimit: options.budgetLimit ?? Infinity,
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

  const result = await invoke();
  const output = options.outputOf(result);
  const valid = output.trim().length > 0;
  const afterGate = gate.afterLLMCall(
    gateContext,
    output,
    valid ? { valid: true } : { valid: false, errors: ["LLM output is empty"] },
  );
  ctx.recordTrace?.("miranda.after_llm_call", {
    ...gateContext,
    allowed: afterGate.allowed,
    verdict: afterGate.verdict,
    reason: afterGate.reason,
  });
  if (!afterGate.allowed) {
    throw new Error(`Miranda gate blocked LLM output: ${afterGate.reason}`);
  }

  return result;
}
