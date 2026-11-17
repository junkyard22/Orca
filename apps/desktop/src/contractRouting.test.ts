import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOrcaRuntime, createPappyPort, buildAcceptanceContract } from "@clawde/orca-core";
import type { OrcaExecutionResult, OrcaRunCtx, OrcaTaskSpec, TaskContract } from "@clawde/orca-core";
import { createClaire } from "@clawde/claire-core";
import { createEmptyContextManifest } from "@clawde/dewey-core";
import { assessWorkspaceRoot, createMirandaGate } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";

// Import the real desktop adapter without starting Electron or registering IPC.
vi.mock("electron", () => ({
  app: { on: vi.fn(), requestSingleInstanceLock: () => false, quit: vi.fn(), getPath: () => tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {}, dialog: {}, Tray: {}, Menu: {}, nativeImage: {},
}));
import { buildMaestroAdapter } from "./main";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "orca-routing-")); roots.push(root);
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "parse.ts"), "export {};\n");
  return root;
}
function harness(kind = "conversation", root?: string, scriptedTool = false, doneCriteria: string[] = []) {
  const brain = vi.fn(async () => ({ text: JSON.stringify({ routing: "direct", role: "narrator", done_criteria: doneCriteria, contract: { kind, needs: kind === "inspect" ? ["filesystem-read"] : [] } }) }));
  const worker = vi.fn(async () => ({ content: scriptedTool && worker.mock.calls.length === 1
    ? '<tool_call>{"tool":"read_file","path":"src/parse.ts"}</tool_call>' : "FINAL ANSWER:\nUse `[]`." }));
  const execute = vi.fn(async (input: Record<string, unknown>, context: { workspaceRoot?: string }) => ({
    ok: true, output: readFileSync(join(context.workspaceRoot!, String(input.path)), "utf8"),
  }));
  const maestro = buildMaestroAdapter(new Map([["narrator", { name: "scripted", complete: worker } as unknown as LLMAdapter]]), [{ name: "read_file", description: "read", execute }]);
  const traces: any[] = [];
  const contracts: Array<TaskContract | undefined> = [];
  const contexts: OrcaRunCtx[] = [];
  const pappy = createPappyPort();
  const evaluate = vi.spyOn(pappy, "evaluate");
  const runtime = createOrcaRuntime({ maestro: { run: async (task, ctx) => {
    contexts.push(ctx);
    const result = await maestro.run(task, ctx);
    contracts.push(ctx.taskContract);
    return result;
  } }, pappy, llm: { complete: brain }, gate: createMirandaGate(), workspaceRoot: root, maxRepairPasses: 1,
    writeTrace: (trace) => { traces.push(...trace.entries); } });
  return { runtime, brain, worker, execute, traces, contracts, contexts, evaluate };
}
const spec = (message: string, context?: Record<string, unknown>) => ({ originalUserMessage: message, intent: message, goals: [message], context });

describe("desktop contract routing through the runtime and Claire", () => {
  it("answers a decomposed conversation once, without a synthesis call", async () => {
    const h = harness();
    h.brain.mockResolvedValue({ text: JSON.stringify({ routing: "decompose", departments: [
      { head: "reader", subtask: "Describe monads" }, { head: "narrator", subtask: "Give an example" },
    ], contract: { kind: "conversation", needs: [] } }) });
    const result = await h.runtime.executeTask(spec("What is a monad?"));
    expect(result.userFacingText).toBe("Use `[]`.");
    expect(result.qcResult).toBeDefined();
    expect(h.traces.find((t) => t.stage === "brain.route.final").detail.path).toBe("decompose");
    expect(h.brain).toHaveBeenCalledTimes(1);
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect(h.traces.filter((t) => t.stage === "maestro.agent_dispatch")).toHaveLength(1);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("records an attempted unavailable tool without executing it or asking to add tools (C8)", async () => {
    const h = harness("conversation", undefined, true);
    const result = await h.runtime.executeTask(spec("What is a monad?"));
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.brain).toHaveBeenCalledTimes(1);
    expect(h.worker).toHaveBeenCalledTimes(2);
    expect(result.followUpQuestion).toBeUndefined();
    const pass = h.traces.find((t) => t.stage === "maestro.run.result").detail.result;
    expect(pass.toolEvents).toContainEqual(expect.objectContaining({ tool: "read_file", ok: false, summary: "Unknown tool: read_file" }));
    expect(pass.metadata.roleToolNames).toEqual([]);
  });

  it("keeps the original contract and acceptance standard through repair, before every worker", async () => {
    const criteria = ["Explain src/parse.ts exports"];
    const h = harness("inspect", workspace(), true, criteria);
    const request = spec("Explain src/parse.ts");
    const result = await h.runtime.executeTask(request);
    expect(h.contracts).toHaveLength(2);
    expect(h.contracts[0]).toBe(result.contract);
    expect(h.contracts[1]).toBe(result.contract);
    expect(result.contract?.request).toBe(request.originalUserMessage);
    expect(result.contract?.acceptance).toEqual(buildAcceptanceContract(request, criteria));
    expect(h.contexts[0].acceptanceContract).toBe(result.contract?.acceptance);
    expect(Object.isFrozen(result.contract?.acceptance.goals)).toBe(true);
    expect(h.brain).toHaveBeenCalledTimes(1);
    const stages = h.traces.map((t) => t.stage);
    expect(stages.indexOf("task.contract")).toBeLessThan(stages.indexOf("maestro.agent_dispatch"));
    expect(stages.filter((s) => s === "task.contract")).toHaveLength(1);
  });
  it("uses exactly Brain + answer, zero tools, and no narrator rewrite for a conversation (T4/T6)", async () => {
    const h = harness();
    const narrator = vi.fn(async () => "rewritten");
    let result!: OrcaExecutionResult;
    const claire = createClaire({ complete: narrator, executeTask: async (task) => result = await h.runtime.executeTask(task as OrcaTaskSpec) });
    const reply = await claire.handleUserMessage("How do I create a list in Python?");
    expect(h.brain).toHaveBeenCalledTimes(1);
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools).toEqual([]);
    expect(result.contract?.kind).toBe("conversation");
    expect(reply).toContain("Use `[]`.");
    expect(reply).toContain("not verified");
    expect(result.status).toBe("FAIL");
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(result.qcResult!.issues.length).toBeGreaterThan(0);
    for (const issue of result.qcResult!.issues) expect(reply).toContain(issue.description);
    expect(h.traces).toContainEqual(expect.objectContaining({ stage: "repair.skipped", detail: { reason: "conversation" } }));
    expect(narrator).not.toHaveBeenCalled();
    expect(JSON.stringify(h.worker.mock.calls)).not.toContain("you have not called any tools");
    expect(h.traces.filter((t) => t.stage === "task.contract")).toHaveLength(1);
  });

  it.each(["none", "missing", "file"])("stops after Brain with existing workspace guidance: %s", async (mode) => {
    const root = mode === "none" ? undefined : mode === "missing" ? join(workspace(), "absent") : join(workspace(), "src", "parse.ts");
    const h = harness("inspect", root);
    const result = await h.runtime.executeTask(spec("Explain the current module"));
    expect(h.brain).toHaveBeenCalledTimes(1);
    expect(h.worker).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(result.followUpQuestion).toBe(`I can't read, change or run anything in a project yet: ${assessWorkspaceRoot(root).message} Then send your request again.`);
    expect(h.traces.find((t) => t.stage === "maestro.run.result").detail.result.toolEvents).toEqual([
      { tool: "workspace_precheck", ok: false, summary: `Workspace required:${assessWorkspaceRoot(root).message}` },
    ]);
  });

  it("runs an inspection with a usable workspace and retains its read tools", async () => {
    const h = harness("inspect", workspace(), true);
    const result = await h.runtime.executeTask(spec("Explain src/parse.ts"));
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(result.followUpQuestion).toBeUndefined();
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools.map((t: any) => t.name)).toEqual(["read_file"]);
  });

  it.each(["file", "repository"])("preserves the inspection floor for Cargo %s attachments", async (kind) => {
    const manifest = createEmptyContextManifest();
    if (kind === "file") manifest.files.push({ id: "file", path: "src/parse.ts", kind: "file" } as never);
    else manifest.workspace = { repository: "owner/repo" } as never;
    const h = harness("conversation", workspace());
    const result = await h.runtime.executeTask(spec("Explain the attached material", { contextManifest: manifest }));
    expect(result.contract?.kind).toBe("inspect");
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools.map((t: any) => t.name)).toEqual(["read_file"]);
  });

  it("keeps the role's actual ceiling and inferred task permissions in force", async () => {
    const h = harness("inspect", workspace());
    const task = { ...spec("Explain src/parse.ts"), permissions: { fileRead: false, fileWrite: false, shellExec: false, toolsAllowed: [] } };
    const result = await h.runtime.executeTask(task);
    expect(result.contract?.authority.available).toEqual([]);
    expect(result.contract?.authority.withheld).toContainEqual({ capability: "filesystem-read", reason: "settings" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("raises a conversation naming an existing workspace file to inspect, retaining read tools (T3)", async () => {
    const h = harness("conversation", workspace());
    const result = await h.runtime.executeTask(spec("What does src/parse.ts do?"));
    expect(result.contract?.kind).toBe("inspect");
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools.map((t: any) => t.name)).toEqual(["read_file"]);
  });
});
