import type { GateResult, LLMCallGateContext, MirandaGate } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";

export interface GatedLLMCallOptions<T> {
  stage: string;
  model?: string;
  budgetUsed?: number;
  budgetLimit?: number;
  outputOf(result: T): string;
}

function runGateChain(
  gates: MirandaGate[],
  invoke: (gate: MirandaGate) => GateResult,
): GateResult {
  let latest: GateResult = { allowed: true, reason: "all gates allowed" };
  for (const gate of gates) {
    latest = invoke(gate);
    if (!latest.allowed) return latest;
  }
  return latest;
}

/** Compose a base runtime gate with a narrower worker-scoped gate. */
export function composeMirandaGates(
  ...candidates: Array<MirandaGate | undefined>
): MirandaGate | undefined {
  const gates = candidates.filter((candidate): candidate is MirandaGate => candidate !== undefined);
  if (gates.length === 0) return undefined;
  if (gates.length === 1) return gates[0];

  return {
    beforeLLMCall: (ctx) => runGateChain(gates, (gate) => gate.beforeLLMCall(ctx)),
    afterLLMCall: (ctx, output, validation) =>
      runGateChain(gates, (gate) => gate.afterLLMCall(ctx, output, validation)),
    beforeToolRun: (ctx) => runGateChain(gates, (gate) => gate.beforeToolRun(ctx)),
    afterToolRun: (ctx, result) => runGateChain(gates, (gate) => gate.afterToolRun(ctx, result)),
    beforeQC: (ctx) => runGateChain(gates, (gate) => gate.beforeQC(ctx)),
    afterQC: (ctx, verdict, issueCount) =>
      runGateChain(gates, (gate) => gate.afterQC(ctx, verdict, issueCount)),
  };
}

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
