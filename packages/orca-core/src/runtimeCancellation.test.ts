/**
 * Cancellation through the runtime: Stop is a request, operations settle,
 * and nothing dispatches, verifies or repairs after it. Workers, tools and
 * models are fakes with controllable timing; no provider is contacted.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskBudgetLedger, budgetedAdapter, withBudgetAttribution } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { createOrcaRuntime } from "./runtime.js";
import type { MaestroPort, OrcaEvent, OrcaRunCtx, OrcaTaskSpec, OrcaToolService, PappyPort } from "./types.js";
import type { OrcaStore, RunRecord } from "./persistence/types.js";

const ANTHROPIC = { id: "p1", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const spec = { originalUserMessage: "Fix the bug in src/a.js", intent: "fix", goals: ["a must be 2"], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
const pass = (verdict: "PASS" | "FAIL") => ({ verdict, trainingEligibility: "accepted_but_not_trainable" as const, confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: verdict === "FAIL" ? [{ issueId: "x", severity: "HIGH" as const, code: "REQUIRED_RECEIPT_MISSING", category: "Proof" as const, description: "missing", expected_receipt: "", evidence: "", fix_hint: "fix", message: "missing" }] : [], repair_task: verdict === "FAIL" ? { title: "repair", steps: ["fix"], required_proofs: [] } : null, repairTask: verdict === "FAIL" ? "repair" : undefined, internalSummary: `verdict=${verdict}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** A tool service whose command tool honours the abort signal after `ms`, or never when `hangs`. */
function tools(opts: { ms: number; hangs?: boolean; log: string[] }): OrcaToolService {
  return {
    execute: async (name) => {
      opts.log.push(`start:${name}`);
      await sleep(opts.ms);
      if (!opts.hangs) opts.log.push(`end:${name}`);
      return { ok: true, output: "done" };
    },
    formatForPrompt: () => "",
    list: () => [],
  } as unknown as OrcaToolService;
}

function states(events: OrcaEvent[]): string[] {
  return events.filter((e) => e.type === "task:state").map((e) => (e as Extract<OrcaEvent, { type: "task:state" }>).state);
}

describe("runtime cancellation", () => {
  it("Stop during a worker: the task is CANCELLING until the tool settles, then CANCELLED; no QC, no repair, record says cancelled", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const pappy = { evaluate: vi.fn(() => pass("FAIL")) } as unknown as PappyPort;
    const maestro: MaestroPort = {
      run: async (_t, ctx: OrcaRunCtx) => {
        const r = await ctx.tools!.execute("run_command", { command: "npm test" });
        log.push(`result:${r.ok}`);
        return { outputText: "" };
      },
    };
    const store = new MemoryStore();
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, tools: tools({ ms: 60, log }), store, drainTimeoutMs: 1000 });
    runtime.on("task:state", (e) => events.push(e));
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(10);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(states(events)).toEqual(["RUNNING", "CANCELLING", "CANCELLED"]);
    expect(log).toEqual(["start:run_command", "end:run_command", "result:true"]);
    expect(pappy.evaluate).not.toHaveBeenCalled();
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "cancelled" });
  });

  it("an operation that will not settle leaves the task INTERRUPTED, naming it, instead of pretending it stopped", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const maestro: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { await ctx.tools!.execute("mcp:browser_navigate", {}); return { outputText: "" }; } };
    const events: OrcaEvent[] = [];
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, tools: tools({ ms: 5000, hangs: true, log }), store, drainTimeoutMs: 50 });
    runtime.on("task:state", (e) => events.push(e));
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(10);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(states(events)).toEqual(["RUNNING", "CANCELLING", "INTERRUPTED"]);
    const last = events[events.length - 1] as Extract<OrcaEvent, { type: "task:state" }>;
    expect(last.unsettledOperations).toEqual(["tool mcp:browser_navigate"]);
    expect(store.runs[0]).toMatchObject({ stoppedBecause: "interrupted" });
  });

  it("after cancellation no tool runs and no approval authorizes, even when a late callback asks", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const approvals: string[] = [];
    let lateToolResult: { ok: boolean; error?: string } | undefined;
    let lateApproval: boolean | undefined;
    const maestro: MaestroPort = {
      run: async (_t, ctx: OrcaRunCtx) => {
        await ctx.tools!.execute("read_file", {});
        // Simulate a late model callback that tries to act after Stop.
        await sleep(30);
        lateToolResult = await ctx.tools!.execute("write_file", {});
        lateApproval = await ctx.requestToolApproval!("run_command", {});
        return { outputText: "" };
      },
    };
    const runtime = createOrcaRuntime({
      maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never,
      tools: tools({ ms: 5, log }), requestToolApproval: async (tool) => { approvals.push(tool); return true; }, drainTimeoutMs: 500,
    });
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(12);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await sleep(80); // the stopped worker's late callback runs now
    expect(log).toEqual(["start:read_file", "end:read_file"]);
    expect(lateToolResult).toMatchObject({ ok: false, error: expect.stringMatching(/not run: the task is cancell/) });
    expect(lateApproval).toBe(false);
    expect(approvals).toEqual([]);
  });

  it("Stop while waiting for approval: the wait is tracked, the task is CANCELLING, a late approval authorizes nothing", async () => {
    const controller = new AbortController();
    let resolveApproval!: (v: boolean) => void;
    let outcome: boolean | undefined;
    const maestro: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { outcome = await ctx.requestToolApproval!("run_command", {}); return { outputText: "" }; } };
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, requestToolApproval: () => new Promise((r) => { resolveApproval = r; }), drainTimeoutMs: 500 });
    runtime.on("task:state", (e) => events.push(e));
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(10);
    expect(states(events)).toEqual(["RUNNING", "WAITING_FOR_APPROVAL"]);
    controller.abort(new Error("Stopped."));
    await sleep(5);
    resolveApproval(true); // the user clicks Approve after pressing Stop
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(outcome).toBe(false);
    expect(states(events)).toEqual(["RUNNING", "WAITING_FOR_APPROVAL", "CANCELLING", "CANCELLED"]);
  });

  it("Stop during verification or repair cannot produce a verified result; a budget reservation in flight stays accounted", async () => {
    const controller = new AbortController();
    const adapter = budgetedAdapter({ name: "slow", complete: (r: LLMRequest) => new Promise<LLMResponse>((_res, rej) => r.signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); })) } as LLMAdapter, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    let passNo = 0;
    const maestro: MaestroPort = {
      run: async (_t, ctx: OrcaRunCtx) => {
        passNo++;
        if (passNo === 1) return { outputText: "first attempt", metadata: { stoppedBecause: "done" } };
        // Repair pass: a model request that is cancelled mid-flight.
        await withBudgetAttribution({ role: "engineer" }, () => adapter.complete({ model: "", messages: [{ role: "user", content: "fix" }], temperature: 0, maxTokens: 256, signal: ctx.abortSignal }));
        return { outputText: "repaired" };
      },
    };
    const pappy = { evaluate: vi.fn(() => pass("FAIL")) } as unknown as PappyPort;
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, budgetUsd: 1, drainTimeoutMs: 500 });
    runtime.on("task:state", (e) => events.push(e));
    runtime.on("budget:update", (e) => events.push(e));
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(15);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(states(events)).toEqual(["RUNNING", "VERIFYING", "REPAIRING", "RUNNING", "CANCELLING", "CANCELLED"]);
    expect(pappy.evaluate).toHaveBeenCalledTimes(1);
    const budget = [...events].reverse().find((e) => e.type === "budget:update") as Extract<OrcaEvent, { type: "budget:update" }>;
    expect(budget.budget.unreconciledUsd).toBeGreaterThan(0);
    expect(budget.budget.requests.inFlight).toBe(0);
  });

  it("two simultaneous Stop requests produce one cancellation", async () => {
    const controller = new AbortController();
    const maestro: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { await ctx.tools!.execute("x", {}); return { outputText: "" }; } };
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: () => pass("PASS") } as PappyPort, llm: makeLLM() as never, tools: tools({ ms: 30, log: [] }), drainTimeoutMs: 500 });
    runtime.on("task:state", (e) => events.push(e));
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(5);
    controller.abort(new Error("Stopped."));
    controller.abort(new Error("Stopped again."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(states(events)).toEqual(["RUNNING", "CANCELLING", "CANCELLED"]);
  });

  it("a task ends COMPLETED only when it succeeded and QC did not fail; a FAIL verdict is FAILED, never verified", async () => {
    const run = async (verdict: "PASS" | "FAIL") => {
      const events: OrcaEvent[] = [];
      const runtime = createOrcaRuntime({ maestro: { run: async () => ({ outputText: "ok" }) }, pappy: { evaluate: () => pass(verdict) } as PappyPort, llm: makeLLM() as never, maxRepairPasses: 0 });
      runtime.on("task:state", (e) => events.push(e));
      runtime.on("pipeline:summary", (e) => events.push(e));
      await runtime.executeTask(spec);
      const summary = events.find((e) => e.type === "pipeline:summary") as Extract<OrcaEvent, { type: "pipeline:summary" }>;
      return { states: states(events), lifecycle: summary.lifecycle?.state };
    };
    expect(await run("PASS")).toEqual({ states: ["RUNNING", "VERIFYING", "COMPLETED"], lifecycle: "COMPLETED" });
    expect(await run("FAIL")).toEqual({ states: ["RUNNING", "VERIFYING", "FAILED"], lifecycle: "FAILED" });
  });

  it("Pappy judges a quiet workspace: evidence collected while an operation is still active is marked partial", async () => {
    const seen: Array<{ workspace?: { partial?: boolean; reason?: string } }> = [];
    const maestro: MaestroPort = {
      run: async (_t, ctx: OrcaRunCtx) => {
        // A fire-and-forget tool run that is still active when the pass returns.
        void ctx.tools!.execute("background_write", {});
        await sleep(5);
        return { outputText: "done" };
      },
    };
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "orca-lifecycle-"));
    writeFileSync(join(root, "a.txt"), "x");
    const runtime = createOrcaRuntime({ maestro, pappy: { evaluate: vi.fn((input) => { seen.push(input as never); return pass("PASS"); }) } as unknown as PappyPort, llm: makeLLM() as never, tools: tools({ ms: 200, log: [] }), workspaceRoot: root, maxRepairPasses: 0 });
    await runtime.executeTask(spec);
    expect(seen[0]?.workspace?.partial).toBe(true);
    expect(seen[0]?.workspace?.reason).toMatch(/1 operation\(s\) still active while verifying: tool background_write/);
  });
});
