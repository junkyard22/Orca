/**
 * Workspace guard — task state and workspace safety are different things.
 * A task can be INTERRUPTED (its state settled) while an operation or a child
 * process it started still writes; the workspace stays protected until that
 * settles, is verified gone, or the user releases it knowingly.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLifecycle } from "./lifecycle.js";
import type { UnsettledResource } from "./lifecycle.js";
import { createWorkspaceGuard, describeProtections } from "./workspaceGuard.js";
import type { ProcessLiveness } from "./workspaceGuard.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const proc = (pid: number, identity?: string): UnsettledResource => ({ kind: "process", pid, label: "pnpm test", startedAt: "2026-10-12T00:00:00.000Z", ...(identity ? { identity } : {}), reason: "kill not confirmed" });

describe("workspace guard", () => {
  it("protects a root for an interrupted task with an operation still active, refuses it to others, and releases on settlement", async () => {
    const guard = createWorkspaceGuard();
    const lifecycle = new TaskLifecycle({ taskId: "A" });
    const op = lifecycle.begin("tool", "write_file");
    lifecycle.cancel("Stopped.");
    lifecycle.interrupt("drain timed out");
    const events: string[] = [];
    guard.subscribe((e) => events.push(e.type === "protected" ? "protected" : `released:${e.release.by}`));
    guard.protect("C:/ws/one", { taskId: "A", reason: "was interrupted", lifecycle });

    expect((await guard.status("C:/ws/one")).map((p) => p.operations.map((o) => o.label))).toEqual([["write_file"]]);
    expect(await guard.status("C:/ws/two")).toEqual([]);           // a different workspace is unaffected
    expect(await guard.status("c:/WS/ONE/")).toHaveLength(process.platform === "win32" ? 1 : 0); // same root, different spelling (Windows)

    op.end(); // the late write finished
    await sleep(5);
    expect(await guard.status("C:/ws/one")).toEqual([]);
    expect(events).toEqual(["protected", "released:settlement"]);
    expect(lifecycle.snapshot().ignoredAfterEnd.map((i) => i.event)).toEqual(["tool write_file settled after INTERRUPTED"]);
  });

  it("an unconfirmed child process keeps the workspace protected until a probe says it is gone; a reused pid with another identity counts as gone", async () => {
    let liveness: ProcessLiveness = "alive";
    const probe = vi.fn(async (r: UnsettledResource) => (r.pid === 4242 ? liveness : "gone"));
    const guard = createWorkspaceGuard({ probe });
    guard.protect("/ws", { taskId: "A", reason: "was interrupted", resources: [proc(4242, "2026-10-12T00:00:00Z"), proc(99)] });
    let status = await guard.status("/ws");
    expect(status[0]!.resources.map((r) => r.pid)).toEqual([4242]);  // pid 99 verified gone at once
    expect(status[0]!.notes[0]).toMatch(/process 99 .* verified gone/);
    liveness = "unknown";
    expect((await guard.status("/ws"))).toHaveLength(1);              // unknown is not "safe"
    liveness = "gone";
    status = await guard.status("/ws");
    expect(status).toEqual([]);
  });

  it("an override is the user's acknowledged risk: recorded with the protection as it stood, generation bumped, nothing verified", async () => {
    const guard = createWorkspaceGuard({ probe: () => "alive" });
    guard.protect("/ws", { taskId: "A", reason: "was interrupted", resources: [proc(1)] });
    expect(guard.generation("/ws")).toBe(0);
    // @ts-expect-error acknowledged must be literally true
    await expect(guard.override("/ws", { reason: "x", acknowledged: false })).rejects.toThrow(/explicit acknowledgement/);
    const released = await guard.override("/ws", { reason: "I checked Task Manager and accept the risk", acknowledged: true });
    expect(released).toMatchObject([{ taskId: "A", by: "override", generation: 1 }]);
    expect(await guard.status("/ws")).toEqual([]);
    expect(guard.generation("/ws")).toBe(1);
    const audit = guard.overrides();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ taskId: "A", reason: "I checked Task Manager and accept the risk", generation: 1 });
    expect(audit[0]!.protection.resources.map((r) => r.pid)).toEqual([1]); // the interruption evidence travels with the override
    expect(await guard.override("/ws", { reason: "again", acknowledged: true })).toEqual([]);
    // A later protection on the same root carries the new generation.
    guard.protect("/ws", { taskId: "B", reason: "was interrupted", resources: [proc(2)] });
    expect((await guard.status("/ws"))[0]!.generation).toBe(1);
  });

  it("protection survives a restart: in-process operations are gone with the process, child processes are re-probed, nothing is reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-guard-"));
    const file = join(dir, "protection.json");
    const first = createWorkspaceGuard({ filePath: file, probe: () => "alive" });
    first.protect("/ws", { taskId: "A", reason: "was interrupted", operations: [{ kind: "tool", label: "write_file", startedAt: "t" }], resources: [proc(7)] });
    first.protect("/other", { taskId: "B", reason: "did not settle after Stop", operations: [{ kind: "other", label: "task runtime", startedAt: "t" }] });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).protections).toHaveLength(2);

    // "Restart": a new guard over the same file. /other had only in-process work → released by verification;
    // /ws has a live child process → kept, with the dead operation noted.
    const second = createWorkspaceGuard({ filePath: file, probe: (r) => (r.pid === 7 ? "alive" : "gone") });
    const recovered = await second.recover();
    expect(recovered.released.map((r) => [r.root.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""), r.by])).toEqual([["/other", "verification"]]);
    expect(recovered.kept).toHaveLength(1);
    expect(recovered.kept[0]!.operations).toEqual([]);
    expect(recovered.kept[0]!.notes[0]).toMatch(/1 in-process operation\(s\) ended with the previous Orca process \(tool write_file\)/);
    expect(recovered.kept[0]!.resources.map((r) => r.pid)).toEqual([7]);
    expect(await second.status("/ws")).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).protections).toHaveLength(1);
  });

  it("settle() lifts a host-level record only when no process remains; the lifecycle's own record is left to the lifecycle", async () => {
    const guard = createWorkspaceGuard({ probe: () => "alive" });
    guard.protect("/ws", { taskId: "S", reason: "did not settle after Stop", operations: [{ kind: "other", label: "task runtime", startedAt: "t" }] });
    expect(await guard.settle("/ws", "S", "runtime settled late")).toMatchObject({ by: "settlement" });
    expect(await guard.status("/ws")).toEqual([]);

    guard.protect("/ws", { taskId: "P", reason: "was interrupted", operations: [{ kind: "other", label: "task runtime", startedAt: "t" }], resources: [proc(3)] });
    expect(await guard.settle("/ws", "P", "runtime settled late")).toBeNull();
    expect((await guard.status("/ws"))[0]!.resources.map((r) => r.pid)).toEqual([3]);
  });

  it("describes what is left and what to check, in words a user can act on", () => {
    const text = describeProtections([{ root: "/ws", taskId: "A", since: "t", reason: "was interrupted", operations: [{ kind: "tool", label: "run_command", startedAt: "t" }], resources: [proc(5)], notes: [] }]);
    expect(text).toMatch(/Workspace \/ws is protected: task A was interrupted — 1 operation\(s\) never settled: tool run_command; process\(es\) not confirmed stopped: pid 5 \(pnpm test\)/);
    expect(text).toMatch(/Wait: protection lifts on its own/);
    expect(text).toMatch(/Task Manager/);
    expect(text).toMatch(/git status/);
    expect(text).toMatch(/override the protection. An override is recorded as your decision: it verifies nothing and stops nothing/);
  });
});

describe("lifecycle residues", () => {
  it("an operation whose error carries an unsettled process ends INTERRUPTED, never CANCELLED; releasing the process is recorded", async () => {
    const lifecycle = new TaskLifecycle({ taskId: "T" });
    lifecycle.transition("RUNNING", "start");
    const failing = lifecycle.track("tool", "run_command", async () => {
      await sleep(5);
      const error = new Error("Stopped.");
      error.name = "AbortError";
      (error as Error & { unsettledResource?: unknown }).unsettledResource = proc(31337, "id");
      throw error;
    });
    lifecycle.cancel("Stopped.");
    expect(lifecycle.current).toBe("CANCELLING");
    const drained = lifecycle.drain(1000);
    await expect(failing).rejects.toMatchObject({ name: "AbortError" });
    expect(await drained).toBe(false);
    expect(lifecycle.current).toBe("INTERRUPTED");
    expect(lifecycle.quiet).toBe(false);
    const snap = lifecycle.snapshot();
    expect(snap.unsettledResources).toMatchObject([{ pid: 31337, identity: "id" }]);
    expect(snap.transitions.at(-1)!.reason).toMatch(/not confirmed stopped: process 31337 \(pnpm test\)/);
    expect(lifecycle.releaseResource(31337, "verified gone")).toBe(true);
    expect(lifecycle.quiet).toBe(true);
    expect(lifecycle.current).toBe("INTERRUPTED"); // terminal stays terminal; the workspace is quiet now
    expect(lifecycle.releaseResource(31337, "again")).toBe(false);
  });

  it("drain resolves false at once when the only thing outstanding is a resource", async () => {
    const lifecycle = new TaskLifecycle({ taskId: "T" });
    await lifecycle.track("tool", "x", async () => { const e = new Error("x"); (e as Error & { unsettledResource?: unknown }).unsettledResource = proc(1); throw e; }).catch(() => undefined);
    const started = Date.now();
    expect(await lifecycle.drain(5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
