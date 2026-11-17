import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOrcaRuntime, createPappyPort } from "@clawde/orca-core";
import { createClaire } from "@clawde/claire-core";
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
function harness(kind = "conversation", root?: string, scriptedTool = false) {
  const brain = vi.fn(async () => ({ text: JSON.stringify({ routing: "direct", role: "narrator", contract: { kind, needs: kind === "inspect" ? ["filesystem-read"] : [] } }) }));
  const worker = vi.fn(async () => ({ content: scriptedTool && worker.mock.calls.length === 1
    ? 'TOOL_CALL: read_file {"path":"src/parse.ts"}' : "FINAL ANSWER:\nUse `[]`." }));
  const execute = vi.fn(async () => ({ ok: true, output: "export {};" }));
  const maestro = buildMaestroAdapter(new Map([["narrator", { name: "scripted", complete: worker } as unknown as LLMAdapter]]), [{ name: "read_file", description: "read", execute }]);
  const traces: any[] = [];
  const runtime = createOrcaRuntime({ maestro, pappy: createPappyPort(), llm: { complete: brain }, gate: createMirandaGate(), workspaceRoot: root, maxRepairPasses: 1,
    writeTrace: (trace) => { traces.push(...trace.entries); } });
  return { runtime, brain, worker, execute, traces };
}
const spec = (message: string, context?: Record<string, unknown>) => ({ originalUserMessage: message, intent: message, goals: [message], context });

describe("desktop contract routing through the runtime and Claire", () => {
  it("uses exactly Brain + answer, zero tools, and no narrator rewrite for a conversation (T4/T6)", async () => {
    const h = harness();
    const narrator = vi.fn(async () => "rewritten");
    let result: any;
    const claire = createClaire({ complete: narrator, executeTask: async (task) => result = await h.runtime.executeTask(task as any) });
    const reply = await claire.handleUserMessage("How do I create a list in Python?");
    expect(h.brain).toHaveBeenCalledTimes(1);
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools).toEqual([]);
    expect(result.contract.kind).toBe("conversation");
    expect(reply).toContain("Use `[]`.");
    expect(reply).toContain("not verified");
    expect(result.status).toBe("FAIL");
    expect(result.qcResult.verdict).toBe("FAIL");
    expect(result.qcResult.issues.length).toBeGreaterThan(0);
    for (const issue of result.qcResult.issues) expect(reply).toContain(issue.description);
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
  });

  it("raises a conversation naming an existing workspace file to inspect, retaining read tools (T3)", async () => {
    const h = harness("conversation", workspace());
    const result = await h.runtime.executeTask(spec("What does src/parse.ts do?"));
    expect(result.contract?.kind).toBe("inspect");
    expect(h.traces.find((t) => t.stage === "maestro.agent_dispatch").detail.tools.map((t: any) => t.name)).toEqual(["read_file"]);
  });
});
