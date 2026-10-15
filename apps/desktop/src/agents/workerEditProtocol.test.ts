/**
 * The 1.7.0 live rehearsal's coding task, end to end, with everything real
 * except the model: the production worker loop (ReactAgentAdapter), the real
 * workbench tools (read_file, write_file, run_command, list_directory) on a
 * disposable copy of the rehearsal project, the production constraint rule
 * and Miranda gate, the real runtime (lifecycle, workspace evidence) and the
 * real Pappy port.
 *
 * The scripted model replays what claude-sonnet-4-6 did live — several tool
 * calls in one response with invented results between them, the workspace
 * folder's name as a path prefix, `cd project && …`, a success claim — and
 * then the steps a capable worker takes. What these tests prove: when the
 * model chooses the right tools, Orca now lets the edit land, runs the tests
 * on the final source and Pappy verifies it; when the model claims success
 * without the work, Pappy still refuses. What they do NOT prove: that a real
 * model will choose the right tools. That needs a live rehearsal.
 *
 * Approvals are answered by `requestToolApproval: async () => true`, standing
 * in for a human click; the desktop's native dialog is not involved.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import { AHPLifecycle, createChildPacket, createOrcaRuntime, createPappyPort, createWorkspaceGuard, exportTrainingData, registerChildOnRoot } from "@clawde/orca-core";
import type { MaestroPort, OrcaPipelineTrace, OrcaRunCtx, OrcaStore, OrcaTaskSpec, ResourceProbe, RunRecord, UnsettledResource, WorkspaceGuard } from "@clawde/orca-core";
import { listDirectoryTool, probeProcess, readFileTool, runCommandTool, writeFileTool } from "@yakstacks/workbench-core";
import type { RoleName } from "maestro-core";
import { ReactAgentAdapter } from "./ReactAgentAdapter";
import { composeMirandaGates } from "../llmGate";
import { constraintGateFor, workerMustNotWriteFiles } from "../workerConstraints";
import { verificationGuidance } from "../verificationGuidance";

const BUGGY = `"use strict";

/**
 * parse(text) — parse a decimal integer from a string.
 * Returns 0 for an empty or whitespace-only string.
 * Throws RangeError for anything that is not an integer.
 */
function parse(text) {
  const trimmed = String(text).trim();
  const value = parseInt(trimmed, 10);
  if (!Number.isInteger(value) || String(value) !== trimmed) {
    throw new RangeError(\`not an integer: \${JSON.stringify(text)}\`);
  }
  return value;
}

module.exports = { parse };
`;
const FIXED = BUGGY.replace("  const value = parseInt(trimmed, 10);", "  if (trimmed === \"\") return 0;\n  const value = parseInt(trimmed, 10);");
const TESTS = `"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../src/parse.js");

test("parses a plain integer", () => { assert.equal(parse("42"), 42); });
test("trims surrounding whitespace", () => { assert.equal(parse("  7 "), 7); });
test("returns 0 for an empty string", () => { assert.equal(parse(""), 0); });
test("returns 0 for a whitespace-only string", () => { assert.equal(parse("   "), 0); });
test("rejects a non-integer", () => { assert.throws(() => parse("abc"), RangeError); });
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The rehearsal project, in a folder literally called "project". */
function project(): string {
  const parent = mkdtempSync(join(tmpdir(), "orca-worker-"));
  dirs.push(parent);
  const root = join(parent, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "orca-rehearsal-parse", private: true, scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(root, "src", "parse.js"), BUGGY);
  writeFileSync(join(root, "test", "parse.test.js"), TESTS);
  return root;
}

function hostTestRun(root: string): { pass: number; fail: number } {
  const r = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8" });
  const out = `${r.stdout}\n${r.stderr}`;
  return { pass: Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? -1), fail: Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? -1) };
}

/** Goals as Pappy receives them in the desktop flow: Brain's done criteria (live A1–A3 traces). */
const LIVE_CRITERIA = ["The failing test in src/parse.js is identified and fixed", "Tests are run and all pass after the fix"];
const spec = (root: string, message: string, goals: string[] = [message]): OrcaTaskSpec => ({
  originalUserMessage: message,
  intent: message.toLowerCase(),
  goals,
  permissions: { fileRead: true, fileWrite: true, shellExec: true, networkAccess: false },
  context: { workspaceRoot: root },
} as unknown as OrcaTaskSpec);

class ScriptedModel implements LLMAdapter {
  requests: LLMRequest[] = [];
  constructor(private responses: string[], private onCall?: (index: number) => void) {}
  get name() { return "scripted"; }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const index = this.requests.length;
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    this.onCall?.(index);
    return { content: this.responses[index] ?? "FINAL ANSWER: (script exhausted)", usage: { totalTokens: 100, promptTokens: 60, completionTokens: 40 } };
  }
  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
    const r = await this.complete(request);
    onToken(r.content);
    return r;
  }
}

/**
 * The desktop's worker step, assembled from production pieces: the packet
 * carries the constraint chosen by `workerMustNotWriteFiles` and the evidence
 * guidance; the worker's gate is the runtime gate composed with the packet's
 * constraint gate; the worker is ReactAgentAdapter with real tools.
 */
type Observed = { prompt?: string; constraints?: string[]; repairPrompt?: string };

class MemoryStore {
  runs: RunRecord[] = [];
  saveRun(run: RunRecord) { this.runs.push(run); }
  getRecentRuns() { return this.runs; }
  getRun(id: string) { return this.runs.find((r) => r.id === id) ?? null; }
  getRunThoughts() { return []; }
  getRunToolEvents() { return []; }
  deleteRun() {}
  searchRuns() { return []; }
  getStats() { return { totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 }; }
  close() {}
}

function desktopWorker(model: LLMAdapter, task: OrcaTaskSpec, observed: Observed, onPassEnd?: (ctx: OrcaRunCtx) => void): MaestroPort {
  return {
    run: async (passTask, ctx: OrcaRunCtx) => {
      const repairing = passTask.intent === "repair";
      const objective = task.originalUserMessage!;
      const constraints = workerMustNotWriteFiles(task, objective.toLowerCase()) ? [{ rule: "no_file_writes", enforcer: "miranda" }] : [];
      const guidance = verificationGuidance(objective);
      const packet = createChildPacket(ctx.ahpRootPacket!.id, {
        id: `${ctx.runId}_debugger_0`,
        objective,
        inputs: [
          ...guidance.map((value, i) => ({ id: `guidance-${i}`, type: "goal", value })),
          { id: "context-0", type: "context", value: `Workspace: project (${ctx.workspaceRoot})` },
          // A repair pass carries the repair instruction built from Pappy's issues, as main.ts does.
          ...(repairing ? [{ id: "repair-directive", type: "repair_directive", value: passTask.originalUserMessage ?? "" }] : []),
        ],
        constraints,
        expectedOutput: { schema: {}, acceptanceCriteria: ["The failing test in src/parse.js is fixed", "Tests are run and all pass after the fix"] },
      });
      // As main.ts does before dispatch: registered on the root and authorised to run.
      registerChildOnRoot(ctx.ahpRootPacket!, packet);
      packet.lifecycle = AHPLifecycle.RUNNING;
      observed.constraints = packet.constraints.map((c) => c.rule);
      const worker = new ReactAgentAdapter(model, "You are the Debugger.", "debugger" as RoleName);
      const result = await worker.run(
        { intent: objective, goals: [objective], doneCriteria: packet.expectedOutput.acceptanceCriteria },
        [readFileTool, writeFileTool, runCommandTool, listDirectoryTool] as never,
        { ...ctx, gate: composeMirandaGates(ctx.gate, constraintGateFor(packet)), ahpPacket: packet } as never,
      );
      onPassEnd?.(ctx);
      const requests = (model as ScriptedModel).requests;
      if (repairing) observed.repairPrompt = String(requests.at(-1)?.messages.map((m) => m.content).join("\n\n") ?? "");
      else observed.prompt = String(requests[0]?.messages.map((m) => m.content).join("\n\n") ?? "");
      return {
        outputText: result.outputText,
        toolEvents: result.toolsUsed,
        filesChanged: result.filesChanged,
        metadata: { role: "debugger", stoppedBecause: result.stoppedBecause, iterationCount: result.iterationCount },
      };
    },
  };
}

type RuntimeOpts = {
  maxRepairPasses?: number;
  store?: MemoryStore;
  /** As main.ts wires it: survivors are re-probed before evidence and at task end. */
  processProbe?: ResourceProbe;
  resourceSettleWaitMs?: number;
  workspaceGuard?: WorkspaceGuard;
  /** Stands in for what the survivor scan reported after the worker's commands. */
  onPassEnd?: (ctx: OrcaRunCtx) => void;
};

function runtimeFor(model: LLMAdapter, task: OrcaTaskSpec, observed: Observed, traces: OrcaPipelineTrace[], opts: RuntimeOpts = {}) {
  return createOrcaRuntime({
    maestro: desktopWorker(model, task, observed, opts.onPassEnd),
    ...(opts.processProbe ? { processProbe: opts.processProbe } : {}),
    ...(opts.resourceSettleWaitMs !== undefined ? { resourceSettleWaitMs: opts.resourceSettleWaitMs } : {}),
    ...(opts.workspaceGuard ? { workspaceGuard: opts.workspaceGuard } : {}),
    pappy: createPappyPort(),
    llm: { complete: async () => ({ text: "" }), stream: async () => ({ text: "" }) } as never,
    maxRepairPasses: opts.maxRepairPasses ?? 0,
    ...(opts.store ? { store: opts.store as unknown as OrcaStore } : {}),
    requestToolApproval: async () => true,
    writeTrace: (t) => { traces.push(t); },
  });
}

const call = (body: Record<string, unknown>) => `<tool_call>${JSON.stringify(body)}</tool_call>`;
const stagesOf = (t: OrcaPipelineTrace, stage: string) => t.entries.filter((e) => e.stage === stage);

async function rehearsalFix(goals?: string[], store?: MemoryStore, extra: Omit<RuntimeOpts, "store"> = {}) {
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message, goals ?? [message]);
    const model = new ScriptedModel([
      // What the live model did: several calls, invented results, a premature claim.
      `${call({ tool: "list_directory", path: "project" })}\n\nResult: {"entries":[{"name":"src","type":"directory"}]}\n\n` +
        `${call({ tool: "read_file", path: "project/src/parse.js" })}\n\nResult: function parseQueryString(qs) { return {}; }\n\n` +
        `${call({ tool: "run_command", command: "cd project && npm test" })}\n\nFINAL ANSWER: Fixed parseQueryString; all tests pass.`,
      call({ tool: "read_file", path: "src/parse.js" }),
      call({ tool: "run_command", command: "cd project && node --test" }),
      call({ tool: "run_command", command: "node --test" }),
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      call({ tool: "run_command", command: "node --test" }),
      "FINAL ANSWER: Root cause: parse('') threw a RangeError because parseInt('') is NaN. Changed parse in src/parse.js to return 0 for empty or whitespace-only input. node --test: 5 passed, 0 failed.",
    ]);
    const observed: Observed = {};
    const traces: OrcaPipelineTrace[] = [];
    const result = await runtimeFor(model, task, observed, traces, { store, ...extra }).executeTask(task);
    const trace = traces[0]!;
    return { root, model, observed, result, trace };
}

describe("worker edit protocol (deterministic, real tools, real Pappy)", () => {
  it("replays the rehearsal's mistakes, recovers, edits src/parse.js and runs the tests on the final source; Pappy records the evidence", async () => {
    const { root, model, observed, result, trace } = await rehearsalFix();

    // The bug-fix worker is not forbidden to write, and is told where it is.
    expect(observed.constraints).toEqual([]);
    expect(observed.prompt).not.toMatch(/no_file_writes/);
    expect(observed.prompt).toContain("### Workspace");
    expect(observed.prompt).toContain(`Every tool already runs inside the workspace root: ${root}`);
    expect(observed.prompt).toMatch(/do not `cd` into the workspace folder/);
    expect(observed.prompt).toMatch(/Before changing any source code, run the project's full test suite/);

    // Response 1: only the first call ran; invented results and the premature claim were cut from the conversation.
    expect(stagesOf(trace, "agent.tool.extra_calls_dropped")[0]?.detail).toMatchObject({ executed: ["list_directory"], dropped: 2 });
    const secondRequest = model.requests[1]!.messages;
    const firstAssistant = secondRequest.find((m) => m.role === "assistant")!.content;
    expect(firstAssistant.endsWith("</tool_call>")).toBe(true);
    expect(firstAssistant).not.toMatch(/parseQueryString|FINAL ANSWER|Result:/);
    expect(secondRequest.some((m) => m.role === "user" && /Only your first tool call \(list_directory\) was executed/.test(m.content))).toBe(true);
    // "project" (the workspace's own name) listed the workspace root.
    const firstResult = secondRequest.find((m) => m.role === "user" && /<tool_result tool="list_directory" ok="true">/.test(m.content));
    expect(firstResult?.content).toMatch(/src\//);

    // The failed `cd project && …` came back with the command and where it ran.
    const afterCd = model.requests[3]!.messages.at(-1)!.content;
    expect(afterCd).toMatch(/<tool_result tool="run_command" ok="false">/);
    expect(afterCd).toContain("command: cd project && node --test");
    expect(afterCd).toContain(`cwd: (workspace root) — workspace root: ${root}`);

    // The edit landed and nothing was blocked.
    expect(stagesOf(trace, "agent.tool.blocked")).toHaveLength(0);
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(FIXED);
    expect(hostTestRun(root)).toEqual({ pass: 5, fail: 0 });

    // Pappy saw exactly the evidence a bug fix needs.
    expect(result.qcResult?.verification?.testEvidence).toBe(true);
    expect(result.qcResult?.verification?.behaviouralEvidence?.join(" ")).toMatch(/reproduced then resolved[\s\S]*passes on the final source/);
  }, 60_000);

  // Was a KNOWN GAP (it.fails) until the behavioural-criteria correction in
  // pappy-core: the genuine fix is now verified under both criteria phrasings.
  for (const [label, goals] of [["the user's goal", undefined], ["Brain's live done criteria", LIVE_CRITERIA]] as const) {
    it(`Pappy verifies the genuine fix from host evidence (criteria: ${label}) and Moonshiner exports it as a positive example`, async () => {
      const store = new MemoryStore();
      const { result } = await rehearsalFix(goals as string[] | undefined, store);
      expect(result.qcResult?.verdict).toBe("PASS");
      expect(result.qcResult?.verification?.status).toBe("verified");
      expect(result.qcResult?.trainingEligibility).toBe("eligible");
      expect(result.lifecycle?.state).toBe("COMPLETED");
      expect(result.qcResult?.receipt_ledger.every((e) => e.status === "PROVED")).toBe(true);
      // verdict → eligibility tag → export: the run is a positive example.
      expect(store.runs[0]?.summary).toMatch(/training_eligibility=eligible/);
      expect(store.runs[0]?.summary).toMatch(/evidence=verified/);
      const dir = mkdtempSync(join(tmpdir(), "orca-export-")); dirs.push(dir);
      const exported = await exportTrainingData(store as unknown as OrcaStore, { outputPath: join(dir, "pass.jsonl") } as never);
      expect(exported.exported).toBeGreaterThanOrEqual(1);
      const records = readFileSync(join(dir, "pass.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(records[0]).toMatchObject({ score: 10, metadata: { verdict: "PASS", outcome: "success" } });
    }, 60_000);
  }

  it("a repair pass receives Pappy's real findings and completes the fix → verified", async () => {
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message, LIVE_CRITERIA);
    const model = new ScriptedModel([
      // Pass 1: reproduces, makes a wrong edit, re-runs (still 3 pass / 2 fail) and reports it honestly.
      call({ tool: "run_command", command: "node --test" }),
      call({ tool: "write_file", path: "src/parse.js", content: BUGGY.replace("  const trimmed = String(text).trim();", "  const trimmed = String(text).trim();\n  // attempted fix") }),
      call({ tool: "run_command", command: "node --test" }),
      "FINAL ANSWER: I changed src/parse.js but node --test still reports 3 passed, 2 failed (empty and whitespace-only input).",
      // Repair pass: edits and re-runs.
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      call({ tool: "run_command", command: "node --test" }),
      "FINAL ANSWER: Changed parse in src/parse.js to return 0 for empty or whitespace-only input. node --test: 5 passed, 0 failed.",
    ]);
    const observed: Observed = {};
    const traces: OrcaPipelineTrace[] = [];
    const store = new MemoryStore();
    const result = await runtimeFor(model, task, observed, traces, { maxRepairPasses: 1, store }).executeTask(task);
    // The repair worker was told what the host evidence showed, not what the worker claimed.
    expect(observed.repairPrompt).toMatch(/### Repair Directive/);
    expect(observed.repairPrompt).toMatch(/final full test run failed|FIX_TESTS_FAILING|2 of 5 tests failing/i);
    expect(observed.repairPrompt).not.toMatch(/no_file_writes/);
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(FIXED);
    expect(result.qcResult?.verdict).toBe("PASS");
    expect(result.qcResult?.verification?.status).toBe("verified");
    expect(store.runs[0]?.repairPasses).toBe(1);
  }, 60_000);

  it("a worker that runs the failing tests and claims success without editing is refused (contradicted, FAIL, not eligible)", async () => {
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message);
    const model = new ScriptedModel([
      call({ tool: "read_file", path: "src/parse.js" }),
      call({ tool: "run_command", command: "node --test" }),
      "FINAL ANSWER: Fixed parse in src/parse.js. node --test: 5 passed, 0 failed.",
    ]);
    const traces: OrcaPipelineTrace[] = [];
    const result = await runtimeFor(model, task, {}, traces).executeTask(task);
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(BUGGY);
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(result.qcResult?.verification?.status).toBe("contradicted");
    expect(result.qcResult?.trainingEligibility).not.toBe("eligible");
    expect(result.qcResult?.issues.some((i) => i.code === "FIX_SOURCE_CHANGE_MISSING")).toBe(true);
    // Neither a positive nor (being a false claim) a negative training example.
    const store = new MemoryStore();
    store.saveRun({ id: "claim", createdAt: new Date().toISOString(), intent: message, status: "FAIL", verdict: result.qcResult!.verdict, summary: result.qcResult!.internalSummary, outputText: "Fixed parse in src/parse.js. node --test: 5 passed, 0 failed.", role: "debugger", iterationCount: 3, repairPasses: 0 } as unknown as RunRecord);
    const dir = mkdtempSync(join(tmpdir(), "orca-export-")); dirs.push(dir);
    for (const verdict of ["PASS", "WARN", "FAIL"] as const) {
      const out = await exportTrainingData(store as unknown as OrcaStore, { outputPath: join(dir, `${verdict}.jsonl`), verdict } as never);
      expect(out.exported, verdict).toBe(0);
    }
  }, 60_000);

  it("a pure run-and-report request keeps no_file_writes: Miranda refuses the write and the worker is told why", async () => {
    const root = project();
    const message = "Run the tests and report the failures.";
    const task = spec(root, message);
    const model = new ScriptedModel([
      call({ tool: "run_command", command: "node --test" }),
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      "FINAL ANSWER: node --test: 3 passed, 2 failed (empty and whitespace-only input).",
    ]);
    const observed: { prompt?: string; constraints?: string[] } = {};
    const traces: OrcaPipelineTrace[] = [];
    await runtimeFor(model, task, observed, traces).executeTask(task);
    expect(observed.constraints).toEqual(["no_file_writes"]);
    const blocked = stagesOf(traces[0]!, "agent.tool.blocked");
    expect(blocked.map((b) => (b.detail as { tool: string }).tool)).toEqual(["write_file"]);
    expect(String((blocked[0]!.detail as { reason: string }).reason)).toMatch(/no_file_writes/);
    expect(model.requests[2]!.messages.at(-1)!.content).toMatch(/<tool_result tool="write_file" ok="false">[\s\S]*no_file_writes/);
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(BUGGY);
  }, 60_000);

  it("Stop while the worker is about to edit: no write lands, the task is cancelled, nothing is verified", async () => {
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message);
    const controller = new AbortController();
    const model = new ScriptedModel([
      call({ tool: "read_file", path: "src/parse.js" }),
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
    ], (index) => { if (index === 1) controller.abort(new Error("Stopped.")); });
    const traces: OrcaPipelineTrace[] = [];
    const outcome = await runtimeFor(model, task, {}, traces).executeTask(task, { abortSignal: controller.signal }).then((r) => r, (e: Error) => e);
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(BUGGY);
    const calls = stagesOf(traces[0] ?? { entries: [] } as unknown as OrcaPipelineTrace, "agent.tool.call").map((e) => (e.detail as { tool: string }).tool);
    expect(calls).not.toContain("write_file");
    if (!(outcome instanceof Error)) {
      expect(outcome.qcResult?.verification?.status).not.toBe("verified");
      expect(["CANCELLED", "INTERRUPTED"]).toContain(outcome.lifecycle?.state);
    } else {
      expect(outcome.name).toBe("AbortError");
    }
  }, 60_000);
});

// ── A5: processes recorded as survivors of the worker's test run ─────────────
// In the live A5 rehearsal the genuine fix was refused because an operator's
// Git Bash `sleep` loop was recorded as a survivor of `npm test`, and a repair
// worker then rewrote correct code until its iterations ran out. These run the
// same parse.js fix with production pieces and a process recorded after the
// worker's commands, as the survivor scan would report it.
describe("survivor attribution in the parse.js task (A5)", () => {
  const unrelatedSleep = (pid: number): UnsettledResource => ({
    kind: "process", pid, label: "sleep.exe (ownership unknown: created while node --test ran)", startedAt: new Date().toISOString(),
    identity: "2026-10-15T09:04:37.0000000-04:00", ownership: "unknown",
    reason: "created while the command ran under a parent that has exited; nothing ties it to the command beyond timing, but that cannot be ruled out, so it is kept until verified gone",
  });
  const recordAfterFirstPass = (resource: UnsettledResource) => {
    let done = false;
    return (ctx: OrcaRunCtx) => { if (!done) { done = true; ctx.lifecycle?.addResources([resource]); } };
  };
  const writesOf = (t: OrcaPipelineTrace) => stagesOf(t, "agent.tool.call").filter((e) => (e.detail as { tool?: string }).tool === "write_file").length;

  it("an unrelated process that exits before the evidence is taken does not block the genuine fix: PASS / verified / eligible, nothing protected", async () => {
    const guard = createWorkspaceGuard({ probe: () => "gone" });
    const exitAt = Date.now() + 400; // still running when recorded; gone within the bounded wait
    const probe: ResourceProbe = () => (Date.now() >= exitAt ? "gone" : "alive");
    const { root, result, trace } = await rehearsalFix(LIVE_CRITERIA, undefined, { processProbe: probe, resourceSettleWaitMs: 3000, workspaceGuard: guard, onPassEnd: recordAfterFirstPass(unrelatedSleep(94001)) });
    expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(FIXED);
    expect(result.qcResult?.issues.map((i) => i.code)).not.toContain("EVIDENCE_PARTIAL");
    expect(result.qcResult?.verdict).toBe("PASS");
    expect(result.qcResult?.verification?.status).toBe("verified");
    expect(result.qcResult?.trainingEligibility).toBe("eligible");
    expect(result.qcResult?.receipt_ledger.every((e) => e.status === "PROVED")).toBe(true);
    expect(stagesOf(trace, "lifecycle.resources.reverified")[0]?.detail).toMatchObject({ stage: "before_evidence", released: [{ pid: 94001, ownership: "unknown" }], remaining: [] });
    expect(guard.list()).toEqual([]);
  }, 60_000);

  it("one still running when the evidence is taken: Pappy FAILs on EVIDENCE_PARTIAL (not silenced), no repair worker is sent to rewrite correct code, and the workspace is protected", async () => {
    const guard = createWorkspaceGuard({ probe: () => "alive" });
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message, LIVE_CRITERIA);
    const model = new ScriptedModel([
      call({ tool: "run_command", command: "node --test" }),
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      call({ tool: "run_command", command: "node --test" }),
      "FINAL ANSWER: Changed parse in src/parse.js to return 0 for empty or whitespace-only input. node --test: 5 passed, 0 failed.",
      // A repair pass, if one were wrongly dispatched, would rewrite the same file:
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      "FINAL ANSWER: rewrote it.",
    ]);
    const traces: OrcaPipelineTrace[] = [];
    const result = await runtimeFor(model, task, {}, traces, { maxRepairPasses: 1, processProbe: () => "alive", resourceSettleWaitMs: 300, workspaceGuard: guard, onPassEnd: recordAfterFirstPass(unrelatedSleep(94002)) }).executeTask(task);
    const trace = traces[0]!;
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(result.qcResult?.verification?.status).toBe("unverified");
    const partial = result.qcResult?.issues.find((i) => i.code === "EVIDENCE_PARTIAL");
    expect(partial?.description).toMatch(/unknown ownership, created while the task's commands ran, are still running/);
    expect(partial?.description).not.toMatch(/started by the task/);
    expect(stagesOf(trace, "repair.skipped")).toHaveLength(1);
    expect(stagesOf(trace, "repair.pass.spec")).toHaveLength(0);
    expect(model.requests).toHaveLength(4); // the first pass only
    expect(writesOf(trace)).toBe(1);
    expect(guard.list()).toHaveLength(1);
    expect(guard.list()[0]!.resources[0]).toMatchObject({ pid: 94002, ownership: "unknown" });
  }, 60_000);

  // A real, unrelated short-lived process created while the worker's test
  // command runs (a launcher starts it and exits at once, so its parent is
  // gone, exactly like Git Bash's sleep.exe); the real survivor scan and the
  // real probe. Opt-in: the stray process would be (correctly) reported by any
  // other test's real scan running at the same moment.
  const realProcesses = process.env["ORCA_REAL_PROCESS_TESTS"] === "1" && process.env["ORCA_PROCESS_SCAN"] !== "off";
  it.skipIf(!realProcesses)("with real processes: an unrelated dead-parent process started during node --test is reported as ownership unknown, released once it exits, and the fix is verified", async () => {
    const launcher = join(mkdtempSync(join(tmpdir(), "orca-unrelated-")), "launch.js");
    writeFileSync(launcher, `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { detached: true, stdio: "ignore", windowsHide: true }).unref();`);
    const root = project();
    const message = "Fix the failing test in src/parse.js and run the tests.";
    const task = spec(root, message, LIVE_CRITERIA);
    const model = new ScriptedModel([
      call({ tool: "run_command", command: "node --test" }),
      call({ tool: "write_file", path: "src/parse.js", content: FIXED }),
      call({ tool: "run_command", command: "node -e \"setTimeout(()=>{},300)\" && node --test" }),
      "FINAL ANSWER: Changed parse in src/parse.js to return 0 for empty or whitespace-only input. node --test: 5 passed, 0 failed.",
    ], (index) => {
      // Fired while the model is asked for the response after the write; the
      // final test command starts right after, so the unrelated process is
      // created inside its window. Not started by Orca.
      if (index === 2) setTimeout(() => spawnSync(process.execPath, [launcher], { windowsHide: true }), 150);
    });
    const traces: OrcaPipelineTrace[] = [];
    const guard = createWorkspaceGuard({ probe: (r) => probeProcess({ pid: r.pid, identity: r.identity }) });
    const result = await runtimeFor(model, task, {}, traces, { processProbe: (r) => probeProcess({ pid: r.pid, identity: r.identity }), resourceSettleWaitMs: 8000, workspaceGuard: guard }).executeTask(task);
    const reverified = stagesOf(traces[0]!, "lifecycle.resources.reverified")[0]?.detail as { released: Array<{ ownership: string; label: string }> } | undefined;
    // The real scan caught it, named it as unknown ownership (never the command's descendant) and released it once it exited.
    expect(reverified?.released.length).toBeGreaterThanOrEqual(1);
    for (const r of reverified?.released ?? []) expect(r.ownership).toBe("unknown");
    expect(result.qcResult?.issues.map((i) => i.code)).not.toContain("EVIDENCE_PARTIAL");
    expect(result.qcResult?.verdict).toBe("PASS");
    expect(guard.list()).toEqual([]);
  }, 60_000);
});
