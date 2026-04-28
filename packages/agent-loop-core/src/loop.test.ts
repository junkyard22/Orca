/**
 * Agent Loop — Miranda before_llm_call gate wiring tests.
 *
 * Proves:
 *   1. beforeLLMCall PASS allows ctx.llm.stream to run
 *   2. beforeLLMCall BLOCK prevents ctx.llm.stream from running
 *   3. BLOCK returns a clear blocked result with stoppedBecause: "gate_blocked"
 *   4. Normal PASS behavior is unchanged (model produces output)
 *   5. No deprecated Miranda pipeline code is used
 *   6. Gate absent (no ctx.gate) — loop runs normally
 */

import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./loop.js";
import type { OrcaRunCtx, OrcaToolService, OrcaLLMService } from "@clawde/orca-core";
import type { MirandaGate, GateResult, LLMCallGateContext } from "@clawde/miranda-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassGate(options?: {
  onBeforeLLMCall?: (ctx: LLMCallGateContext) => void;
}): MirandaGate {
  const passResult: GateResult = {
    allowed: true,
    reason: "gate: PASS",
    verdict: "PASS",
  };
  return {
    beforeLLMCall(ctx) {
      options?.onBeforeLLMCall?.(ctx);
      return passResult;
    },
    afterLLMCall: () => passResult,
    beforeToolRun: () => passResult,
    afterToolRun: () => passResult,
    beforeQC: () => passResult,
    afterQC: () => passResult,
  };
}

function makeBlockGate(reason = "Budget exceeded"): MirandaGate {
  const passResult: GateResult = {
    allowed: true,
    reason: "gate: PASS",
    verdict: "PASS",
  };
  const blockResult: GateResult = {
    allowed: false,
    reason,
    violations: [reason],
    verdict: "BLOCK",
  };
  return {
    beforeLLMCall: () => blockResult,
    afterLLMCall: () => passResult,
    beforeToolRun: () => passResult,
    afterToolRun: () => passResult,
    beforeQC: () => passResult,
    afterQC: () => passResult,
  };
}

function makeLLMService(response: string): OrcaLLMService {
  const stream = vi.fn(async (
    _prompt: string,
    _options: unknown,
    onChunk: (chunk: string) => void,
  ) => {
    onChunk(response);
    return { text: response };
  });
  return {
    complete: vi.fn(async () => ({ text: response })),
    stream,
  };
}

function makeTools(): OrcaToolService {
  return {
    execute: vi.fn(async () => ({ ok: true, output: "done" })),
    formatForPrompt: () => "",
  };
}

function makeCtx(overrides: Partial<OrcaRunCtx> = {}): OrcaRunCtx {
  return {
    llm: makeLLMService("Hello from the model."),
    runId: "test-run-1",
    model: "test-model/v1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeLLMCall PASS — stream runs normally
// ---------------------------------------------------------------------------

describe("beforeLLMCall PASS", () => {
  it("allows ctx.llm.stream to run", async () => {
    const llm = makeLLMService("Model output.");
    const ctx = makeCtx({ llm, gate: makePassGate() });
    const tools = makeTools();

    const result = await runAgentLoop("system", "task", tools, ctx);

    expect(result.text).toBe("Model output.");
    expect(result.stoppedBecause).toBe("done");
    expect(llm.stream).toHaveBeenCalledTimes(1);
  });

  it("passes correct gate context", async () => {
    const captured: LLMCallGateContext[] = [];
    const gate = makePassGate({
      onBeforeLLMCall: (ctx) => captured.push({ ...ctx }),
    });
    const ctx = makeCtx({
      gate,
      model: "deepseek/deepseek-chat",
    });

    await runAgentLoop("system", "task", makeTools(), ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.stage).toBe("agent_loop");
    expect(captured[0]!.model).toBe("deepseek/deepseek-chat");
    expect(captured[0]!.budgetUsed).toBe(0);
    expect(captured[0]!.budgetLimit).toBe(Infinity);
  });

  it("records trace on PASS", async () => {
    const traces: Array<{ stage: string; detail: unknown }> = [];
    const ctx = makeCtx({
      gate: makePassGate(),
      recordTrace: (stage, detail) => traces.push({ stage, detail }),
    });

    await runAgentLoop("system", "task", makeTools(), ctx);

    const llmTraces = traces.filter((t) => t.stage === "miranda.before_llm_call");
    expect(llmTraces).toHaveLength(1);
    const detail = llmTraces[0]!.detail as { allowed: boolean; verdict: string };
    expect(detail.allowed).toBe(true);
    expect(detail.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// beforeLLMCall BLOCK — stream does NOT run
// ---------------------------------------------------------------------------

describe("beforeLLMCall BLOCK", () => {
  it("prevents ctx.llm.stream from running", async () => {
    const llm = makeLLMService("Should not be called.");
    const ctx = makeCtx({ llm, gate: makeBlockGate("Budget exceeded") });

    const result = await runAgentLoop("system", "task", makeTools(), ctx);

    expect(llm.stream).not.toHaveBeenCalled();
    expect(result.text).toBe("");
  });

  it("returns stoppedBecause: gate_blocked", async () => {
    const ctx = makeCtx({ gate: makeBlockGate("Model not in allowlist") });

    const result = await runAgentLoop("system", "task", makeTools(), ctx);

    expect(result.stoppedBecause).toBe("gate_blocked");
  });

  it("returns an error message with the gate reason", async () => {
    const ctx = makeCtx({ gate: makeBlockGate("Budget exceeded: $5.00 used, limit $1.00") });

    const result = await runAgentLoop("system", "task", makeTools(), ctx);

    expect(result.error).toContain("Miranda gate blocked LLM call");
    expect(result.error).toContain("Budget exceeded");
  });

  it("records trace on BLOCK", async () => {
    const traces: Array<{ stage: string; detail: unknown }> = [];
    const ctx = makeCtx({
      gate: makeBlockGate("blocked"),
      recordTrace: (stage, detail) => traces.push({ stage, detail }),
    });

    await runAgentLoop("system", "task", makeTools(), ctx);

    const llmTraces = traces.filter((t) => t.stage === "miranda.before_llm_call");
    expect(llmTraces).toHaveLength(1);
    const detail = llmTraces[0]!.detail as { allowed: boolean; verdict: string };
    expect(detail.allowed).toBe(false);
    expect(detail.verdict).toBe("BLOCK");
  });

  it("returns zero iterationCount on first-turn block", async () => {
    const ctx = makeCtx({ gate: makeBlockGate() });

    const result = await runAgentLoop("system", "task", makeTools(), ctx);

    expect(result.iterationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No gate — loop runs normally (backward compat)
// ---------------------------------------------------------------------------

describe("No gate (backward compat)", () => {
  it("runs ctx.llm.stream when ctx.gate is undefined", async () => {
    const llm = makeLLMService("Normal response.");
    const ctx = makeCtx({ llm, gate: undefined });

    const result = await runAgentLoop("system", "task", makeTools(), ctx);

    expect(result.text).toBe("Normal response.");
    expect(result.stoppedBecause).toBe("done");
    expect(llm.stream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// No deprecated pipeline code
// ---------------------------------------------------------------------------

describe("No deprecated pipeline code in agent loop", () => {
  it("loop.ts does not import from Miranda pipeline modules", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.ts", import.meta.url), "utf-8");
    expect(src).not.toContain('from "../pipeline/');
    expect(src).not.toContain("runPipeline");
    expect(src).not.toContain("mirandaPipeline");
    // Should import GateResult from miranda-core (gate, not pipeline)
    expect(src).toContain("@clawde/miranda-core");
  });
});
