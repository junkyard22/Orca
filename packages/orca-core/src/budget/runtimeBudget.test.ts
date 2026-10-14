/**
 * Budget enforcement through the runtime: one ledger per task, every model
 * request accounted whichever path makes it, refusals before dispatch,
 * repairs and fallbacks sharing the remaining budget, honest reporting when
 * the budget stops the work. No provider is contacted: adapters are fakes with
 * recorded usage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetRefusedError, TaskBudgetLedger, budgetedAdapter, currentBudgetLedger, withBudgetAttribution } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { createOrcaRuntime } from "../runtime.js";
import { createBudgetJournal } from "./journal.js";
import type { MaestroPort, OrcaEvent, OrcaMaestroResult, OrcaRunCtx, OrcaTaskSpec, PappyPort } from "../types.js";
import type { OrcaStore, RunRecord } from "../persistence/types.js";

const ANTHROPIC = { id: "p1", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeAdapter(opts: { promptTokens?: number; completionTokens?: number; fail?: Error; usage?: null; model?: string } = {}): LLMAdapter & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const answer = async (r: LLMRequest): Promise<LLMResponse> => {
    calls.push(r);
    if (opts.fail) throw opts.fail;
    const promptTokens = opts.promptTokens ?? 800;
    const completionTokens = opts.completionTokens ?? 200;
    return { content: "FINAL ANSWER: done", model: opts.model ?? (r.model || "claude-sonnet-5-5"), usage: opts.usage === null ? null : { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, durationMs: 1 };
  };
  return { name: "fake", calls, complete: answer, stream: async (r, onToken) => { onToken("FINAL ANSWER: done"); return answer(r); } };
}

const request = (chars = 2000, maxTokens = 2048): LLMRequest => ({ model: "", messages: [{ role: "system", content: "sys" }, { role: "user", content: "x".repeat(chars) }], temperature: 0, maxTokens });
const pass = (verdict: "PASS" | "FAIL") => ({ verdict, trainingEligibility: "accepted_but_not_trainable" as const, confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: verdict === "FAIL" ? [{ issueId: "x", severity: "HIGH" as const, code: "REQUIRED_RECEIPT_MISSING", category: "Proof" as const, description: "missing", expected_receipt: "", evidence: "", fix_hint: "fix", message: "missing" }] : [], repair_task: verdict === "FAIL" ? { title: "repair", steps: ["fix"], required_proofs: [] } : null, repairTask: verdict === "FAIL" ? "repair" : undefined, internalSummary: `verdict=${verdict}` });
const spec = { originalUserMessage: "Add a feature", intent: "add", goals: [], permissions: { fileRead: true, fileWrite: true, shellExec: false } } as unknown as OrcaTaskSpec;
const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });

/** A Maestro that calls a budgeted adapter like the desktop's agents do. */
function maestroUsing(adapter: LLMAdapter, calls: Array<{ role: string; req?: LLMRequest }>): MaestroPort {
  return {
    run: async (_task, _ctx: OrcaRunCtx): Promise<OrcaMaestroResult> => {
      let outputText = "";
      let error: string | undefined;
      for (const c of calls) {
        try {
          const r = await withBudgetAttribution({ role: c.role, stage: "agent_iteration" }, () => adapter.complete(c.req ?? request()));
          outputText = r.content;
        } catch (e) {
          if (e instanceof BudgetRefusedError) { error = e.message; break; }
          throw e;
        }
      }
      return { outputText, toolEvents: [], filesChanged: [], metadata: { role: calls[0]?.role, stoppedBecause: error ? "error" : "done", errorMessage: error } };
    },
  };
}

class MemoryStore implements OrcaStore {
  runs: RunRecord[] = [];
  saveRun(run: RunRecord) { this.runs.push(run); }
  getRecentRuns() { return this.runs; }
  getRun(id: string) { return this.runs.find((r) => r.id === id) ?? null; }
  getRunThoughts() { return []; }
  getRunToolEvents() { return []; }
  deleteRun() {}
  searchRuns() { return []; }
  getStats() { return { totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 }; }
  close() {}
}

describe("runtime budget enforcement", () => {
  it("accounts an affordable task end to end: ledger per task, metadata, events, trace, summary, store", async () => {
    const adapter = budgetedAdapter(fakeAdapter(), { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    const events: OrcaEvent[] = [];
    const store = new MemoryStore();
    let trace: unknown;
    const runtime = createOrcaRuntime({
      maestro: maestroUsing(adapter, [{ role: "brain" }, { role: "engineer" }]),
      pappy: { evaluate: () => pass("PASS") } as PappyPort,
      llm: makeLLM() as never, budgetUsd: 1, budgetSource: "user", store, writeTrace: (t) => { trace = t; },
    });
    for (const type of ["budget:update", "pipeline:summary", "task:done"] as const) runtime.on(type, (e) => events.push(e));
    const result = await runtime.executeTask(spec);
    expect(result.status).toBe("SUCCESS");
    const summary = events.find((e) => e.type === "pipeline:summary") as Extract<OrcaEvent, { type: "pipeline:summary" }>;
    const cost = 2 * (800 * 2 + 200 * 10) / 1_000_000; // two Sonnet 5.5 requests
    expect(summary.budget).toMatchObject({ limitUsd: 1, limitSource: "user", spentUsd: cost, unreconciledUsd: 0, reservedUsd: 0, costBasis: "measured", requests: { settled: 2 } });
    expect(Object.keys(summary.budget!.byRole).sort()).toEqual(["brain", "engineer"]);
    expect(events.filter((e) => e.type === "budget:update").length).toBeGreaterThanOrEqual(4);
    expect(store.runs[0]).toMatchObject({ costUsd: cost, costBasis: "measured", inputTokens: 1600, outputTokens: 400 });
    const stages = (trace as { entries: Array<{ stage: string }> }).entries.map((e) => e.stage);
    expect(stages).toEqual(expect.arrayContaining(["budget.task", "budget.reserved", "budget.settled", "budget.final"]));
    expect((trace as { finalResult: { budget: { spentUsd: number } } }).finalResult.budget.spentUsd).toBe(cost);
  });

  it("stops halfway through a task when the budget cannot cover the next request, reports it as incomplete and skips repairs", async () => {
    const inner = fakeAdapter({ promptTokens: 3000, completionTokens: 2000 });
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-opus-5-5" });
    // Opus 5.5: each request reserves ≈ 3k×$4/M + 2048×$20/M ≈ $0.054 and settles at $0.052; a $0.08 budget admits one.
    const pappy = { evaluate: vi.fn(() => pass("FAIL")) } as unknown as PappyPort;
    const runtime = createOrcaRuntime({ maestro: maestroUsing(adapter, [{ role: "engineer" }, { role: "engineer" }, { role: "engineer" }]), pappy, llm: makeLLM() as never, budgetUsd: 0.08 });
    const result = await runtime.executeTask(spec);
    expect(inner.calls).toHaveLength(1);
    expect(result.status).toBe("FAIL");
    expect(result.summary).toMatch(/Stopped by the task budget/);
    expect(result.summary).toMatch(/would exceed the remaining task budget/);
    expect(result.summary).toMatch(/not verified/);
    // Pappy judged the partial pass once; no repair pass spent anything.
    expect((pappy.evaluate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("a Pappy rejection followed by a repair, and a fallback model, draw on the same remaining budget", async () => {
    const inner = fakeAdapter({ promptTokens: 1000, completionTokens: 500 });
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    let verdicts = ["FAIL", "PASS"] as const;
    const pappy = { evaluate: () => pass(verdicts[0] ?? "PASS") } as PappyPort;
    let passNo = 0;
    const maestro: MaestroPort = {
      run: async () => {
        passNo++;
        // First pass: the primary model fails, the fallback answers; repair pass: one call.
        if (passNo === 1) {
          await withBudgetAttribution({ role: "engineer", stage: "primary" }, () => adapter.complete(request()));
          await withBudgetAttribution({ role: "engineer", stage: "fallback" }, () => adapter.complete({ ...request(), model: "claude-opus-5-5" }));
        } else {
          verdicts = ["PASS"];
          await withBudgetAttribution({ role: "engineer", stage: "repair" }, () => adapter.complete(request()));
        }
        return { outputText: "FINAL ANSWER", toolEvents: [], filesChanged: [], metadata: { role: "engineer", stoppedBecause: "done" } };
      },
    };
    const events: OrcaEvent[] = [];
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, budgetUsd: 1, store });
    runtime.on("pipeline:summary", (e) => events.push(e));
    const result = await runtime.executeTask(spec);
    expect(result.status).toBe("SUCCESS");
    const budget = (events[0] as Extract<OrcaEvent, { type: "pipeline:summary" }>).budget!;
    expect(budget.requests.settled).toBe(3);
    const sonnet = (1000 * 2 + 500 * 10) / 1_000_000;
    const opus = (1000 * 4 + 500 * 20) / 1_000_000;
    expect(budget.spentUsd).toBeCloseTo(sonnet * 2 + opus, 9);
    expect(budget.byProvider["Anthropic"]?.requests).toBe(3);
    // The persisted run carries the whole task's account (all three requests
    // across both passes), not the last pass's metadata — the 1.7.0 rehearsal
    // found a repaired task stored at the repair pass's cost alone.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.costUsd).toBeCloseTo(sonnet * 2 + opus, 9);
    expect(store.runs[0]).toMatchObject({ inputTokens: 3000, outputTokens: 1500, costBasis: "measured", repairPasses: 1 });
    expect(store.runs[0]!.costUnreconciledUsd).toBeUndefined();
  });

  it("a cancellation after dispatch leaves the request unreconciled and blocks the rest of the task", async () => {
    const controller = new AbortController();
    const inner: LLMAdapter = { name: "slow", complete: (r) => new Promise((_res, rej) => { r.signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }); setTimeout(() => controller.abort(), 5); }) };
    const adapter = budgetedAdapter(inner, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    const maestro: MaestroPort = { run: async (_t, ctx) => { await adapter.complete({ ...request(), signal: ctx.abortSignal }); return { outputText: "" }; } };
    const journalPath = join((() => { const d = mkdtempSync(join(tmpdir(), "orca-budget-")); dirs.push(d); return d; })(), "journal.json");
    const journal = createBudgetJournal(journalPath);
    const events: OrcaEvent[] = [];
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, budgetUsd: 1, budgetJournal: journal, store });
    runtime.on("budget:update", (e) => events.push(e));
    await expect(runtime.executeTask(spec, { abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const last = events[events.length - 1] as Extract<OrcaEvent, { type: "budget:update" }>;
    expect(last.budget.unreconciledUsd).toBeGreaterThan(0);
    expect(last.budget.blocked?.kind).toBe("refused_unreconciled");
    // The task ended (even by abort), so the journal has nothing left to recover.
    expect(journal.recover()).toEqual([]);
    // The stopped run is persisted with its account, not with nothing: the
    // cancelled request's upper bound is kept, and the summary says it stopped.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "cancelled", costBasis: "upper_bound" });
    expect(store.runs[0]!.costUnreconciledUsd).toBeCloseTo(last.budget.unreconciledUsd, 9);
    expect(store.runs[0]!.summary).toMatch(/^Stopped before completion \(cancelled/);
  });

  it("a Brain request refused outright (unknown pricing) fails the task with the reason, before any provider call", async () => {
    const inner = fakeAdapter();
    const adapter = budgetedAdapter(inner, { provider: { id: "or", type: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, defaultModel: "openai/gpt-4o-mini" });
    const maestro: MaestroPort = { run: async () => { await withBudgetAttribution({ role: "brain" }, () => adapter.complete(request())); return { outputText: "" }; } };
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, budgetUsd: 3 });
    const result = await runtime.executeTask(spec);
    expect(inner.calls).toHaveLength(0);
    expect(result.status).toBe("FAIL");
    expect(result.summary).toMatch(/pricing unknown for openai\/gpt-4o-mini on OpenRouter/);
    expect(result.summary).toMatch(/set a custom price/);
  });

  it("without a hard budget the same requests run and are accounted, and unknown prices only annotate", async () => {
    const inner = fakeAdapter();
    const adapter = budgetedAdapter(inner, { provider: { id: "or", type: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, defaultModel: "openai/gpt-4o-mini" });
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro: maestroUsing(adapter, [{ role: "brain" }]), pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, budgetUsd: 0 });
    runtime.on("pipeline:summary", (e) => events.push(e));
    const result = await runtime.executeTask(spec);
    expect(result.status).toBe("SUCCESS");
    expect(inner.calls).toHaveLength(1);
    const budget = (events[0] as Extract<OrcaEvent, { type: "pipeline:summary" }>).budget!;
    expect(budget).toMatchObject({ limitUsd: null, remainingUsd: null, inputTokens: 800, unpricedRequests: 1 });
    expect(budget.notes.join(" ")).toMatch(/no reviewed price/);
  });

  it("reuses a ledger the shell opened for the whole interaction instead of creating a second budget", async () => {
    const outer = new TaskBudgetLedger({ taskId: "message-1", limitUsd: 0.5 });
    const adapter = budgetedAdapter(fakeAdapter(), { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    let seen: TaskBudgetLedger | undefined;
    const maestro: MaestroPort = { run: async (_t, ctx) => { seen = ctx.budget; expect(currentBudgetLedger()).toBe(outer); await adapter.complete(request()); return { outputText: "ok" }; } };
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, budgetUsd: 99 });
    const { runWithBudget } = await import("@clawde/miranda-core");
    await runWithBudget(outer, () => runtime.executeTask(spec));
    expect(seen).toBe(outer);
    expect(outer.snapshot().requests.settled).toBe(1);
    expect(outer.limitUsd).toBe(0.5);
  });
});
