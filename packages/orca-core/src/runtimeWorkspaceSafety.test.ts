/**
 * Runtime × workspace guard: a task that ends with work still running leaves
 * its workspace protected; the next task in that workspace is refused before
 * any model is called; late callbacks of a stopped task cannot act.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrcaRuntime } from "./runtime.js";
import { createWorkspaceGuard, WorkspaceProtectedError } from "./workspaceGuard.js";
import type { MaestroPort, OrcaEvent, OrcaRunCtx, OrcaTaskSpec, OrcaToolService, PappyPort } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spec = { originalUserMessage: "Fix the bug in src/a.js", intent: "fix", goals: ["a must be 2"], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
const pass = (verdict: "PASS" | "FAIL") => ({ verdict, trainingEligibility: "accepted_but_not_trainable" as const, confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: [], repair_task: null, internalSummary: `verdict=${verdict}` });
const pappyPass = { evaluate: () => pass("PASS") } as unknown as PappyPort;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-ws-safety-"));
  writeFileSync(join(root, "a.txt"), "x");
  return root;
}

describe("runtime workspace safety", () => {
  it("a tool that ignores Stop keeps writing after the task is INTERRUPTED: the workspace is protected, the next task is refused without a model call, and protection lifts when the write ends", async () => {
    const root = workspace();
    const target = join(root, "shared.txt");
    const tools: OrcaToolService = {
      execute: async () => { await sleep(150); writeFileSync(target, "written by A after Stop"); return { ok: true, output: "" }; },
      formatForPrompt: () => "", list: () => [],
    } as unknown as OrcaToolService;
    const maestroA: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { await ctx.tools!.execute("write_file", {}); return { outputText: "" }; } };
    const guard = createWorkspaceGuard();
    const events: OrcaEvent[] = [];
    const runtime = createOrcaRuntime({ maestro: maestroA, pappy: pappyPass, llm: makeLLM() as never, tools, workspaceRoot: root, drainTimeoutMs: 20, workspaceGuard: guard });
    runtime.on("task:state", (e) => events.push(e));
    runtime.on("workspace:protected", (e) => events.push(e));
    const controller = new AbortController();
    const a = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(10);
    controller.abort(new Error("Stopped."));
    await expect(a).rejects.toMatchObject({ name: "AbortError" });

    // Task A is over (INTERRUPTED) but its write has not happened yet.
    expect(existsSync(target)).toBe(false);
    const protectedEvent = events.find((e) => e.type === "workspace:protected") as Extract<OrcaEvent, { type: "workspace:protected" }>;
    expect(protectedEvent.operations).toEqual(["tool write_file"]);
    expect(protectedEvent.recovery).toMatch(/What to check/);

    // Task B, same workspace: refused before anything runs.
    const maestroB = { run: vi.fn(async () => ({ outputText: "B ran" })) };
    const llmB = makeLLM();
    const runtimeB = createOrcaRuntime({ maestro: maestroB, pappy: pappyPass, llm: llmB as never, workspaceRoot: root, workspaceGuard: guard });
    await expect(runtimeB.executeTask(spec)).rejects.toBeInstanceOf(WorkspaceProtectedError);
    expect(maestroB.run).not.toHaveBeenCalled();
    expect(llmB.complete).not.toHaveBeenCalled();

    // A's late write lands; the guard sees the operation settle and releases.
    await sleep(200);
    expect(readFileSync(target, "utf8")).toBe("written by A after Stop");
    expect(await guard.status(root)).toEqual([]);
    const b = await runtimeB.executeTask(spec);
    expect(b.status).not.toBe("FAIL");
    expect(maestroB.run).toHaveBeenCalledTimes(1);
  });

  it("a different workspace is not blocked by another workspace's protection", async () => {
    const guard = createWorkspaceGuard();
    guard.protect(workspace(), { taskId: "X", reason: "was interrupted", operations: [{ kind: "tool", label: "w", startedAt: "t" }] });
    const runtime = createOrcaRuntime({ maestro: { run: async () => ({ outputText: "ok" }) }, pappy: pappyPass, llm: makeLLM() as never, workspaceRoot: workspace(), workspaceGuard: guard, maxRepairPasses: 0 });
    expect((await runtime.executeTask(spec)).status).not.toBe("FAIL");
  });

  it("a pass that returns while a fire-and-forget operation still runs waits for it; one that never settles makes the task INTERRUPTED and protected even though the pass 'succeeded'", async () => {
    const run = async (toolMs: number, drainMs: number) => {
      const root = workspace();
      const guard = createWorkspaceGuard();
      const tools: OrcaToolService = { execute: async () => { await sleep(toolMs); return { ok: true, output: "" }; }, formatForPrompt: () => "", list: () => [] } as unknown as OrcaToolService;
      const maestro: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { void ctx.tools!.execute("background_write", {}); await sleep(5); return { outputText: "done" }; } };
      const events: OrcaEvent[] = [];
      const runtime = createOrcaRuntime({ maestro, pappy: pappyPass, llm: makeLLM() as never, tools, workspaceRoot: root, maxRepairPasses: 0, drainTimeoutMs: drainMs, workspaceGuard: guard });
      runtime.on("task:state", (e) => events.push(e));
      const result = await runtime.executeTask(spec);
      return { lifecycle: result.lifecycle?.state, protected: (await guard.status(root)).length, states: events.filter((e) => e.type === "task:state").map((e) => (e as Extract<OrcaEvent, { type: "task:state" }>).state) };
    };
    expect(await run(30, 1000)).toEqual({ lifecycle: "COMPLETED", protected: 0, states: ["RUNNING", "VERIFYING", "COMPLETED"] });
    expect(await run(300, 20)).toEqual({ lifecycle: "INTERRUPTED", protected: 1, states: ["RUNNING", "VERIFYING", "CANCELLING", "INTERRUPTED"] });
  });

  it("after Stop a late worker callback cannot make a model call, run a tool, get an approval, or change the recorded verdict", async () => {
    const root = workspace();
    const controller = new AbortController();
    const late: Record<string, unknown> = {};
    const approvals: string[] = [];
    const pappy = { evaluate: vi.fn(() => pass("FAIL")) } as unknown as PappyPort;
    const tools: OrcaToolService = { execute: async () => { await sleep(5); return { ok: true, output: "" }; }, formatForPrompt: () => "", list: () => [] } as unknown as OrcaToolService;
    const maestro: MaestroPort = {
      run: async (_t, ctx: OrcaRunCtx) => {
        await ctx.tools!.execute("read_file", {});
        await sleep(40); // Stop arrives here
        late["llm"] = await ctx.llm.complete("continue").then(() => "answered", (e: Error) => `${e.name}: ${e.message}`);
        late["stream"] = await ctx.llm.stream("continue", {}, () => undefined).then(() => "answered", (e: Error) => e.name);
        late["tool"] = await ctx.tools!.execute("write_file", {});
        late["approval"] = await ctx.requestToolApproval!("run_command", {});
        late["transition"] = ctx.lifecycle!.transition("VERIFYING", "late verification");
        return { outputText: "late output" };
      },
    };
    const store = { runs: [] as unknown[], saveRun: (r: unknown) => { (store.runs as unknown[]).push(r); }, getRecentRuns: () => [], getRun: () => null, getRunThoughts: () => [], getRunToolEvents: () => [], deleteRun() {}, searchRuns: () => [], getStats: () => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 }), close() {} };
    const llm = makeLLM();
    const runtime = createOrcaRuntime({ maestro, pappy, llm: llm as never, tools, workspaceRoot: root, store: store as never, requestToolApproval: async (t) => { approvals.push(t); return true; }, drainTimeoutMs: 500 });
    const promise = runtime.executeTask(spec, { abortSignal: controller.signal });
    await sleep(15);
    controller.abort(new Error("Stopped."));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await sleep(80);
    expect(late["llm"]).toMatch(/^AbortError: model call not made: the task is cancell/);
    expect(late["stream"]).toBe("AbortError");
    expect(late["tool"]).toMatchObject({ ok: false, error: expect.stringMatching(/not run/) });
    expect(late["approval"]).toBe(false);
    expect(late["transition"]).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(approvals).toEqual([]);
    expect(pappy.evaluate).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "cancelled" });
  });
});
