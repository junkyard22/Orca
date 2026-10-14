/**
 * The dispatch guard forwards to an already-gated service and refuses after
 * the task stopped. It must not be a way around anything: the service's own
 * gate still runs on every forwarded call, a refused call touches nothing,
 * and the guard decides nothing about tools, budget or ownership.
 */
import { describe, expect, it, vi } from "vitest";
import { guardDispatch } from "./dispatchGuard.js";
import { TaskLifecycle } from "./lifecycle.js";
import type { OrcaLLMService } from "./types.js";

function gatedService() {
  const gate = vi.fn((stage: string) => ({ allowed: true, stage }));
  const transport = vi.fn(async (prompt: string) => ({ text: `answer to ${prompt}` }));
  const service: OrcaLLMService & { extra: string } = {
    extra: "kept",
    complete: async (prompt) => { gate("complete"); return transport(prompt); },
    stream: async (prompt, _opts, onChunk) => { gate("stream"); const r = await transport(prompt); onChunk(r.text); return r; },
  };
  return { service, gate, transport };
}

describe("dispatch guard", () => {
  it("forwards complete and stream through the gated service while the task may dispatch; the gate runs on every call", async () => {
    const { service, gate, transport } = gatedService();
    const lifecycle = new TaskLifecycle({ taskId: "t" });
    lifecycle.transition("RUNNING", "x");
    const guarded = guardDispatch(service, lifecycle);
    expect((guarded as unknown as { extra: string }).extra).toBe("kept");
    expect(await guarded.complete("a")).toEqual({ text: "answer to a" });
    const chunks: string[] = [];
    expect(await guarded.stream("b", {}, (c) => chunks.push(c))).toEqual({ text: "answer to b" });
    expect(chunks).toEqual(["answer to b"]);
    expect(gate.mock.calls.map((c) => c[0])).toEqual(["complete", "stream"]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("after cancellation or completion a call is refused with an AbortError before the service, its gate or its transport see it", async () => {
    const { service, gate, transport } = gatedService();
    const lifecycle = new TaskLifecycle({ taskId: "t" });
    lifecycle.transition("RUNNING", "x");
    const guarded = guardDispatch(service, lifecycle);
    lifecycle.cancel("Stopped.");
    await expect(guarded.complete("late")).rejects.toMatchObject({ name: "AbortError", message: expect.stringMatching(/^model call not made: the task is cancell/) });
    await expect(guarded.stream("late", {}, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    const done = new TaskLifecycle({ taskId: "u" });
    done.transition("RUNNING", "x");
    done.finish("COMPLETED", "ok");
    await expect(guardDispatch(service, done).complete("late")).rejects.toMatchObject({ message: "model call not made: the task is completed." });
    expect(gate).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not bypass anything: a service that refuses still refuses, and the guard adds no authority of its own", async () => {
    const refusing: OrcaLLMService = {
      complete: async () => { throw Object.assign(new Error("Budget refused_limit: over budget"), { name: "BudgetRefusedError" }); },
      stream: async () => { throw Object.assign(new Error("gate_blocked"), { name: "GateBlockedError" }); },
    };
    const lifecycle = new TaskLifecycle({ taskId: "t" });
    lifecycle.transition("RUNNING", "x");
    const guarded = guardDispatch(refusing, lifecycle);
    await expect(guarded.complete("x")).rejects.toMatchObject({ name: "BudgetRefusedError" });
    await expect(guarded.stream("x", {}, () => undefined)).rejects.toMatchObject({ name: "GateBlockedError" });
    // The guard exposes exactly the service's surface plus nothing: no way to reach the transport directly.
    expect(Object.keys(guarded).sort()).toEqual(["complete", "stream"]);
  });
});
