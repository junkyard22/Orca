import { describe, expect, it, vi } from "vitest";
import type { MirandaGate } from "@clawde/miranda-core";
import { composeMirandaGates, runGatedLLMCall } from "./llmGate";
import { TaskBudgetLedger, budgetedAdapter, createMirandaGate, runWithBudget } from "@clawde/miranda-core";

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

describe("runGatedLLMCall with a task budget", () => {
  const ANTHROPIC = { id: "p", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
  const req = { model: "", messages: [{ role: "user" as const, content: "hello" }], temperature: 0, maxTokens: 256 };
  const fake = (usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null) => ({
    name: "fake", complete: async () => ({ content: "ok", model: "claude-sonnet-5-5", usage, durationMs: 1 }),
  });

  it("gives Miranda the ledger's figures and passes the budget decision through the gate at the budget checkpoint", async () => {
    const seen: Array<{ stage: string; budgetUsed: number; budgetLimit: number; decision?: string }> = [];
    const g = gate({ beforeLLMCall: (ctx) => { seen.push({ stage: ctx.stage, budgetUsed: ctx.budgetUsed, budgetLimit: ctx.budgetLimit, decision: ctx.budget?.kind }); return { allowed: true, reason: "ok", verdict: "PASS" }; } });
    const ledger = new TaskBudgetLedger({ taskId: "t", limitUsd: 1 });
    const adapter = budgetedAdapter(fake({ promptTokens: 100, completionTokens: 10, totalTokens: 110 }), { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    await runWithBudget(ledger, () => runGatedLLMCall({ gate: g, model: "claude-sonnet-5-5" }, { stage: "claire_narration", role: "narrator", outputOf: (r: { content: string }) => r.content }, () => adapter.complete(req)));
    expect(seen.map((s) => [s.stage, s.decision])).toEqual([["claire_narration", undefined], ["budget:claire_narration", "authorized"]]);
    expect(seen[0]).toMatchObject({ budgetUsed: 0, budgetLimit: 1 });
    expect(ledger.snapshot().byRole["narrator"]?.requests).toBe(1);
  });

  it("a refusal at the budget checkpoint blocks before any provider call and names the kind", async () => {
    // The real Miranda gate: the budget checkpoint turns the ledger's refusal into a BLOCK.
    const g = createMirandaGate();
    const ledger = new TaskBudgetLedger({ taskId: "t", limitUsd: 1 });
    let called = false;
    const adapter = budgetedAdapter({ name: "f", complete: async () => { called = true; return { content: "x", model: "m", usage: null, durationMs: 1 }; } }, { provider: { id: "or", type: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, defaultModel: "openai/gpt-4o-mini" });
    await expect(runWithBudget(ledger, () => runGatedLLMCall({ gate: g, model: "openai/gpt-4o-mini" }, { stage: "brain_route", role: "brain", outputOf: (r: { content: string }) => r.content }, () => adapter.complete(req))))
      .rejects.toThrow(/Budget refused_pricing_unknown/);
    expect(called).toBe(false);
  });

  it("Miranda's own used >= limit check now sees real figures: once the ledger is exhausted the next call is blocked at the gate", async () => {
    // A gate that only looks at the figures it is given: they must be the ledger's, not placeholders.
    const g = gate({ beforeLLMCall: (ctx) => (ctx.budgetUsed > 0 && ctx.budgetUsed >= ctx.budgetLimit / 2 ? { allowed: false, reason: `Budget exceeded: ${ctx.budgetUsed}/${ctx.budgetLimit}`, verdict: "BLOCK" } : { allowed: true, reason: "ok", verdict: "PASS" }) });
    const ledger = new TaskBudgetLedger({ taskId: "t", limitUsd: 0.002 });
    // ≈ $0.0012 reserved, then charged as unreconciled: Miranda sees 0.0012 of 0.002 on the next call.
    ledger.markUnreconciled(ledger.reserve({ provider: ANTHROPIC, model: "claude-sonnet-5-5", messages: req.messages, maxTokens: 1 }), "network");
    const adapter = budgetedAdapter(fake(null), { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    await expect(runWithBudget(ledger, () => runGatedLLMCall({ gate: g, model: "claude-sonnet-5-5" }, { stage: "agent_iteration", outputOf: (r: { content: string }) => r.content }, () => adapter.complete(req))))
      .rejects.toThrow(/Miranda gate blocked LLM call: Budget exceeded/);
  });
});
