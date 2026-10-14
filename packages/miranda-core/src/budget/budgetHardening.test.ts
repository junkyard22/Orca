/**
 * Phase 5 budget hardening: cache-write pricing, billing classification of
 * local gateways, streaming/cancellation outcomes through the real
 * OpenAI-compatible adapter with recorded responses, and the legacy-default
 * refusal wording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatAdapter } from "../llm/openaiCompat.js";
import { toTokenUsage } from "../llm/usage.js";
import { BudgetRefusedError, TaskBudgetLedger } from "./ledger.js";
import { resolvePrice } from "./pricing.js";
import { budgetedAdapter, runWithBudget } from "./budgetedAdapter.js";
import type { LLMAdapter, LLMRequest, LLMResponse } from "../llm/types.js";

const ANTHROPIC = { id: "p", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const NOW = new Date("2026-10-12T12:00:00Z");
const msgs = [{ role: "user" as const, content: "hello" }];
const ledger = (limit: number | null, over: Record<string, unknown> = {}) => new TaskBudgetLedger({ taskId: "t", limitUsd: limit, now: () => NOW, ...over });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("cache-write accounting", () => {
  it("parses cache creation and cache read tokens from both wire shapes", () => {
    expect(toTokenUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 400, cache_creation_tokens: 300 } })).toMatchObject({ cachedPromptTokens: 400, cacheCreationTokens: 300 });
    expect(toTokenUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 })).toMatchObject({ cachedPromptTokens: 400, cacheCreationTokens: 300 });
    expect(toTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 })).not.toHaveProperty("cacheCreationTokens");
  });

  it("prices cache writes at the reviewed write rate and cache reads at the read rate (Anthropic)", () => {
    const l = ledger(3);
    const r = l.reserve({ provider: ANTHROPIC, model: "claude-opus-5-5", messages: msgs, maxTokens: 100 });
    // 1000 prompt tokens: 300 written to cache ($5/M), 400 read from cache ($0.20/M), 300 ordinary ($4/M); 10 output ($20/M).
    const e = l.settle(r, { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedPromptTokens: 400, cacheCreationTokens: 300 });
    expect(e.costBasis).toBe("measured");
    expect(e.costUsd).toBeCloseTo((300 * 4 + 400 * 0.2 + 300 * 5 + 10 * 20) / 1_000_000, 12);
    expect(l.snapshot().blocked).toBeUndefined();
  });

  it("a cache write on a model with no known write rate is priced at the base rate, flagged as an estimate, and stops a hard budget", () => {
    const custom = [{ providerId: "or", model: "some/model", inputPer1M: 1, outputPer1M: 2 }];
    const l = ledger(3, { customPrices: custom });
    const provider = { id: "or", type: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
    const e = l.settle(l.reserve({ provider, model: "some/model", messages: msgs, maxTokens: 100 }), { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cacheCreationTokens: 500 });
    expect(e.costBasis).toBe("estimate");
    expect(e.notes.join(" ")).toMatch(/500 cache-creation tokens priced at the base input rate/);
    expect(l.snapshot().blocked?.kind).toBe("refused_pricing_unknown");
    expect(l.snapshot().blocked?.reason).toMatch(/cacheWritePer1M/);
    // Without a hard budget it is recorded and annotated, nothing is blocked.
    const soft = ledger(null, { customPrices: custom });
    soft.settle(soft.reserve({ provider, model: "some/model", messages: msgs, maxTokens: 100 }), { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cacheCreationTokens: 500 });
    expect(soft.snapshot().blocked).toBeUndefined();
  });
});

describe("billing classification of local and private endpoints", () => {
  it("Ollama defaults to local; any other loopback or private endpoint is unknown until classified", () => {
    expect(resolvePrice({ provider: { type: "ollama", baseUrl: "http://localhost:11434" }, model: "llama3.2", now: NOW }).status).toBe("local");
    const gateway = resolvePrice({ provider: { type: "custom", name: "proxy", baseUrl: "http://127.0.0.1:4000/v1" }, model: "claude-opus-5-5", now: NOW });
    expect(gateway.status).toBe("unknown");
    expect(gateway.note).toMatch(/billing is not classified/);
    expect(resolvePrice({ provider: { type: "custom", name: "proxy", baseUrl: "http://192.168.1.9/v1" }, model: "m", now: NOW }).status).toBe("unknown");
  });

  it("a custom endpoint classified local is free of external charges; one classified metered needs a price; Ollama classified metered is not free", () => {
    expect(resolvePrice({ provider: { type: "custom", baseUrl: "http://127.0.0.1:8080/v1", billing: "local" }, model: "m", now: NOW }).status).toBe("local");
    expect(resolvePrice({ provider: { type: "custom", baseUrl: "http://127.0.0.1:8080/v1", billing: "metered" }, model: "m", now: NOW }).status).toBe("unknown");
    expect(resolvePrice({ provider: { id: "gw", type: "custom", baseUrl: "http://127.0.0.1:8080/v1", billing: "metered" }, model: "m", customPrices: [{ providerId: "gw", model: "m", inputPer1M: 1, outputPer1M: 2 }], now: NOW }).status).toBe("custom");
    expect(resolvePrice({ provider: { type: "ollama", baseUrl: "https://ollama.example.com", billing: "metered" }, model: "m", now: NOW }).status).toBe("unknown");
  });

  it("an unpriced local gateway cannot run under a hard budget; it runs and is annotated without one", () => {
    const provider = { id: "gw", type: "custom", name: "proxy", baseUrl: "http://localhost:4000/v1" };
    const hard = ledger(3);
    expect(() => hard.reserve({ provider, model: "claude-opus-5-5", messages: msgs, maxTokens: 100 })).toThrow(BudgetRefusedError);
    const soft = ledger(null);
    expect(soft.reserve({ provider, model: "claude-opus-5-5", messages: msgs, maxTokens: 100 }).decision.kind).toBe("no_hard_budget");
  });
});

describe("streaming and cancellation through the real adapter", () => {
  function sse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  const adapterFor = () => budgetedAdapter(new OpenAICompatAdapter({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", defaultModel: "claude-sonnet-5-5", providerName: "Anthropic" }), { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
  const req = { model: "", messages: msgs, temperature: 0, maxTokens: 64 };

  it("a stream that ends with a usage chunk settles at measured cost", async () => {
    globalThis.fetch = (async () => sse(['{"choices":[{"delta":{"content":"hi"}}]}', '{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":1,"total_tokens":13}}'])) as typeof fetch;
    const l = ledger(1);
    await runWithBudget(l, () => adapterFor().stream!(req, () => {}));
    expect(l.snapshot()).toMatchObject({ requests: { settled: 1 }, inputTokens: 12, costBasis: "measured" });
  });

  it("a stream without a usage chunk is dispatched-but-unmeasured: the upper bound is charged as unreconciled and the hard budget stops", async () => {
    globalThis.fetch = (async () => sse(['{"choices":[{"delta":{"content":"hi"}}]}'])) as typeof fetch;
    const l = ledger(1);
    await runWithBudget(l, () => adapterFor().stream!(req, () => {}));
    const s = l.snapshot();
    expect(s.requests.unreconciled).toBe(1);
    expect(s.unreconciledUsd).toBeGreaterThan(0);
    expect(s.spentUsd).toBe(0);
    expect(s.blocked?.kind).toBe("refused_unreconciled");
  });

  it("a connection failure after generation began keeps the bound as unreconciled (never zero)", async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); c.error(new Error("socket hang up")); } }), { status: 200 })) as typeof fetch;
    const l = ledger(1);
    await expect(runWithBudget(l, () => adapterFor().stream!(req, () => {}))).rejects.toThrow();
    expect(l.snapshot()).toMatchObject({ requests: { unreconciled: 1, inFlight: 0 } });
    expect(l.snapshot().unreconciledUsd).toBeGreaterThan(0);
  });

  it("cancellation after dispatch keeps the reservation charged; before dispatch it is released", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
    const l = ledger(1);
    const controller = new AbortController();
    const pending = runWithBudget(l, () => adapterFor().complete({ ...req, signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 5));
    expect(l.snapshot().requests.inFlight).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(l.snapshot()).toMatchObject({ requests: { unreconciled: 1, inFlight: 0 } });
    const l2 = ledger(1);
    const early = new AbortController();
    early.abort();
    await expect(runWithBudget(l2, () => adapterFor().complete({ ...req, signal: early.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(l2.snapshot()).toMatchObject({ requests: { released: 1 }, unreconciledUsd: 0 });
  });

  it("a late usage report cannot reconcile a request that was already marked unreconciled", () => {
    const l = ledger(1);
    const r = l.reserve({ provider: ANTHROPIC, model: "claude-sonnet-5-5", messages: msgs, maxTokens: 64 });
    l.markUnreconciled(r, "cancelled after dispatch");
    const before = l.snapshot();
    l.settle(r, { promptTokens: 10, completionTokens: 1, totalTokens: 11 }); // late
    expect(l.snapshot()).toMatchObject({ spentUsd: before.spentUsd, unreconciledUsd: before.unreconciledUsd, inputTokens: 0 });
  });
});

describe("legacy default refusal wording", () => {
  it("names the historical default and where to change it; a user-set limit gets the ordinary guidance", () => {
    const legacy = new TaskBudgetLedger({ taskId: "t", limitUsd: 0.1, limitSource: "legacy_default", now: () => NOW });
    const big = { provider: ANTHROPIC, model: "claude-opus-5-5", messages: [{ role: "user" as const, content: "x".repeat(20_000) }], maxTokens: 8192 };
    expect(legacy.decide(big).reason).toMatch(/historical default budget, never explicitly chosen — set the budget you intend in Settings/);
    const user = new TaskBudgetLedger({ taskId: "t", limitUsd: 0.1, limitSource: "user", now: () => NOW });
    expect(user.decide(big).reason).toMatch(/raise the task budget in Settings or use a cheaper model/);
  });
});

describe("cancellation identity (phase 6.5)", () => {
  it("a transport that reports the abort as its own error type still surfaces an AbortError to the caller, with the bound unreconciled as 'cancelled after dispatch'", async () => {
    const ledger = new TaskBudgetLedger({ taskId: "t", limitUsd: 1 });
    const controller = new AbortController();
    const transport = {
      name: "wrapping",
      complete: (r: LLMRequest) => new Promise<LLMResponse>((_res, rej) => {
        r.signal?.addEventListener("abort", () => rej(Object.assign(new Error("Stopped."), { name: "ProviderRequestError" })));
      }),
    } as unknown as LLMAdapter;
    const adapter = budgetedAdapter(transport, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5", fallback: () => ledger });
    const p = adapter.complete({ model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 100, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("Stopped."));
    const error = await p.then(() => null, (e: Error & { cause?: unknown }) => e);
    expect(error?.name).toBe("AbortError");
    expect(error?.message).toBe("Stopped.");
    expect((error?.cause as Error)?.name).toBe("ProviderRequestError");
    expect(JSON.stringify(ledger.history())).toMatch(/cancelled after dispatch/);
  });
});
