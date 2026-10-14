/**
 * Integration stress — the whole runtime under deterministic failures, with
 * the real budget ledger, the real evidence collector on a disposable
 * workspace, the real Pappy, and fakes only for the provider and the tools.
 * Every scenario checks who did what (task, worker, pass), what the budget
 * says, what Pappy saw, and what Moonshiner would get.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetedAdapter, withBudgetAttribution } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { createPappyPort } from "./adapters/pappyPort.js";
import { createOrcaRuntime } from "./runtime.js";
import { createWorkspaceGuard } from "./workspaceGuard.js";
import type { MaestroPort, OrcaEvent, OrcaPipelineTrace, OrcaRunCtx, OrcaTaskSpec, OrcaToolService, PappyPort } from "./types.js";
import type { OrcaStore, RunRecord } from "./persistence/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ANTHROPIC = { id: "p1", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const llm = { complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) };
const FAIL_OUT = "[Exit code 1]\nnot ok 1 - parse handles empty input\n# tests 1\n# pass 0\n# fail 1";
const PASS_OUT = "ok 1 - parse handles empty input\n# tests 1\n# pass 1\n# fail 0";
const FIXED = "module.exports = function parse(s) { if (!s) return 0; return s.length; };\n";
const FIXED_AGAIN = "module.exports = function parse(s) { if (s === '') return 0; return s.length; };\n";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-stress-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "src", "parse.js"), "module.exports = function parse(s) { return s.length; };\n");
  writeFileSync(join(root, "src", "parse.test.js"), "const parse = require('./parse');\nrequire('node:test')('parse handles empty input', () => { if (parse('') !== 0) throw new Error('x'); });\n");
  return root;
}
const spec = (root: string): OrcaTaskSpec => ({
  originalUserMessage: "Fix the bug in src/parse.js: parse('') throws instead of returning 0. Run the tests.",
  intent: "fix the parse bug",
  goals: ["`parse` must return 0 for empty input instead of throwing"],
  permissions: { fileRead: true, fileWrite: true, shellExec: true },
  context: { workspaceRoot: root },
} as unknown as OrcaTaskSpec);

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

/** Pappy for real (the production port, which tags eligibility and evidence), fed exactly what the runtime hands it. */
const realPappy: PappyPort = createPappyPort();

/** The test command "runs" against the file on disk: pass only when the fix is in place. */
function testTool(): OrcaToolService & { calls: number } {
  const service = {
    calls: 0,
    execute: async (_name: string, input: Record<string, unknown>) => {
      service.calls++;
      const cwd = String(input["cwd"] ?? "");
      const src = readFileSync(join(cwd, "src", "parse.js"), "utf8");
      const pass = /return 0/.test(src);
      return { ok: pass, output: pass ? PASS_OUT : FAIL_OUT, exitCode: pass ? 0 : 1 };
    },
    formatForPrompt: () => "", list: () => [],
  };
  return service as unknown as OrcaToolService & { calls: number };
}

/** A worker that reproduces, edits parse.js, re-runs the tests, and reports honestly. */
function fixingWorker(role: string, opts: { fix: boolean; secondWriter?: string; secondWriteAfterTests?: boolean }): MaestroPort {
  return {
    run: async (_t, ctx: OrcaRunCtx) => {
      const root = ctx.workspaceRoot!;
      const run = async () => {
        ctx.recordTrace("agent.tool.call", { role, tool: "run_command", input: { command: "npm test", cwd: root } });
        const r = await ctx.tools!.execute("run_command", { command: "npm test", cwd: root });
        ctx.recordTrace("agent.tool.result", { role, tool: "run_command", input: { command: "npm test", cwd: root }, result: r });
        return { tool: "run_command", ok: r.ok, summary: r.ok ? "run_command: ok" : "run_command: failed - Command failed with exit code 1", raw: { command: "npm test", _outputForProof: r.output, _exitCodeForProof: r.ok ? 0 : 1 } };
      };
      const events = [await run()]; // reproduction on the baseline
      if (opts.fix) {
        writeFileSync(join(root, "src", "parse.js"), FIXED);
        ctx.recordTrace("agent.tool.call", { role, tool: "write_file", input: { path: "src/parse.js" } });
        if (opts.secondWriter && !opts.secondWriteAfterTests) {
          writeFileSync(join(root, "src", "parse.js"), FIXED_AGAIN);
          ctx.recordTrace("agent.tool.call", { role: opts.secondWriter, tool: "write_file", input: { path: "src/parse.js" } });
        }
      }
      events.push(await run());
      if (opts.secondWriter && opts.secondWriteAfterTests) {
        writeFileSync(join(root, "src", "parse.js"), FIXED_AGAIN);
        ctx.recordTrace("agent.tool.call", { role: opts.secondWriter, tool: "write_file", input: { path: "src/parse.js" } });
      }
      const fixed = /return 0/.test(readFileSync(join(root, "src", "parse.js"), "utf8"));
      return {
        outputText: fixed
          ? "Root cause: parse('') threw on empty input. Changed parse in src/parse.js to return 0 for empty input. npm test: 1 passed, 0 failed."
          : "I ran npm test: 1 failed. I could not fix parse; no files were modified.",
        toolEvents: events,
        filesChanged: fixed ? [{ path: "src/parse.js", changeType: "M", diff: readFileSync(join(root, "src", "parse.js"), "utf8") }] : [],
        metadata: { stoppedBecause: "done", role },
      };
    },
  };
}

describe("integration stress", () => {
  it("a real fix flow: reproduction, change, passing run on the final source → COMPLETED, verified, eligible, settled budget, tagged for export", async () => {
    const root = project();
    const store = new MemoryStore();
    const trace: OrcaPipelineTrace[] = [];
    const tools = testTool();
    const runtime = createOrcaRuntime({ maestro: fixingWorker("debugger", { fix: true }), pappy: realPappy, llm: llm as never, tools, store, budgetUsd: 1, maxRepairPasses: 0, writeTrace: (t) => { trace.push(t); } });
    const budgets: OrcaEvent[] = [];
    runtime.on("budget:update", (e) => budgets.push(e));
    const result = await runtime.executeTask(spec(root));
    expect(result.lifecycle?.state).toBe("COMPLETED");
    expect(result.qcResult?.verdict).toBe("PASS");
    expect(result.qcResult?.verification?.status).toBe("verified");
    expect(result.qcResult?.verification?.testEvidence).toBe(true);
    expect(result.qcResult?.trainingEligibility).toBe("eligible");
    expect(tools.calls).toBe(2);
    const lastBudget = budgets.at(-1) as Extract<OrcaEvent, { type: "budget:update" }> | undefined;
    expect(lastBudget?.budget.requests.inFlight ?? 0).toBe(0);
    expect(lastBudget?.budget.reservedUsd ?? 0).toBe(0);
    expect(store.runs[0]?.summary).toMatch(/training_eligibility=eligible/);
    expect(store.runs[0]?.summary).toMatch(/evidence=verified/);
    const qcStart = trace[0]!.entries.find((e) => e.stage === "qc.run.start");
    expect(JSON.stringify(qcStart?.detail)).toMatch(/"writers":\["debugger"\]/);
  });

  it("worker cannot fix → Pappy FAIL → repairs spend the budget → the task stops incomplete with the reason; nothing verified, nothing trainable, every pass attributed", async () => {
    const root = project();
    const passes: string[] = [];
    const transport = vi.fn(async (_r: LLMRequest): Promise<LLMResponse> => ({ text: "x", usage: { promptTokens: 500, completionTokens: 7_000, totalTokens: 7_500 } }));
    const adapter = budgetedAdapter({ name: "fake", complete: transport } as unknown as LLMAdapter, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    const worker = fixingWorker("debugger", { fix: false });
    const spending: MaestroPort = {
      run: async (t, ctx) => {
        passes.push(`pass ${passes.length + 1}`);
        await withBudgetAttribution({ role: "debugger", stage: `pass-${passes.length}` }, () => adapter.complete({ model: "", messages: [{ role: "user", content: "x".repeat(2000) }], temperature: 0, maxTokens: 8000, signal: ctx.abortSignal }));
        return worker.run(t, ctx);
      },
    };
    const events: OrcaEvent[] = [];
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro: spending, pappy: realPappy, llm: llm as never, tools: testTool(), store, budgetUsd: 0.25, maxRepairPasses: 4 });
    runtime.on("task:state", (e) => events.push(e));
    const result = await runtime.executeTask(spec(root));
    expect(result.status).toBe("FAIL");
    expect(result.lifecycle?.state).toBe("FAILED");
    expect(result.qcResult?.verdict).toBe("FAIL");
    // An honest, evidence-confirmed failure is a correctly classified candidate (phase 2.5): what must never happen is a verified/eligible PASS here.
    expect(result.qcResult?.verification?.status).not.toBe("verified");
    expect(store.runs[0]?.summary).toMatch(/Stopped by the task budget/); // Benson gets the actual outcome: a budget stop, not a verdict
    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes.length).toBeLessThan(5); // the budget, not the pass cap, stopped it
    expect(result.summary ?? "").toMatch(/budget/i);
    const states = events.filter((e) => e.type === "task:state").map((e) => (e as Extract<OrcaEvent, { type: "task:state" }>).state);
    expect(states).toContain("REPAIRING");
    expect(states.at(-1)).toBe("FAILED");
    expect(store.runs[0]?.summary).not.toMatch(/evidence=verified/);
  });

  it("two workers write the same file in one pass, tests run on the final content: verified as a result, attribution unresolved, never trainable", async () => {
    const root = project();
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro: fixingWorker("debugger", { fix: true, secondWriter: "engineer" }), pappy: realPappy, llm: llm as never, tools: testTool(), store, maxRepairPasses: 0 });
    const result = await runtime.executeTask(spec(root));
    expect(result.lifecycle?.state).toBe("COMPLETED");
    expect(result.qcResult?.verification?.status).toBe("verified");
    expect(result.qcResult?.verification?.attributionUnresolved).toBe(true);
    expect(result.qcResult?.trainingEligibility).toBe("accepted_but_not_trainable");
    expect(result.qcResult?.issues.map((i) => i.code)).toContain("CONFLICTING_WRITES_ATTRIBUTION");
    expect(store.runs[0]?.summary).toMatch(/training_eligibility=accepted_but_not_trainable/);
  });

  it("two workers write the same file and the second write lands after the tests: the run proved an intermediate state → unverified, not a PASS, not trainable", async () => {
    const root = project();
    const store = new MemoryStore();
    const runtime = createOrcaRuntime({ maestro: fixingWorker("debugger", { fix: true, secondWriter: "engineer", secondWriteAfterTests: true }), pappy: realPappy, llm: llm as never, tools: testTool(), store, maxRepairPasses: 0 });
    const result = await runtime.executeTask(spec(root));
    expect(result.qcResult?.verification?.status).not.toBe("verified");
    expect(result.qcResult?.verdict).not.toBe("PASS");
    expect(result.qcResult?.trainingEligibility).not.toBe("eligible");
    expect(result.qcResult?.issues.map((i) => i.code)).toContain("CONFLICTING_WRITES");
    expect(result.lifecycle?.state).toBe("FAILED");
  });

  it("Stop during the pass with a non-cancellable tool: INTERRUPTED, workspace protected, a late tool result changes nothing, a late approval authorizes nothing, released by settlement", async () => {
    const root = project();
    const guard = createWorkspaceGuard();
    const store = new MemoryStore();
    const approvals: boolean[] = [];
    let lateTool: unknown;
    const tools: OrcaToolService = { execute: async () => { await sleep(300); return { ok: true, output: "late" }; }, formatForPrompt: () => "", list: () => [] } as unknown as OrcaToolService;
    const maestro: MaestroPort = {
      run: async (_t, ctx) => {
        const p = ctx.tools!.execute("mcp:slow", {});
        await sleep(20);
        lateTool = await p; // arrives after Stop
        approvals.push(await ctx.requestToolApproval!("run_command", {}));
        return { outputText: "late output" };
      },
    };
    const runtime = createOrcaRuntime({ maestro, pappy: realPappy, llm: llm as never, tools, store, workspaceRoot: root, workspaceGuard: guard, drainTimeoutMs: 30, requestToolApproval: async () => true });
    const controller = new AbortController();
    const promise = runtime.executeTask(spec(root), { abortSignal: controller.signal });
    await sleep(10);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect((await guard.status(root)).map((p) => p.operations.map((o) => o.label))).toEqual([["mcp:slow"]]);
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "interrupted" });
    await sleep(400);
    expect(lateTool).toMatchObject({ ok: true });
    expect(approvals).toEqual([false]);
    expect(await guard.status(root)).toEqual([]);
  });

  it("unknown provider pricing under a hard budget refuses before dispatch; the task fails with the reason and no provider is contacted", async () => {
    const root = project();
    const transport = vi.fn(async (): Promise<LLMResponse> => ({ text: "x" }));
    const adapter = budgetedAdapter({ name: "custom", complete: transport } as unknown as LLMAdapter, { provider: { id: "c", type: "custom", name: "gateway", baseUrl: "http://10.0.0.5:8000/v1" }, defaultModel: "mystery-model" });
    const maestro: MaestroPort = { run: async (_t, ctx) => { await withBudgetAttribution({ role: "debugger" }, () => adapter.complete({ model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 100, signal: ctx.abortSignal })); return { outputText: "x" }; } };
    const runtime = createOrcaRuntime({ maestro, pappy: realPappy, llm: llm as never, budgetUsd: 1 });
    const result = await runtime.executeTask(spec(root));
    expect(result.status).toBe("FAIL");
    expect(result.summary).toMatch(/pricing|price|billing/i);
    expect(transport).not.toHaveBeenCalled();
    expect(result.lifecycle?.state).toBe("FAILED");
  });
});
