/**
 * Phase 6 §1 — the watchdog loophole, end to end through the desktop pieces:
 * TaskSessionManager (the lock), the runtime (the lifecycle) and the
 * workspace guard (who may write). Task B must not begin while Task A's
 * worker can still modify the workspace, and the user must be told why.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrcaRuntime, createWorkspaceGuard } from "@clawde/orca-core";
import type { MaestroPort, OrcaRunCtx, OrcaTaskSpec, OrcaToolService, PappyPort } from "@clawde/orca-core";
import { TaskSessionManager } from "./taskSession";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spec = { originalUserMessage: "x", intent: "x", goals: [], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
const llm = { complete: async () => ({ text: "" }), stream: async () => ({ text: "" }) };
const pappy = { evaluate: () => ({ verdict: "PASS", confidence: 1, summary: "", issues: [], acceptance_criteria: [], claims: [], receipt_ledger: [], repair_task: null, trainingEligibility: "accepted_but_not_trainable", internalSummary: "" }) } as unknown as PappyPort;

describe("workspace safety across sessions", () => {
  it("Task A's tool ignores Stop: A is INTERRUPTED, the lock is free, but the workspace is protected until A's write lands — then B may start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-p6-"));
    const target = join(dir, "shared.txt");
    const tools: OrcaToolService = {
      execute: async () => { await sleep(150); writeFileSync(target, "written by A after Stop"); return { ok: true, output: "" }; },
      formatForPrompt: () => "", list: () => [],
    } as unknown as OrcaToolService;
    const maestro: MaestroPort = { run: async (_t, ctx: OrcaRunCtx) => { await ctx.tools!.execute("write_file", {}); return { outputText: "done" }; } };
    const guard = createWorkspaceGuard();
    const runtime = createOrcaRuntime({ maestro, pappy, llm: llm as never, tools, workspaceRoot: dir, drainTimeoutMs: 20, workspaceGuard: guard });
    const sessions = new TaskSessionManager({ interruptAfterMs: 40 });

    const a = sessions.begin((s) => runtime.executeTask(spec, { abortSignal: s.signal }).then(() => "done", (e: Error) => `err:${e.name}`), () => "stopped");
    await sleep(10);
    sessions.cancel("Stopped.");
    expect(await a.reply).toBe("stopped");
    expect(await a.session.settled).toBe("cancelled");   // the runtime returned (INTERRUPTED) → the lock is free
    expect(sessions.refusal()).toBeNull();

    // What the desktop does before starting B: ask the guard.
    const before = await guard.status(dir);
    expect(before).toHaveLength(1);
    expect(before[0]!.operations.map((o) => o.label)).toEqual(["write_file"]);
    expect(existsSync(target)).toBe(false);               // A has not written yet — B would have raced it
    await expect(runtime.executeTask(spec)).rejects.toMatchObject({ name: "WorkspaceProtectedError", message: expect.stringMatching(/tool write_file/) });

    await sleep(200);
    expect(readFileSync(target, "utf8")).toBe("written by A after Stop");
    expect(await guard.status(dir)).toEqual([]);           // settled → released, no user action needed
    const b = sessions.begin((s) => runtime.executeTask(spec, { abortSignal: s.signal }).then((r) => r.status), () => "stopped");
    expect(await b.reply).not.toBe("FAIL");
  });

  it("the watchdog gives up on a runtime that never settles: the lock is released but a host-level protection stays until the runtime settles late or the user releases it", async () => {
    const guard = createWorkspaceGuard();
    const root = mkdtempSync(join(tmpdir(), "orca-p6-wd-"));
    let settleWork!: () => void;
    const sessions = new TaskSessionManager({
      interruptAfterMs: 30,
      onInterrupted: ({ id, reason }) => guard.protect(root, { taskId: id, reason: "did not settle after Stop", operations: [{ kind: "other", label: `task runtime (${reason})`, startedAt: "t" }] }),
      onLateSettlement: ({ id }) => { void guard.settle(root, id, "the task runtime settled after the watchdog had given up"); },
    });
    const { session, reply } = sessions.begin(() => new Promise<string>((r) => { settleWork = () => r("late"); }), (r) => r);
    sessions.cancel("Stopped.");
    expect(await reply).toBe("Stopped.");
    expect(await session.settled).toBe("interrupted");
    expect(sessions.refusal()).toBeNull();
    expect((await guard.status(root)).map((p) => p.taskId)).toEqual([session.id]);

    settleWork();
    await sleep(10);
    expect(await guard.status(root)).toEqual([]);
  });

  it("a user release is explicit and recorded; it is the only way out while a process is still alive", async () => {
    const guard = createWorkspaceGuard({ probe: () => "alive" });
    const root = "/ws";
    guard.protect(root, { taskId: "A", reason: "was interrupted", resources: [{ kind: "process", pid: 10, label: "pnpm test", startedAt: "t", reason: "kill not confirmed" }] });
    expect(await guard.status(root)).toHaveLength(1);
    await sleep(20);
    expect(await guard.status(root)).toHaveLength(1);     // time alone changes nothing
    const released = await guard.release(root, "released by the user after a manual check");
    expect(released).toMatchObject([{ by: "user", reason: "released by the user after a manual check" }]);
    expect(await guard.status(root)).toEqual([]);
  });
});
