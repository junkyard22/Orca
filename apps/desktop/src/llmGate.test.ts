import { describe, expect, it, vi } from "vitest";
import type { MirandaGate } from "@clawde/miranda-core";
import { composeMirandaGates, runGatedLLMCall } from "./llmGate";

function gate(overrides: Partial<MirandaGate>): MirandaGate {
  const pass = { allowed: true, reason: "ok", verdict: "PASS" as const };
  return {
    beforeLLMCall: () => pass,
    afterLLMCall: () => pass,
    beforeToolRun: () => pass,
    afterToolRun: () => pass,
    beforeQC: () => pass,
    afterQC: () => pass,
    ...overrides,
  };
}

describe("composeMirandaGates", () => {
  it("preserves a base LLM denial when a scoped worker gate is added", () => {
    const scopedBefore = vi.fn(() => ({ allowed: true, reason: "scoped ok" }));
    const composed = composeMirandaGates(
      gate({ beforeLLMCall: () => ({ allowed: false, reason: "base blocked" }) }),
      gate({ beforeLLMCall: scopedBefore }),
    );

    const result = composed?.beforeLLMCall({
      stage: "agent_iteration",
      model: "blocked/model",
      budgetUsed: 0,
      budgetLimit: Infinity,
    });

    expect(result?.allowed).toBe(false);
    expect(result?.reason).toBe("base blocked");
    expect(scopedBefore).not.toHaveBeenCalled();
  });
});

describe("runGatedLLMCall", () => {
  it("fails closed when no Miranda gate is configured", async () => {
    const invoke = vi.fn(async () => ({ text: "ungated output" }));

    await expect(runGatedLLMCall(
      { model: "test/model" },
      { stage: "test_stage", outputOf: (result) => result.text },
      invoke,
    )).rejects.toThrow(/Miranda gate is required/i);

    expect(invoke).not.toHaveBeenCalled();
  });
});
