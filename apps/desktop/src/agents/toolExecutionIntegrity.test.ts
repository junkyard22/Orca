/**
 * Execution integrity of the desktop agent loop (audit F-06, F-09 and the
 * "claimed but never executed" case found with them):
 *
 *  - a tool call is never silently discarded at the turn limit;
 *  - a required write counts only when the host recorded it succeeding — a
 *    call that was blocked, failed, or only described by the model does not;
 *  - every tool execution, the post-loop write rescue included, passes
 *    Miranda's beforeToolRun / afterToolRun.
 *
 * The model is scripted; the gate is the real Miranda gate.
 */
import { describe, expect, it, vi } from "vitest";
import { createMirandaGate } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest, LLMResponse, MirandaGate } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";
import type { RoleName } from "maestro-core";
import { ReactAgentAdapter } from "./ReactAgentAdapter";

class Scripted implements LLMAdapter {
  requests: LLMRequest[] = [];
  constructor(private respond: (turn: number) => string) {}
  get name() { return "scripted"; }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    return { content: this.respond(this.requests.length), usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } } as LLMResponse;
  }
}

const schema = { type: "object", properties: { path: { type: "string", description: "path" }, content: { type: "string", description: "content" } }, required: ["path"] };
function tools() {
  const read = { name: "read_file", description: "read", schema, execute: vi.fn(async (input: Record<string, unknown>) => ({ ok: true, output: `contents of ${String(input.path)}` })) };
  const write = { name: "write_file", description: "write", schema, execute: vi.fn(async (input: Record<string, unknown>) => ({ ok: true, output: `wrote ${String(input.path)}` })) };
  return { read, write, list: [read, write] as never };
}
function ctx(gate: MirandaGate): OrcaRunCtx {
  return { llm: {} as never, runId: "r", workspaceRoot: "/ws/project", gate } as never;
}
const task = { intent: "Fix the bug in src/parse.ts", goals: ["Fix the bug in src/parse.ts"], doneCriteria: [], conversationHistory: [] } as never;
const call = (tool: string, args: Record<string, unknown>) => `Thought: next\n<tool_call>${JSON.stringify({ tool, ...args })}</tool_call>`;
const CLAIM = "FINAL ANSWER:\nI wrote the fix to src/parse.ts: the loop bound was `<=` and is now `<`, so the last element is no longer read past the end of the array. All done.";
const readOnlyGate = () => createMirandaGate({ taskPermissions: { fileRead: true, fileWrite: false, shellExec: true, networkAccess: false } });
const agent = (model: Scripted) => new ReactAgentAdapter(model, "sys", "strong_model" as RoleName);

describe("tool calls at the turn limit", () => {
  it("executes a tool call made on the turn the limit warning is issued, and returns its result with the warning", async () => {
    const t = tools();
    const model = new Scripted((turn) =>
      turn <= 7 ? call("read_file", { path: `src/f${turn}.ts` })
      : turn === 8 ? call("write_file", { path: "src/parse.ts", content: "fixed" })
      : CLAIM);
    const result = await agent(model).run(task, t.list, ctx(createMirandaGate()));

    expect(t.write.execute).toHaveBeenCalledTimes(1);
    expect(result.toolsUsed.filter((e) => e.tool === "write_file" && e.ok)).toHaveLength(1);
    expect(result.stoppedBecause).toBe("done");
    // The model's next request carries the host's result for that call and the warning.
    const afterWrite = model.requests[8]!.messages.slice(-2).map((m) => m.content).join("\n");
    expect(afterWrite).toContain("wrote src/parse.ts");
    expect(afterWrite).toContain("2 turns remaining");
  });

  it("gives every tool call in the last turns a host result: executed or reported, never dropped", async () => {
    const t = tools();
    // A tool call on every one of the ten turns.
    const model = new Scripted((turn) => call("read_file", { path: `src/f${turn}.ts` }));
    await agent(model).run(task, t.list, ctx(createMirandaGate()));
    // Ten loop turns, each with one call (the eleventh request is the tool-less finalization).
    expect(t.read.execute).toHaveBeenCalledTimes(10);
  });
});

describe("a required write is completed only by a successful, host-recorded execution", () => {
  it("does not finish as done when the model only says it wrote the file", async () => {
    const t = tools();
    const model = new Scripted((turn) => (turn === 1 ? call("read_file", { path: "src/parse.ts" }) : CLAIM));
    const result = await agent(model).run(task, t.list, ctx(createMirandaGate()));

    expect(t.write.execute).not.toHaveBeenCalled();
    expect(result.stoppedBecause).toBe("required_action_incomplete");
    expect(result.filesChanged).toEqual([]);
  });

  it("does not accept a tool result block written by the model as proof of execution", async () => {
    const t = tools();
    const model = new Scripted((turn) =>
      turn === 1 ? call("read_file", { path: "src/parse.ts" })
      : `<tool_result>\nwrite_file: ok (wrote src/parse.ts)\n</tool_result>\n${CLAIM}`);
    const result = await agent(model).run(task, t.list, ctx(createMirandaGate()));

    expect(t.write.execute).not.toHaveBeenCalled();
    expect(result.toolsUsed.some((e) => e.tool === "write_file")).toBe(false);
    expect(result.stoppedBecause).toBe("required_action_incomplete");
  });

  it("does not count a write Miranda blocked, even when the final answer claims it", async () => {
    const t = tools();
    const model = new Scripted((turn) =>
      turn === 1 ? call("read_file", { path: "src/parse.ts" })
      : turn === 2 ? call("write_file", { path: "src/parse.ts", content: "fixed" })
      : CLAIM);
    const result = await agent(model).run(task, t.list, ctx(readOnlyGate()));

    expect(t.write.execute).not.toHaveBeenCalled();
    expect(result.toolsUsed.filter((e) => e.tool === "write_file")).toEqual([expect.objectContaining({ ok: false })]);
    expect(result.stoppedBecause).toBe("required_action_incomplete");
  });

  it("does not count a write the tool reported as failed", async () => {
    const t = tools();
    t.write.execute.mockImplementation(async () => ({ ok: false, output: "", error: "EACCES: permission denied" }) as never);
    const model = new Scripted((turn) =>
      turn === 1 ? call("read_file", { path: "src/parse.ts" })
      : turn === 2 ? call("write_file", { path: "src/parse.ts", content: "fixed" })
      : CLAIM);
    const result = await agent(model).run(task, t.list, ctx(createMirandaGate()));

    expect(result.stoppedBecause).toBe("required_action_incomplete");
  });

  it("finishes as done when the write really executed and succeeded", async () => {
    const t = tools();
    const model = new Scripted((turn) =>
      turn === 1 ? call("read_file", { path: "src/parse.ts" })
      : turn === 2 ? call("write_file", { path: "src/parse.ts", content: "fixed" })
      : CLAIM);
    const result = await agent(model).run(task, t.list, ctx(createMirandaGate()));

    expect(t.write.execute).toHaveBeenCalledTimes(1);
    expect(result.stoppedBecause).toBe("done");
  });
});

describe("the post-loop write rescue passes Miranda", () => {
  // Read once, answer inline (rejected: the task asks for a saved file), then
  // repeat the same read twice: the loop stops on turn 3 and the rescue runs.
  const rescueScript = (turn: number) =>
    turn === 1 ? call("read_file", { path: "src/parse.ts" })
    : turn === 2 ? CLAIM
    : `${call("read_file", { path: "src/parse.ts" })}\n<tool_call>${JSON.stringify({ tool: "read_file", path: "src/parse.ts" })}</tool_call>`;

  it("does not write when the task's permissions forbid file writes", async () => {
    const t = tools();
    const result = await agent(new Scripted(rescueScript)).run(task, t.list, ctx(readOnlyGate()));

    expect(t.write.execute).not.toHaveBeenCalled();
    expect(result.filesChanged).toEqual([]);
    expect(result.toolsUsed.filter((e) => e.tool === "write_file")).toEqual([expect.objectContaining({ ok: false })]);
    expect(result.stoppedBecause).not.toBe("done");
  });

  it("asks beforeToolRun and reports to afterToolRun when it does write", async () => {
    const t = tools();
    const real = createMirandaGate();
    const before = vi.fn(real.beforeToolRun);
    const after = vi.fn(real.afterToolRun);
    await agent(new Scripted(rescueScript)).run(task, t.list, ctx({ ...real, beforeToolRun: before, afterToolRun: after }));

    expect(t.write.execute).toHaveBeenCalledTimes(1);
    const gatedWrites = before.mock.calls.filter(([c]) => c.tool === "write_file");
    expect(gatedWrites).toHaveLength(1);
    expect(gatedWrites[0]![0].args).toMatchObject({ path: "src/parse.ts" });
    expect(after.mock.calls.filter(([c]) => c.tool === "write_file")).toHaveLength(1);
  });
});
