/**
 * Unit coverage for the worker-protocol corrections made after the 1.7.0 live
 * rehearsal: one tool call per response, command context on failures, the
 * workspace-boundary explanation, and the code-fence fallback that no longer
 * dispatches ordinary code as a tool.
 */
import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";
import type { RoleName } from "maestro-core";
import { enforceToolCallBatch, ReactAgentAdapter, withCommandContext } from "./ReactAgentAdapter";

class Scripted implements LLMAdapter {
  requests: LLMRequest[] = [];
  constructor(private responses: string[]) {}
  get name() { return "scripted"; }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    return { content: this.responses[this.requests.length - 1] ?? "FINAL ANSWER: done", usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 } };
  }
  async stream(request: LLMRequest, onToken: (c: string) => void): Promise<LLMResponse> {
    const r = await this.complete(request); onToken(r.content); return r;
  }
}

const pass = { allowed: true, reason: "ok", verdict: "PASS" as const };
function ctx(overrides: Partial<OrcaRunCtx> = {}): OrcaRunCtx & { traces: Array<{ stage: string; detail: unknown }> } {
  const traces: Array<{ stage: string; detail: unknown }> = [];
  return {
    llm: {} as never,
    runId: "r",
    workspaceRoot: "/ws/project",
    gate: { beforeLLMCall: () => pass, afterLLMCall: () => pass, beforeToolRun: () => pass, afterToolRun: () => pass, beforeQC: () => pass, afterQC: () => pass },
    recordTrace: (stage: string, detail: unknown) => { traces.push({ stage, detail }); },
    traces,
    ...overrides,
  } as never;
}
const tool = (name: string, impl: (input: Record<string, unknown>) => { ok: boolean; output: string; error?: string }) => ({
  name, description: name, schema: { properties: {} }, execute: vi.fn(async (input: Record<string, unknown>) => impl(input)),
});
const call = (body: Record<string, unknown>) => `<tool_call>${JSON.stringify(body)}</tool_call>`;
const task = { intent: "Inspect the project", goals: ["Inspect the project"], doneCriteria: ["Report"] };

describe("enforceToolCallBatch", () => {
  it("calls written back to back (only whitespace between) run as a batch; nothing is cut", () => {
    const out = `Thought
${call({ tool: "a" })}

${call({ tool: "b" })}`;
    expect(enforceToolCallBatch(out, [c("a"), c("b")])).toEqual({ calls: [c("a"), c("b")], output: out, dropped: 0 });
  });
  it("text after a call ends the batch: earlier adjacent calls run, the rest is cut", () => {
    const out = `${call({ tool: "a" })}${call({ tool: "b" })}
Result: invented
${call({ tool: "c" })}
FINAL ANSWER: x`;
    const r = enforceToolCallBatch(out, [c("a"), c("b"), c("c")]);
    expect(r.calls).toEqual([c("a"), c("b")]);
    expect(r.dropped).toBe(1);
    expect(r.output).toBe(`${call({ tool: "a" })}${call({ tool: "b" })}`);
  });
  it("when a block did not parse, the batch cannot be mapped: only the first call runs", () => {
    const out = `${call({ tool: "a" })}<tool_call>not json</tool_call>${call({ tool: "b" })}`;
    const r = enforceToolCallBatch(out, [c("a"), c("b")]);
    expect(r.calls).toEqual([c("a")]);
    expect(r.output).toBe(call({ tool: "a" }));
  });
  const c = (tool: string) => ({ tool, input: {} });
  it("leaves zero or one call untouched", () => {
    expect(enforceToolCallBatch("text", [])).toEqual({ calls: [], output: "text", dropped: 0 });
    const one = `${call({ tool: "a" })}\nFINAL ANSWER: x`;
    expect(enforceToolCallBatch(one, [c("a")])).toEqual({ calls: [c("a")], output: one, dropped: 0 });
  });
  it("keeps the first call and cuts the output right after its closing tag", () => {
    const out = `Thought\n${call({ tool: "a" })}\nResult: invented\n${call({ tool: "b" })}\nFINAL ANSWER: claimed`;
    const r = enforceToolCallBatch(out, [c("a"), c("b")]);
    expect(r.calls).toEqual([c("a")]);
    expect(r.dropped).toBe(1);
    expect(r.output).toBe(`Thought\n${call({ tool: "a" })}`);
  });
  it("without a closing tag (code-fence recovery) keeps the text and still runs only the first call", () => {
    const r = enforceToolCallBatch("```\n{}\n```", [c("a"), c("b")]);
    expect(r).toEqual({ calls: [c("a")], output: "```\n{}\n```", dropped: 1 });
  });
});

describe("withCommandContext", () => {
  it("adds the command and where it ran to a failed run_command", () => {
    expect(withCommandContext("run_command", { command: "cd project && npm test" }, "/ws/project", "Command failed with exit code 1"))
      .toBe("Command failed with exit code 1\ncommand: cd project && npm test\ncwd: (workspace root) — workspace root: /ws/project");
    expect(withCommandContext("run_command", { command: "npm test", cwd: "pkg" }, undefined, undefined))
      .toBe("Command failed\ncommand: npm test\ncwd: pkg");
  });
  it("leaves other tools alone", () => {
    expect(withCommandContext("read_file", { path: "x" }, "/ws", "ENOENT")).toBe("ENOENT");
  });
});

describe("ReactAgentAdapter worker protocol", () => {
  it("several calls with invented results: only the first runs; the stored turn ends at its call; the model is told", async () => {
    const list = tool("list_directory", () => ({ ok: true, output: "d  src/" }));
    const read = tool("read_file", () => ({ ok: true, output: "real content" }));
    const model = new Scripted([
      `${call({ tool: "list_directory", path: "." })}\nResult: invented\n${call({ tool: "read_file", path: "x" })}\nFINAL ANSWER: all done`,
      "FINAL ANSWER: listed the project.",
    ]);
    const c = ctx();
    const result = await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [list, read] as never, c);
    expect(list.execute).toHaveBeenCalledTimes(1);
    expect(read.execute).not.toHaveBeenCalled();
    const second = model.requests[1]!.messages;
    expect(second.find((m) => m.role === "assistant")!.content).toBe(call({ tool: "list_directory", path: "." }));
    expect(second.at(-1)!.content).toMatch(/Only your first tool call \(list_directory\) was executed; the other 1 call/);
    // The premature "all done" was not taken as the answer.
    expect(result.outputText).toBe("listed the project.");
    expect(c.traces.some((t) => t.stage === "agent.tool.extra_calls_dropped")).toBe(true);
  });

  it("two back-to-back reads run together; no note; their real outputs are the evidence", async () => {
    const a = tool("read_file", (input) => ({ ok: true, output: `real:${input["path"]}` }));
    const model = new Scripted([`${call({ tool: "read_file", path: "a.txt" })}
${call({ tool: "read_file", path: "b.txt" })}`, "FINAL ANSWER: read both."]);
    const c = ctx();
    const result = await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [a] as never, c);
    expect(a.execute).toHaveBeenCalledTimes(2);
    expect(c.traces.some((t) => t.stage === "agent.tool.extra_calls_dropped")).toBe(false);
    expect(model.requests[1]!.messages.some((m) => /Only your first/.test(m.content))).toBe(false);
    expect(result.toolsUsed.map((e) => (e.raw as Record<string, unknown>)["_outputForProof"])).toEqual(["real:a.txt", "real:b.txt"]);
  });

  it("cancellation during a batch stops dispatch: no later call in the batch starts", async () => {
    const controller = new AbortController();
    const first = tool("read_file", () => { controller.abort(new Error("Task cancelled by user")); return { ok: true, output: "a" }; });
    const second = tool("write_file", () => ({ ok: true, output: "should never run" }));
    const model = new Scripted([`${call({ tool: "read_file", path: "a.txt" })}
${call({ tool: "write_file", path: "b.txt", content: "x" })}`, "FINAL ANSWER: done."]);
    await expect(new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run({ ...task, intent: "Write b.txt" }, [first, second] as never, ctx({ abortSignal: controller.signal })))
      .rejects.toThrow(/cancel/i);
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
  });

  it("invented Result text never becomes tool evidence: only the host's real output is recorded", async () => {
    const read = tool("read_file", () => ({ ok: true, output: "REAL CONTENT" }));
    const run = tool("run_command", () => ({ ok: true, output: "should never run" }));
    const model = new Scripted([`${call({ tool: "read_file", path: "x" })}
Result: INVENTED CONTENT
${call({ tool: "run_command", command: "node --test" })}
Result: 5 passed`, "FINAL ANSWER: done."]);
    const result = await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [read, run] as never, ctx());
    expect(run.execute).not.toHaveBeenCalled();
    expect(result.toolsUsed).toHaveLength(1);
    expect(JSON.stringify(result.toolsUsed)).not.toMatch(/INVENTED|5 passed/);
    expect((result.toolsUsed[0]!.raw as Record<string, unknown>)["_outputForProof"]).toBe("REAL CONTENT");
  });

  it("one call followed by FINAL ANSWER in the same response behaves as before (no truncation, no note)", async () => {
    const write = tool("write_file", () => ({ ok: true, output: "Wrote 3 bytes" }));
    const model = new Scripted([`${call({ tool: "write_file", path: "a.txt", content: "abc" })}\nFINAL ANSWER: wrote a.txt`]);
    const c = ctx();
    const result = await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run({ ...task, intent: "Write a.txt" }, [write] as never, c);
    expect(write.execute).toHaveBeenCalledTimes(1);
    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toBe("wrote a.txt");
    expect(c.traces.some((t) => t.stage === "agent.tool.extra_calls_dropped")).toBe(false);
  });

  it("repeating the same invalid command across responses still trips loop detection", async () => {
    const run = tool("run_command", () => ({ ok: false, output: "[Exit code 1]\nThe system cannot find the path specified.", error: "Command failed with exit code 1" }));
    const bad = call({ tool: "run_command", command: "cd project && npm test" });
    const model = new Scripted([bad, bad, bad, bad, bad]);
    const result = await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [run] as never, ctx());
    expect(result.stoppedBecause).toBe("loop_detected");
    expect((run.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
    // Each failure carried the command and where it ran.
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("command: cd project && npm test");
  });

  it("a proposed fix in a code fence is not dispatched as a tool named after its first word", async () => {
    const model = new Scripted([
      "ROOT CAUSE: x\n\nFIX:\n```js\nfunction parse(text) {\n  return 0;\n}\n```\n",
      "FINAL ANSWER: proposed a fix.",
    ]);
    const c = ctx();
    await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [tool("read_file", () => ({ ok: true, output: "" }))] as never, c);
    expect(c.traces.some((t) => t.stage === "agent.tool.unknown")).toBe(false);
  });

  it("a workspace-boundary refusal tells the model where the workspace is", async () => {
    const run = tool("run_command", () => ({ ok: true, output: "" }));
    const c = ctx({
      gate: {
        beforeLLMCall: () => pass, afterLLMCall: () => pass, afterToolRun: () => pass, beforeQC: () => pass, afterQC: () => pass,
        beforeToolRun: () => ({ allowed: false, reason: 'Workspace boundary blocked tool "run_command"', verdict: "BLOCK" as const }),
      } as never,
    });
    const model = new Scripted([call({ tool: "run_command", command: "npm test", cwd: "/ws" }), "FINAL ANSWER: blocked."]);
    await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [run] as never, c);
    expect(run.execute).not.toHaveBeenCalled();
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/outside the workspace root \(\/ws\/project\)\. Use paths and a cwd inside it\./);
  });

  it("the task prompt states the workspace semantics", async () => {
    const model = new Scripted(["FINAL ANSWER: ok"]);
    await new ReactAgentAdapter(model, "sys", "debugger" as RoleName).run(task, [] as never, ctx());
    const prompt = model.requests[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("Every tool already runs inside the workspace root: /ws/project");
    expect(prompt).toMatch(/do not `cd` into the workspace folder/);
  });
});
