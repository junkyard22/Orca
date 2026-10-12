/**
 * Override accounting — what an override changes and what it must not.
 * An override is the user's acknowledged risk: it is recorded, it bumps the
 * workspace generation, and it lets the next task start. It does not make
 * the interrupted task successful, does not let its late callbacks act,
 * does not touch the budget's unreconciled record, and does not relax any
 * gate the next task passes through.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBudgetLedger, budgetedAdapter, withBudgetAttribution } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { createOrcaRuntime } from "./runtime.js";
import { createWorkspaceGuard } from "./workspaceGuard.js";
import { createBudgetJournal } from "./budget/journal.js";
import type { MaestroPort, OrcaEvent, OrcaRunCtx, OrcaTaskSpec, OrcaToolService, PappyPort } from "./types.js";
import type { OrcaStore, RunRecord } from "./persistence/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ANTHROPIC = { id: "p1", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
const llm = { complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) };
const pass = { verdict: "PASS", trainingEligibility: "accepted_but_not_trainable", confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: [], repair_task: null, internalSummary: "" };
const pappy = { evaluate: () => pass } as unknown as PappyPort;
const spec = { originalUserMessage: "x", intent: "x", goals: [], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;

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

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-override-"));
  writeFileSync(join(root, "a.txt"), "x");
  return root;
}

describe("override accounting", () => {
  it("after an override: the interrupted task stays interrupted, its late callbacks still cannot act, the budget's unreconciled record stays, the next task is gated as any other", async () => {
    const root = workspace();
    const dir = mkdtempSync(join(tmpdir(), "orca-override-journal-"));
    const journal = createBudgetJournal(join(dir, "budget-journal.json"));
    const guard = createWorkspaceGuard({ filePath: join(dir, "workspace-protection.json"), probe: () => "alive" });
    const store = new MemoryStore();
    const approvals: string[] = [];
    const late: Record<string, unknown> = {};

    // Task A: a model request cancelled after dispatch (unreconciled), a tool that
    // ignores Stop for a long time, and a late callback that tries to act.
    const controller = new AbortController();
    const adapter = budgetedAdapter({ name: "slow", complete: (r: LLMRequest) => new Promise<LLMResponse>((_res, rej) => r.signal?.addEventListener("abort", () => rej(Object.assign(new Error("Stopped."), { name: "AbortError" })))) } as LLMAdapter, { provider: ANTHROPIC, defaultModel: "claude-sonnet-5-5" });
    let releaseTool!: () => void;
    const tools: OrcaToolService = { execute: () => new Promise((resolve) => { releaseTool = () => resolve({ ok: true, output: "late write" }); }), formatForPrompt: () => "", list: () => [] } as unknown as OrcaToolService;
    let ctxA: OrcaRunCtx | undefined;
    const maestroA: MaestroPort = {
      run: async (_t, ctx) => {
        ctxA = ctx;
        void ctx.tools!.execute("mcp:write", {});
        await withBudgetAttribution({ role: "engineer" }, () => adapter.complete({ model: "", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 256, signal: ctx.abortSignal }));
        return { outputText: "" };
      },
    };
    const events: OrcaEvent[] = [];
    const runtimeA = createOrcaRuntime({ maestro: maestroA, pappy, llm: llm as never, tools, store, workspaceRoot: root, workspaceGuard: guard, budgetUsd: 1, budgetJournal: journal, drainTimeoutMs: 30, requestToolApproval: async (t) => { approvals.push(t); return true; } });
    runtimeA.on("budget:update", (e) => events.push(e));
    const promiseA = runtimeA.executeTask(spec, { abortSignal: controller.signal });
    await sleep(15);
    controller.abort(new Error("Stopped."));
    await expect(promiseA).rejects.toMatchObject({ name: "AbortError" });

    const budgetA = ([...events].reverse().find((e) => e.type === "budget:update") as Extract<OrcaEvent, { type: "budget:update" }>).budget;
    expect(budgetA.unreconciledUsd).toBeGreaterThan(0);
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "interrupted" });
    expect(await guard.status(root)).toHaveLength(1);
    expect(guard.generation(root)).toBe(0);

    // The user overrides while the tool is still running (test only; the dialog forbids it in practice).
    const released = await guard.override(root, { reason: "test override", acknowledged: true });
    expect(released).toMatchObject([{ by: "override", generation: 1 }]);
    expect(guard.generation(root)).toBe(1);
    expect(guard.overrides()[0]!.protection.operations.map((o) => o.label)).toEqual(["mcp:write"]); // the interruption evidence is intact

    // Nothing about task A changed: still interrupted, late callbacks still refused.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "FAIL", stoppedBecause: "interrupted" });
    expect(ctxA!.lifecycle!.current).toBe("INTERRUPTED");
    expect(ctxA!.lifecycle!.mayDispatch).toBe(false);
    late["tool"] = await ctxA!.tools!.execute("write_file", {});
    late["approval"] = await ctxA!.requestToolApproval!("run_command", {});
    late["llm"] = await ctxA!.llm.complete("continue").then(() => "answered", (e: Error) => e.name);
    expect(late["tool"]).toMatchObject({ ok: false });
    expect(late["approval"]).toBe(false);
    expect(late["llm"]).toBe("AbortError");
    expect(approvals).toEqual([]);
    // The budget's unreconciled record for A is untouched by the override.
    expect(([...events].reverse().find((e) => e.type === "budget:update") as Extract<OrcaEvent, { type: "budget:update" }>).budget.unreconciledUsd).toBe(budgetA.unreconciledUsd);

    // Task B may start now — and still asks for approval like any task (the override granted no authority).
    const maestroB: MaestroPort = { run: async (_t, ctx) => { await ctx.requestToolApproval!("run_command", { command: "echo" }); return { outputText: "b" }; } };
    const runtimeB = createOrcaRuntime({ maestro: maestroB, pappy, llm: llm as never, store, workspaceRoot: root, workspaceGuard: guard, maxRepairPasses: 0, requestToolApproval: async (t) => { approvals.push(t); return false; } });
    const b = await runtimeB.executeTask(spec);
    expect(approvals).toEqual(["run_command"]);
    expect(b.lifecycle?.state).toBe("COMPLETED");

    // A's tool finally settles: recorded as settled after INTERRUPTED; nothing else moves.
    releaseTool();
    await sleep(10);
    expect(ctxA!.lifecycle!.snapshot().ignoredAfterEnd.map((i) => i.event)).toContain("tool mcp:write settled after INTERRUPTED");
    expect(store.runs).toHaveLength(2);
  });

  it("an override is refused without the literal acknowledgement and does nothing when nothing is protected", async () => {
    const guard = createWorkspaceGuard();
    // @ts-expect-error acknowledged must be literally true
    await expect(guard.override("/ws", { reason: "x", acknowledged: "yes" })).rejects.toThrow(/explicit acknowledgement/);
    expect(await guard.override("/ws", { reason: "x", acknowledged: true })).toEqual([]);
    expect(guard.overrides()).toEqual([]);
    expect(guard.generation("/ws")).toBe(0);
  });

  it("logs and events distinguish a verified release from an override", async () => {
    const guard = createWorkspaceGuard({ probe: () => "gone" });
    const seen: string[] = [];
    guard.subscribe((e) => seen.push(e.type === "released" ? `${e.release.by}: ${e.release.reason}` : "protected"));
    guard.protect("/ws", { taskId: "A", reason: "was interrupted", resources: [{ kind: "process", pid: 1, label: "c", startedAt: "t", reason: "r" }] });
    await guard.status("/ws"); // probe says gone → verification
    guard.protect("/ws", { taskId: "B", reason: "was interrupted", operations: [{ kind: "tool", label: "w", startedAt: "t" }] });
    await guard.override("/ws", { reason: "the user accepted the risk in the override dialog", acknowledged: true });
    expect(seen).toEqual([
      "protected",
      "verification: every process was verified gone",
      "protected",
      "override: the user accepted the risk in the override dialog",
    ]);
  });
});
