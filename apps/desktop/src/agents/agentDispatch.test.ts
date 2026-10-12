/**
 * The desktop worker's model path honours the task lifecycle the same way its
 * tool path does: once cancellation was requested or the task ended, no model
 * call is made for it — whatever the abort signal says — and Miranda's gate
 * is consulted on every call that is made.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskLifecycle } from "@clawde/orca-core";
import type { OrcaRunCtx } from "@clawde/orca-core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { ReactAgentAdapter } from "./ReactAgentAdapter";
import type { AgentTask } from "./AgentAdapter";

function fakeAdapter() {
  const complete = vi.fn(async (_r: LLMRequest): Promise<LLMResponse> => ({ text: "FINAL ANSWER:\ndone" }));
  return { adapter: { name: "fake", complete } as unknown as LLMAdapter, complete };
}
const task: AgentTask = { intent: "say done", goals: ["say done"], doneCriteria: ["done"] };
function ctx(lifecycle: TaskLifecycle, gate: { beforeLLMCall: ReturnType<typeof vi.fn> }): OrcaRunCtx {
  return {
    runId: "run-1",
    recordTrace: () => undefined,
    lifecycle,
    gate: { ...gate, afterLLMCall: vi.fn(() => ({ allowed: true })), beforeToolRun: vi.fn(() => ({ allowed: true })), afterToolRun: vi.fn(() => ({ allowed: true })), beforeQC: vi.fn(() => ({ allowed: true })), afterQC: vi.fn(() => ({ allowed: true })) },
  } as unknown as OrcaRunCtx;
}

describe("worker model dispatch and the task lifecycle", () => {
  it("a running task's model call goes through Miranda's gate and the adapter", async () => {
    const { adapter, complete } = fakeAdapter();
    const gate = { beforeLLMCall: vi.fn(() => ({ allowed: true })) };
    const lifecycle = new TaskLifecycle({ taskId: "t" });
    lifecycle.transition("RUNNING", "x");
    await new ReactAgentAdapter(adapter, "system", "strong_model", 2).run(task, [], ctx(lifecycle, gate));
    expect(gate.beforeLLMCall).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("after cancellation (even with a signal that was never aborted) and after completion, no model call is made and the gate is not even asked", async () => {
    for (const end of ["cancel", "complete"] as const) {
      const { adapter, complete } = fakeAdapter();
      const gate = { beforeLLMCall: vi.fn(() => ({ allowed: true })) };
      const lifecycle = new TaskLifecycle({ taskId: "t" });
      lifecycle.transition("RUNNING", "x");
      if (end === "cancel") lifecycle.cancel("Stopped."); else lifecycle.finish("COMPLETED", "ok");
      await expect(new ReactAgentAdapter(adapter, "system", "strong_model", 2).run(task, [], ctx(lifecycle, gate)))
        .rejects.toMatchObject({ name: "AbortError", message: expect.stringMatching(/model call not made: the task is (cancell|completed)/) });
      expect(complete).not.toHaveBeenCalled();
      expect(gate.beforeLLMCall).not.toHaveBeenCalled();
    }
  });

  it("a gate that blocks still blocks: the lifecycle check adds no authority of its own", async () => {
    const { adapter, complete } = fakeAdapter();
    const gate = { beforeLLMCall: vi.fn(() => ({ allowed: false, reason: "model blocked" })) };
    const lifecycle = new TaskLifecycle({ taskId: "t" });
    lifecycle.transition("RUNNING", "x");
    const result = await new ReactAgentAdapter(adapter, "system", "strong_model", 2).run(task, [], ctx(lifecycle, gate));
    expect(complete).not.toHaveBeenCalled();
    expect(result.stoppedBecause).not.toBe("done");
  });
});
