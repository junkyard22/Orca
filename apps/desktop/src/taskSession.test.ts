import { describe, expect, it, vi } from "vitest";
import { TaskSessionManager } from "./taskSession";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Work that honours the abort signal after `settleMs`, or never when `hangs`. */
function work(opts: { settleMs: number; hangs?: boolean; log: string[] }) {
  return (session: { signal: AbortSignal }) => new Promise<string>((resolve) => {
    const finish = () => { if (!opts.hangs) { opts.log.push("settled"); resolve("done"); } };
    const timer = setTimeout(finish, opts.settleMs + 1000);
    session.signal.addEventListener("abort", () => { clearTimeout(timer); setTimeout(finish, opts.settleMs); });
  });
}

describe("task session lock", () => {
  it("reproduces the production bug's shape and closes it: Stop answers at once, but the lock is held until the task settles", async () => {
    const log: string[] = [];
    const manager = new TaskSessionManager({ interruptAfterMs: 5000 });
    const { session, reply } = manager.begin(work({ settleMs: 40, log }), (reason) => `stopped:${reason}`);
    expect(manager.refusal()?.error).toMatch(/A task is already running/);
    manager.cancel("Stopped.");
    expect(await reply).toBe("stopped:Stopped.");
    // The reply came back, but the task has not settled: a new message is refused.
    expect(session.state).toBe("cancelling");
    expect(manager.refusal()?.error).toMatch(/still stopping/);
    expect(() => manager.begin(async () => "x", () => "y")).toThrow(/still stopping/);
    expect(await session.settled).toBe("cancelled");
    expect(log).toEqual(["settled"]);
    expect(manager.current).toBeNull();
    expect(manager.refusal()).toBeNull();
  });

  it("releases the lock on normal completion and on failure", async () => {
    const manager = new TaskSessionManager();
    const ok = manager.begin(async () => "fine", () => "stopped");
    expect(await ok.reply).toBe("fine");
    expect(await ok.session.settled).toBe("completed");
    const bad = manager.begin(async () => { throw new Error("boom"); }, () => "stopped");
    await expect(bad.reply).rejects.toThrow("boom");
    expect(await bad.session.settled).toBe("failed");
    expect(manager.current).toBeNull();
  });

  it("a task that never settles after Stop is marked interrupted by the watchdog, reported, and the lock released", async () => {
    const onInterrupted = vi.fn();
    const manager = new TaskSessionManager({ interruptAfterMs: 30, onInterrupted });
    const { session, reply } = manager.begin(work({ settleMs: 0, hangs: true, log: [] }), (r) => r);
    manager.cancel("Stopped.");
    expect(await reply).toBe("Stopped.");
    expect(await session.settled).toBe("interrupted");
    expect(onInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, reason: expect.stringMatching(/did not settle within 30 ms/) }));
    expect(manager.current).toBeNull();
  });

  it("two Stop requests cancel once; a Stop after settlement changes nothing", async () => {
    const log: string[] = [];
    const manager = new TaskSessionManager();
    const { session } = manager.begin(work({ settleMs: 5, log }), (r) => r);
    expect(manager.cancel("one")).toBe(true);
    expect(manager.cancel("two")).toBe(true);
    expect(session.signal.reason.message).toBe("one");
    await session.settled;
    expect(manager.cancel("three")).toBe(false);
    expect(session.state).toBe("cancelled");
  });

  it("a new task cannot start during cancellation, and starts cleanly once the previous one settled", async () => {
    const manager = new TaskSessionManager();
    const first = manager.begin(work({ settleMs: 10, log: [] }), (r) => r);
    manager.cancel();
    await first.reply;
    expect(manager.refusal()).not.toBeNull();
    await first.session.settled;
    const second = manager.begin(async () => "second", (r) => r);
    expect(second.session.id).not.toBe(first.session.id);
    expect(await second.reply).toBe("second");
  });
});
