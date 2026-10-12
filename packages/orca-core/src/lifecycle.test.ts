import { describe, expect, it } from "vitest";
import { TaskLifecycle } from "./lifecycle.js";

describe("task lifecycle", () => {
  it("follows the execution order and records every transition", () => {
    const l = new TaskLifecycle({ taskId: "t" });
    expect(l.current).toBe("CREATED");
    expect(l.transition("PLANNING", "brain")).toBe(true);
    expect(l.transition("RUNNING", "worker")).toBe(true);
    expect(l.transition("WAITING_FOR_APPROVAL", "run_command")).toBe(true);
    expect(l.transition("RUNNING", "approved")).toBe(true);
    expect(l.transition("VERIFYING", "pappy")).toBe(true);
    expect(l.transition("REPAIRING", "repair 1")).toBe(true);
    expect(l.transition("VERIFYING", "pappy")).toBe(true);
    expect(l.finish("COMPLETED", "PASS")).toBe(true);
    expect(l.snapshot().transitions.map((t) => t.to)).toEqual(["PLANNING", "RUNNING", "WAITING_FOR_APPROVAL", "RUNNING", "VERIFYING", "REPAIRING", "VERIFYING", "COMPLETED"]);
  });

  it("terminal states cannot be reversed by late events, and invalid moves are recorded rather than applied", () => {
    const l = new TaskLifecycle({ taskId: "t" });
    l.transition("RUNNING", "worker");
    l.finish("FAILED", "QC FAIL");
    expect(l.transition("RUNNING", "late worker callback")).toBe(false);
    expect(l.transition("COMPLETED", "late success")).toBe(false);
    l.cancel("late stop");
    expect(l.current).toBe("FAILED");
    expect(l.snapshot().ignoredAfterEnd.map((e) => e.event)).toEqual([
      "RUNNING (late worker callback) after FAILED",
      "COMPLETED (late success) after FAILED",
      "cancel (late stop) after FAILED",
    ]);
    const bad = new TaskLifecycle({ taskId: "t2" });
    expect(bad.transition("REPAIRING", "skip ahead")).toBe(false);
    expect(bad.current).toBe("CREATED");
  });

  it("cancellation is CANCELLING until every tracked operation settles, then CANCELLED; nothing may dispatch meanwhile", async () => {
    const l = new TaskLifecycle({ taskId: "t" });
    l.transition("RUNNING", "worker");
    const tool = l.begin("tool", "run_command");
    const model = l.begin("model", "claude-sonnet-5-5");
    l.cancel("user pressed Stop");
    expect(l.current).toBe("CANCELLING");
    expect(l.mayDispatch).toBe(false);
    // A stage change after cancellation is refused.
    expect(l.transition("VERIFYING", "late QC")).toBe(false);
    expect(l.finish("COMPLETED", "late success")).toBe(false);
    model.end();
    expect(l.current).toBe("CANCELLING");
    const drained = l.drain(1000);
    tool.end();
    expect(await drained).toBe(true);
    expect(l.current).toBe("CANCELLED");
    expect(l.terminal).toBe(true);
    // Idempotent: a second cancellation changes nothing.
    l.cancel("again");
    expect(l.snapshot().transitions.filter((t) => t.to === "CANCELLING")).toHaveLength(1);
  });

  it("an operation that never settles leaves the task INTERRUPTED with the operation named", async () => {
    const l = new TaskLifecycle({ taskId: "t" });
    l.transition("RUNNING", "worker");
    l.begin("tool", "mcp:browser_navigate", false);
    l.cancel("stop");
    expect(await l.drain(20)).toBe(false);
    l.interrupt("stop; operations still active after 20 ms");
    expect(l.current).toBe("INTERRUPTED");
    expect(l.snapshot().unsettledOperations.map((o) => o.label)).toEqual(["mcp:browser_navigate"]);
    // Even when the operation finally ends, the state stays INTERRUPTED.
    expect(l.transition("CANCELLED", "late settle")).toBe(false);
  });

  it("track() releases its operation on success and on failure", async () => {
    const l = new TaskLifecycle({ taskId: "t" });
    await l.track("tool", "ok", async () => "fine");
    await expect(l.track("tool", "bad", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(l.activeOperations()).toEqual([]);
  });

  it("notifies listeners with the snapshot and transition", () => {
    const seen: string[] = [];
    const l = new TaskLifecycle({ taskId: "t", onChange: (s, t) => seen.push(t ? `${t.from}->${t.to}` : `ops=${s.activeOperations.length}`) });
    l.transition("RUNNING", "x");
    const op = l.begin("tool", "t");
    op.end();
    expect(seen).toEqual(["CREATED->RUNNING", "ops=1", "ops=0"]);
  });
});
