import { afterEach, describe, expect, it } from "vitest";
import { currentBudgetLedger, runWithBudget } from "@clawde/miranda-core";
import { budgetWarnings, createMessageBudget, formatBudgetStatus, getSessionBudget, isValidCustomPrice, messageBudgetLimit, resetSessionBudget, setCustomPrices } from "./budgetContext";
import { buildAdapterForProvider } from "./providerAdapter";
import type { ProviderEntry } from "./settings";

const ANTHROPIC: ProviderEntry = { id: "p_anth", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetSessionBudget(); setCustomPrices([]); });

function answer(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("desktop budget context", () => {
  it("reads the hard limit from Settings; 0 means no hard limit", () => {
    expect(messageBudgetLimit({ budgetUsd: 3 })).toBe(3);
    expect(messageBudgetLimit({ budgetUsd: 0 })).toBeNull();
    expect(messageBudgetLimit({ budgetUsd: Number.NaN })).toBeNull();
  });

  it("warns about the historical default and about an unlimited budget, without changing either", () => {
    expect(budgetWarnings({ budgetUsd: 0.1, budgetSource: "legacy_default" }).join(" ")).toMatch(/historical default of \$0\.10 per task.*never explicitly chosen/);
    expect(budgetWarnings({ budgetUsd: 0, budgetSource: "user" }).join(" ")).toMatch(/No hard task budget is set/);
    expect(budgetWarnings({ budgetUsd: 3, budgetSource: "user" })).toEqual([]);
  });

  it("every provider adapter is budgeted: requests inside a message are accounted against its ledger, with the key never recorded", async () => {
    answer({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    const adapter = buildAdapterForProvider(ANTHROPIC, "claude-sonnet-5-5");
    const message = createMessageBudget({ budgetUsd: 1, budgetSource: "user" });
    await runWithBudget(message, () => adapter.complete({ model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 256 }));
    const s = message.snapshot();
    expect(s.requests.settled).toBe(1);
    expect(s.spentUsd).toBeCloseTo((100 * 2 + 50 * 10) / 1_000_000, 9);
    expect(s.limitSource).toBe("user");
    expect(JSON.stringify(message.history())).not.toContain("sk-test");
    // Mirrored into the session ledger for the status bar.
    expect(getSessionBudget().snapshot().spentUsd).toBe(s.spentUsd);
  });

  it("a request made outside any message (start-up utility call) lands in the session ledger and is never refused", async () => {
    answer({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const adapter = buildAdapterForProvider(ANTHROPIC, "claude-opus-5-5");
    expect(currentBudgetLedger()).toBeUndefined();
    await adapter.complete({ model: "", messages: [{ role: "user", content: "lexicon" }], temperature: 0, maxTokens: 800 });
    expect(getSessionBudget().snapshot()).toMatchObject({ limitUsd: null, requests: { settled: 1 } });
  });

  it("refuses a request the message budget cannot cover before any network call, naming the fix", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 500 }); }) as typeof fetch;
    const adapter = buildAdapterForProvider(ANTHROPIC, "claude-opus-5-5");
    const message = createMessageBudget({ budgetUsd: 0.01, budgetSource: "legacy_default" });
    await expect(runWithBudget(message, () => adapter.complete({ model: "", messages: [{ role: "user", content: "x".repeat(4000) }], temperature: 0, maxTokens: 4096 })))
      .rejects.toThrow(/would exceed the remaining task budget of \$0\.0100.*historical default budget, never explicitly chosen/);
    expect(called).toBe(false);
    expect(message.snapshot().requests.refused).toBe(1);
  });

  it("custom prices from Settings price otherwise unknown models, and invalid entries are ignored", async () => {
    expect(isValidCustomPrice({ model: "m", inputPer1M: 1, outputPer1M: 2 })).toBe(true);
    expect(isValidCustomPrice({ model: "", inputPer1M: 1, outputPer1M: 2 })).toBe(false);
    expect(isValidCustomPrice({ model: "m", inputPer1M: -1, outputPer1M: 2 })).toBe(false);
    setCustomPrices([{ providerId: "p_or", model: "qwen/qwen3-coder-next", inputPer1M: 0.12, outputPer1M: 0.12 }, { model: "bad" } as never]);
    answer({ prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 });
    const openrouter: ProviderEntry = { id: "p_or", name: "OpenRouter", type: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
    const adapter = buildAdapterForProvider(openrouter, "qwen/qwen3-coder-next");
    const message = createMessageBudget({ budgetUsd: 1, budgetSource: "user" });
    await runWithBudget(message, () => adapter.complete({ model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 256 }));
    expect(message.snapshot().spentUsd).toBeCloseTo((1000 * 0.12 + 1000 * 0.12) / 1_000_000, 9);
    expect(message.history()[0]?.priceStatus).toBe("custom");
  });

  it("formats the status line from confirmed figures, flagging unreconciled and unpriced requests", () => {
    const message = createMessageBudget({ budgetUsd: 3, budgetSource: "user" });
    expect(formatBudgetStatus(message.snapshot())).toBe("$0.0000 of $3.00");
    const free = createMessageBudget({ budgetUsd: 0, budgetSource: "user" });
    expect(formatBudgetStatus(free.snapshot())).toMatch(/no hard limit/);
  });
});
