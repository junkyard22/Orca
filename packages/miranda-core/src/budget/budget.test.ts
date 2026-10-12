import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMRequest, LLMResponse, TokenUsage } from "../llm/types.js";
import { createMirandaGate } from "../gate/mirandaGate.js";
import { BudgetRefusedError, TaskBudgetLedger } from "./ledger.js";
import type { BudgetRequest, BudgetSnapshot } from "./ledger.js";
import { ANTHROPIC_PRICES, isLocalEndpoint, resolvePrice } from "./pricing.js";
import { INPUT_BOUND_MARGIN, MESSAGE_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS, inputTokenBound } from "./tokenBound.js";
import { budgetedAdapter, currentBudgetLedger, runWithBudget, withBudgetAttribution } from "./budgetedAdapter.js";

const ANTHROPIC = { id: "p_anth", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const OPENROUTER = { id: "p_or", type: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
const OLLAMA = { id: "p_ol", type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434" };
const NOW = new Date("2026-10-12T12:00:00Z");

const messages = (chars: number) => [{ role: "system" as const, content: "You are terse." }, { role: "user" as const, content: "x".repeat(chars) }];
const request = (over: Partial<BudgetRequest> = {}): BudgetRequest => ({ provider: ANTHROPIC, model: "claude-opus-5-5", messages: messages(4000), maxTokens: 4096, ...over });
const usage = (promptTokens: number, completionTokens: number, cached?: number): TokenUsage => ({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, ...(cached !== undefined ? { cachedPromptTokens: cached } : {}) });
const ledger = (limitUsd: number | null, over: Partial<ConstructorParameters<typeof TaskBudgetLedger>[0]> = {}) => new TaskBudgetLedger({ taskId: "t1", limitUsd, now: () => NOW, ...over });

describe("input token bound", () => {
  it("is derived from the request's bytes, not the model's context window", () => {
    const bound = inputTokenBound(messages(4000))!;
    const bytes = 4000 + "x".length * 0 + "You are terse.".length + "system".length + "user".length;
    expect(bound).toBe(Math.ceil((bytes + 2 * MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS) * INPUT_BOUND_MARGIN));
    expect(bound).toBeLessThan(10_000);
  });
  it("counts multi-byte text by bytes and refuses content it cannot measure", () => {
    expect(inputTokenBound([{ role: "user", content: "日本語" }])!).toBeGreaterThan(inputTokenBound([{ role: "user", content: "abc" }])!);
    expect(inputTokenBound([{ role: "user", content: 42 as unknown as string }])).toBeNull();
    expect(inputTokenBound([])).toBeNull();
  });
});

describe("price resolution", () => {
  it("prices Anthropic models from the reviewed catalog, with documented limits", () => {
    const p = resolvePrice({ provider: ANTHROPIC, model: "claude-opus-5-5", now: NOW });
    expect(p).toMatchObject({ status: "known", tariff: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2 }, maxInputTokens: 1_000_000, maxOutputTokens: 128_000, reviewed: "2026-10-12" });
    expect(ANTHROPIC_PRICES.every((r) => r.source.includes("platform.claude.com"))).toBe(true);
  });
  it("does not substitute a similar model's price or another provider's listing", () => {
    expect(resolvePrice({ provider: ANTHROPIC, model: "claude-opus-5-5-fast", now: NOW }).status).toBe("unknown");
    expect(resolvePrice({ provider: OPENROUTER, model: "anthropic/claude-opus-5-5", now: NOW }).status).toBe("unknown");
    expect(resolvePrice({ provider: OPENROUTER, model: "claude-opus-5-5", now: NOW }).status).toBe("unknown");
  });
  it("marks a catalog row stale after the allowed age and says so", () => {
    const p = resolvePrice({ provider: ANTHROPIC, model: "claude-sonnet-5-5", now: new Date("2027-06-01T00:00:00Z") });
    expect(p.status).toBe("stale");
    expect(p.note).toMatch(/reviewed on 2026-10-12/);
  });
  it("uses a user-configured price for a custom or unpriced model, scoped by provider", () => {
    const custom = [{ providerId: "p_or", model: "qwen/qwen3-coder-next", inputPer1M: 0.12, outputPer1M: 0.12 }];
    expect(resolvePrice({ provider: OPENROUTER, model: "qwen/qwen3-coder-next", customPrices: custom, now: NOW })).toMatchObject({ status: "custom", tariff: { inputPer1M: 0.12 } });
    expect(resolvePrice({ provider: { ...OPENROUTER, id: "other" }, model: "qwen/qwen3-coder-next", customPrices: custom, now: NOW }).status).toBe("unknown");
    // A custom price overrides the catalog for an Anthropic model too (the user is explicit).
    expect(resolvePrice({ provider: ANTHROPIC, model: "claude-opus-5-5", customPrices: [{ providerId: "p_anth", model: "claude-opus-5-5", inputPer1M: 1, outputPer1M: 2 }], now: NOW }).status).toBe("custom");
  });
  it("treats Ollama and loopback/private endpoints as local inference with no external charge and an unknown economic cost", () => {
    const p = resolvePrice({ provider: OLLAMA, model: "llama3.2", now: NOW });
    expect(p).toMatchObject({ status: "local", tariff: { inputPer1M: 0, outputPer1M: 0 } });
    expect(p.note).toMatch(/electricity, hardware and hosting costs are not accounted/);
    expect(resolvePrice({ provider: { type: "custom", baseUrl: "http://192.168.1.20:8080/v1" }, model: "local-model", now: NOW }).status).toBe("local");
    expect(isLocalEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLocalEndpoint("http://10.0.0.5:11434")).toBe(true);
  });
  it("prices Claude Haiku 5.5 by prompt length", () => {
    const p = resolvePrice({ provider: ANTHROPIC, model: "claude-haiku-5-5", now: NOW });
    expect(p.longPrompt).toMatchObject({ thresholdTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 });
  });
});

describe("task budget ledger: reservations and settlement", () => {
  it("reserves a realistic upper bound for an ordinary request and settles at measured cost", () => {
    const l = ledger(3);
    const r = l.reserve(request());
    // ~4.6k-token bound × $4/M + 4096 × $20/M ≈ $0.10, nowhere near the whole context window.
    expect(r.reservationUsd).toBeGreaterThan(0.05);
    expect(r.reservationUsd).toBeLessThan(0.15);
    expect(l.snapshot()).toMatchObject({ reservedUsd: r.reservationUsd, spentUsd: 0, requests: { inFlight: 1 } });
    const entry = l.settle(r, usage(1200, 300));
    expect(entry).toMatchObject({ status: "settled", costBasis: "measured", costUsd: (1200 * 4 + 300 * 20) / 1_000_000 });
    const s = l.snapshot();
    expect(s).toMatchObject({ reservedUsd: 0, spentUsd: 0.0108, unreconciledUsd: 0, inputTokens: 1200, outputTokens: 300, costBasis: "measured", remainingUsd: 3 - 0.0108 });
    expect(s.byRole["unattributed"]?.requests).toBe(1);
  });

  it("prices cached input at the cache-read rate when the provider reports it", () => {
    const l = ledger(3);
    const r = l.reserve(request());
    const e = l.settle(r, usage(10_000, 100, 8_000));
    expect(e.costUsd).toBeCloseTo((2_000 * 4 + 8_000 * 0.2 + 100 * 20) / 1_000_000, 9);
    expect(l.snapshot().cachedPromptTokens).toBe(8_000);
  });

  it("refuses, before dispatch, a request whose reservation would exceed the remaining budget — exactly at the limit is allowed", () => {
    const l = ledger(0.2);
    const r1 = l.reserve(request());
    l.settle(r1, usage(1000, 1000)); // $0.024
    const tooBig = request({ maxTokens: 16_000 }); // ≈ $0.34 output alone
    expect(() => l.reserve(tooBig)).toThrow(BudgetRefusedError);
    try { l.reserve(tooBig); } catch (e) {
      const d = (e as BudgetRefusedError).decision;
      expect(d.kind).toBe("refused_limit");
      expect(d.reason).toMatch(/would exceed the remaining task budget/);
      expect(d.reason).toMatch(/raise the task budget in Settings/);
    }
    // Nothing was charged by the refusal; the ledger is still usable.
    expect(l.snapshot().requests.refused).toBe(2);
    expect(l.snapshot().blocked).toBeUndefined();
    const exact = ledger(0.1);
    const d = exact.decide(request({ messages: messages(1000), maxTokens: 4096 }));
    expect(d.allowed).toBe(true);
    const atLimit = new TaskBudgetLedger({ taskId: "t", limitUsd: d.reservationUsd!, now: () => NOW });
    expect(atLimit.reserve(request({ messages: messages(1000), maxTokens: 4096 })).reservationUsd).toBe(d.reservationUsd);
  });

  it("refuses under a hard budget when pricing is unknown, stale, or the request is unbounded, with an actionable reason", () => {
    const l = ledger(3);
    expect(l.decide(request({ provider: OPENROUTER, model: "openai/gpt-4o-mini" }))).toMatchObject({ kind: "refused_pricing_unknown", allowed: false });
    expect(l.decide(request({ provider: OPENROUTER, model: "openai/gpt-4o-mini" })).reason).toMatch(/set a custom price/);
    const stale = new TaskBudgetLedger({ taskId: "t", limitUsd: 3, now: () => new Date("2027-06-01T00:00:00Z") });
    expect(stale.decide(request()).kind).toBe("refused_pricing_unknown");
    expect(l.decide(request({ maxTokens: 0 })).kind).toBe("refused_invalid_request");
    expect(l.decide(request({ maxTokens: 200_000 })).kind).toBe("refused_invalid_request");
    expect(l.decide(request({ messages: [{ role: "user", content: 1 as unknown as string }] })).kind).toBe("refused_invalid_request");
  });

  it("without a hard budget it accounts and estimates but never refuses, and says when an estimate is unavailable", () => {
    const l = ledger(null);
    expect(l.decide(request())).toMatchObject({ kind: "no_hard_budget", allowed: true });
    const d = l.decide(request({ provider: OPENROUTER, model: "openai/gpt-4o-mini" }));
    expect(d).toMatchObject({ kind: "no_hard_budget", allowed: true });
    expect(d.reservationUsd).toBeUndefined();
    expect(d.reason).toMatch(/cost estimate unavailable/);
    const r = l.reserve(request({ provider: OPENROUTER, model: "openai/gpt-4o-mini" }));
    const e = l.settle(r, usage(500, 50));
    expect(e).toMatchObject({ status: "settled", costBasis: "none", usage: usage(500, 50) });
    expect(l.snapshot()).toMatchObject({ limitUsd: null, remainingUsd: null, inputTokens: 500, unpricedRequests: 1 });
  });

  it("local inference reserves $0 external cost and is allowed under a hard budget, labelled", () => {
    const l = ledger(1);
    const r = l.reserve(request({ provider: OLLAMA, model: "llama3.2" }));
    expect(r.reservationUsd).toBe(0);
    l.settle(r, usage(100, 100));
    expect(l.snapshot().spentUsd).toBe(0);
    expect(l.snapshot().notes.join(" ")).toMatch(/local inference/);
  });
});

describe("task budget ledger: unknown outcomes and overruns", () => {
  it("a request sent without usage is charged its upper bound as unreconciled and blocks further paid requests under a hard budget", () => {
    const l = ledger(3);
    const r = l.reserve(request());
    const e = l.settle(r, null);
    expect(e).toMatchObject({ status: "unreconciled", costBasis: "upper_bound", costUsd: r.reservationUsd });
    const s = l.snapshot();
    expect(s.unreconciledUsd).toBe(r.reservationUsd);
    expect(s.spentUsd).toBe(0);
    expect(s.blocked?.kind).toBe("refused_unreconciled");
    expect(() => l.reserve(request())).toThrow(/budget is blocked/);
    // Without a hard budget the uncertainty is recorded but nothing is blocked.
    const soft = ledger(null);
    soft.settle(soft.reserve(request()), null);
    expect(soft.snapshot().blocked).toBeUndefined();
    expect(soft.snapshot().costBasis).toBe("upper_bound");
  });

  it("a network failure or cancellation after dispatch keeps the bound charged; a cancellation before dispatch charges nothing", () => {
    const l = ledger(3);
    const r = l.reserve(request());
    l.markUnreconciled(r, "network failure");
    expect(l.snapshot().unreconciledUsd).toBe(r.reservationUsd);
    const soft = ledger(3);
    const r2 = soft.reserve(request());
    soft.release(r2, "cancelled before dispatch");
    expect(soft.snapshot()).toMatchObject({ unreconciledUsd: 0, reservedUsd: 0, requests: { released: 1 } });
    expect(soft.snapshot().blocked).toBeUndefined();
  });

  it("a response that exceeds its reservation is recorded at its true cost and blocks further spending", () => {
    const l = ledger(3);
    const r = l.reserve(request({ messages: messages(100), maxTokens: 100 }));
    const e = l.settle(r, usage(50_000, 100)); // far more input than the bound
    expect(e.costUsd).toBeCloseTo((50_000 * 4 + 100 * 20) / 1_000_000, 9);
    expect(e.notes.join(" ")).toMatch(/exceeded the reservation/);
    expect(l.snapshot().spentUsd).toBe(e.costUsd);
    expect(l.snapshot().blocked?.reason).toMatch(/more than its .* reservation/);
  });

  it("inconsistent usage is unreconciled, a different response model is noted", () => {
    const l = ledger(3);
    const r = l.reserve(request());
    expect(l.settle(r, { promptTokens: 10, completionTokens: 10, totalTokens: 99 }).status).toBe("unreconciled");
    const l2 = ledger(3);
    const e = l2.settle(l2.reserve(request()), usage(10, 10), "claude-opus-5");
    expect(e.responseModel).toBe("claude-opus-5");
    expect(e.notes.join(" ")).toMatch(/answered with claude-opus-5/);
  });
});

describe("task budget ledger: concurrency", () => {
  it("concurrent reservations share one ledger and cannot oversubscribe it", async () => {
    // $3 budget: Brain ≈ $0.40, two workers each ≈ $1.50 → only one worker fits.
    const l = ledger(3);
    const brainReq = request({ model: "claude-sonnet-5-5", messages: messages(60_000), maxTokens: 24_000, role: "brain" }); // ≈ 0.13 + 0.24
    const workerReq = request({ messages: messages(200_000), maxTokens: 30_000, role: "worker" }); // ≈ 0.88 + 0.60
    const brain = l.reserve(brainReq);
    const outcomes = await Promise.all([1, 2].map(async () => { try { return l.reserve(workerReq); } catch (e) { return e as BudgetRefusedError; } }));
    const admitted = outcomes.filter((o) => !(o instanceof BudgetRefusedError));
    const refused = outcomes.filter((o) => o instanceof BudgetRefusedError) as BudgetRefusedError[];
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.decision.kind).toBe("refused_limit");
    const s = l.snapshot();
    expect(s.reservedUsd).toBeLessThanOrEqual(3);
    expect(s.reservedUsd).toBeCloseTo(brain.reservationUsd + (admitted[0] as { reservationUsd: number }).reservationUsd, 9);
  });

  it("many concurrent small requests never push accounted + reserved over the limit", async () => {
    const l = ledger(0.5);
    const req = request({ messages: messages(2000), maxTokens: 2048 }); // ≈ $0.05 each
    let admitted = 0;
    await Promise.all(Array.from({ length: 40 }, async () => {
      try { const r = l.reserve(req); admitted++; await Promise.resolve(); l.settle(r, usage(600, 200)); } catch { /* refused */ }
    }));
    expect(admitted).toBeGreaterThan(5);
    expect(admitted).toBeLessThan(40);
    const s = l.snapshot();
    expect(s.spentUsd + s.unreconciledUsd + s.reservedUsd).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("repairs and fallbacks reuse the task's remaining budget rather than a fresh one", () => {
    const l = ledger(0.3);
    const first = l.reserve(request({ role: "engineer", stage: "initial" }));
    l.settle(first, usage(4000, 4000)); // $0.096
    const fallback = l.reserve(request({ model: "claude-sonnet-5-5", role: "engineer", stage: "fallback" }));
    l.settle(fallback, usage(4000, 2000)); // $0.028
    expect(l.snapshot().remainingUsd).toBeCloseTo(0.3 - 0.096 - 0.028, 9);
    expect(() => l.reserve(request({ role: "engineer", stage: "repair", maxTokens: 8192 }))).toThrow(BudgetRefusedError);
    expect(l.snapshot().byRole["engineer"]?.requests).toBe(2);
  });

  it("mirrors settled and unreconciled costs into a parent session ledger without enforcing there", () => {
    const session = ledger(null, { taskId: "session" });
    const task = ledger(1, { parent: session });
    task.settle(task.reserve(request()), usage(1000, 1000));
    task.markUnreconciled(task.reserve(request()), "network");
    expect(session.snapshot().spentUsd).toBe(0.024);
    expect(session.snapshot().unreconciledUsd).toBeGreaterThan(0);
    expect(session.snapshot().blocked).toBeUndefined();
  });
});

describe("budgeted adapter", () => {
  const fake = (response: Partial<LLMResponse> | Error, delay = 0): LLMAdapter & { calls: LLMRequest[] } => {
    const calls: LLMRequest[] = [];
    const answer = async (r: LLMRequest): Promise<LLMResponse> => {
      calls.push(r);
      if (delay) await new Promise((res) => setTimeout(res, delay));
      if (response instanceof Error) throw response;
      return { content: "ok", model: r.model || "claude-opus-5-5", usage: usage(100, 10), durationMs: 1, ...response };
    };
    return { name: "fake", calls, complete: answer, stream: async (r, onToken) => { onToken("ok"); return answer(r); } };
  };
  const req: LLMRequest = { model: "", messages: messages(1000), temperature: 0, maxTokens: 1024 };

  it("accounts every request made inside the task scope, attributed to its role and stage", async () => {
    const l = ledger(3);
    const adapter = budgetedAdapter(fake({}), { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await runWithBudget(l, () => withBudgetAttribution({ role: "brain", stage: "brain_route" }, () => adapter.complete(req)));
    await runWithBudget(l, () => withBudgetAttribution({ role: "engineer", stage: "agent_iteration" }, () => adapter.stream!(req, () => {})));
    const s = l.snapshot();
    expect(s.requests).toMatchObject({ total: 2, settled: 2, inFlight: 0 });
    expect(Object.keys(s.byRole).sort()).toEqual(["brain", "engineer"]);
    expect(l.history().map((e) => e.stage)).toEqual(["brain_route", "agent_iteration"]);
  });

  it("refuses before any network activity and does not retry", async () => {
    const l = ledger(0.0001);
    const inner = fake({});
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await expect(runWithBudget(l, () => adapter.complete(req))).rejects.toBeInstanceOf(BudgetRefusedError);
    expect(inner.calls).toHaveLength(0);
  });

  it("falls back to the session ledger outside a task scope and passes through with no ledger at all", async () => {
    const session = ledger(null, { taskId: "session" });
    const adapter = budgetedAdapter(fake({}), { provider: ANTHROPIC, defaultModel: "claude-opus-5-5", fallback: () => session });
    await adapter.complete(req);
    expect(session.snapshot().requests.settled).toBe(1);
    expect(currentBudgetLedger()).toBeUndefined();
    const bare = budgetedAdapter(fake({}), { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await expect(bare.complete(req)).resolves.toMatchObject({ content: "ok" });
  });

  it("a streamed response without usage is unreconciled; a failure after dispatch keeps the bound; a cancel before dispatch is released", async () => {
    const l = ledger(3);
    const noUsage = budgetedAdapter(fake({ usage: null }), { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await runWithBudget(l, () => noUsage.stream!(req, () => {}));
    expect(l.snapshot()).toMatchObject({ requests: { unreconciled: 1 } });
    expect(l.snapshot().blocked?.kind).toBe("refused_unreconciled");

    const l2 = ledger(3);
    const failing = budgetedAdapter(fake(new Error("socket hang up")), { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await expect(runWithBudget(l2, () => failing.complete(req))).rejects.toThrow(/socket hang up/);
    expect(l2.snapshot().unreconciledUsd).toBeGreaterThan(0);

    const l3 = ledger(3);
    const controller = new AbortController();
    controller.abort();
    const inner = fake({});
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    await expect(runWithBudget(l3, () => adapter.complete({ ...req, signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(inner.calls).toHaveLength(0);
    expect(l3.snapshot()).toMatchObject({ reservedUsd: 0, unreconciledUsd: 0, requests: { released: 1 } });
  });

  it("concurrent Brain, worker and fallback calls through one scope are bounded by the limit", async () => {
    const l = ledger(0.2);
    const inner = fake({}, 5);
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    const big: LLMRequest = { ...req, messages: messages(20_000), maxTokens: 4096 }; // ≈ $0.17 each
    const results = await runWithBudget(l, () => Promise.allSettled([
      withBudgetAttribution({ role: "brain" }, () => adapter.complete({ ...req, maxTokens: 512 })),
      withBudgetAttribution({ role: "engineer" }, () => adapter.complete(big)),
      withBudgetAttribution({ role: "reviewer" }, () => adapter.complete(big)),
    ]));
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(2);
    expect(inner.calls).toHaveLength(2);
    const s = l.snapshot();
    expect(s.spentUsd + s.reservedUsd).toBeLessThanOrEqual(0.2);
  });
});

describe("Miranda before_llm_call with a budget decision", () => {
  it("blocks on every refusal kind with the kind in the reason, and passes authorized / no-hard-budget decisions", () => {
    const gate = createMirandaGate();
    const l = ledger(3);
    const refused = l.decide(request({ provider: OPENROUTER, model: "openai/gpt-4o-mini" }));
    const blocked = gate.beforeLLMCall({ stage: "agent_iteration", model: "openai/gpt-4o-mini", budgetUsed: 0, budgetLimit: 3, budget: refused });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/Budget refused_pricing_unknown/);
    const ok = gate.beforeLLMCall({ stage: "agent_iteration", model: "claude-opus-5-5", budgetUsed: 0, budgetLimit: 3, budget: l.decide(request()) });
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toMatch(/decision=authorized/);
    const soft = gate.beforeLLMCall({ stage: "x", model: "m", budgetUsed: 0, budgetLimit: Infinity, budget: ledger(null).decide(request()) });
    expect(soft.allowed).toBe(true);
    expect(soft.reason).toMatch(/decision=no_hard_budget/);
  });
});

describe("ledger performance", () => {
  it("reserves and settles thousands of requests in well under a second", () => {
    const l = ledger(10_000);
    const start = performance.now();
    for (let i = 0; i < 5000; i++) l.settle(l.reserve(request({ messages: messages(2000), maxTokens: 1024, role: `r${i % 5}` })), usage(600, 100));
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(1000);
    const snapshots: BudgetSnapshot[] = [];
    const t = performance.now();
    for (let i = 0; i < 200; i++) snapshots.push(l.snapshot());
    expect(performance.now() - t).toBeLessThan(2000);
    expect(snapshots[0]!.requests.settled).toBe(5000);
  });
});

void vi;
