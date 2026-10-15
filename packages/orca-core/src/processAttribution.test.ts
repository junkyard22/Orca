/**
 * Processes a command may have left behind, as the runtime sees them (1.7.0,
 * after the A5 live rehearsal).
 *
 * A5: an operator's Git Bash `sleep 2` loop was recorded as a survivor of the
 * worker's `npm test`. The sleeps had exited seconds before Pappy judged the
 * work, but every recorded process was still counted as "may still be
 * writing", so a genuine fix (13/13 on the final source, all criteria proved)
 * failed on EVIDENCE_PARTIAL, a worker was sent to "repair" it, and the
 * workspace was protected.
 *
 * What must hold now:
 *   - a recorded process verified gone before the evidence is taken does not
 *     make the evidence partial (the inventory taken afterwards includes
 *     anything it wrote);
 *   - one still running, or that cannot be verified, still does — whatever
 *     its ownership — and still protects the workspace;
 *   - without a probe nothing changes (every recorded process counts);
 *   - a FAIL whose only blocking issue is evidence integrity or a refused
 *     approval dispatches no worker, and the FAIL stands.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOrcaRuntime } from "./runtime.js";
import { createPappyPort } from "./adapters/pappyPort.js";
import { TaskLifecycle, type ResourceProbe, type UnsettledResource } from "./lifecycle.js";
import { createWorkspaceGuard } from "./workspaceGuard.js";
import { classifyRepairIssue, decideRepair } from "./repairClassification.js";
import type { MaestroPort, OrcaPipelineTrace, OrcaRunCtx, OrcaTaskSpec, PappyPort } from "./types.js";

const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });

const PASSING = "ℹ tests 2\nℹ pass 2\nℹ fail 0\n";
const FAILING = "[Exit code 1]\nℹ tests 2\nℹ pass 1\nℹ fail 1\n";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-attrib-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "a.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "a.test.js"), "require('node:test')('a', () => {});\nrequire('node:test')('b', () => {});\n");
  return root;
}

const sleepExe = (pid: number, ownership: UnsettledResource["ownership"] = "unknown"): UnsettledResource => ({
  kind: "process", pid, label: `sleep.exe (ownership unknown: created while npm test ran)`, startedAt: new Date().toISOString(),
  identity: "2026-10-15T09:04:37.0000000-04:00", reason: "created while the command ran under a parent that has exited", ownership,
});

/** A worker that reproduces, fixes a.js, re-runs the suite on the final source, and meanwhile something is recorded as a survivor of its run. */
function fixingWorker(root: string, survivors: UnsettledResource[]): MaestroPort {
  return {
    run: async (_task, ctx: OrcaRunCtx) => {
      ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
      ctx.recordTrace?.("tool.result", { tool: "run_command", ok: false, output: FAILING });
      writeFileSync(join(root, "a.js"), "module.exports = 2;\n");
      ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
      ctx.recordTrace?.("tool.result", { tool: "run_command", ok: true, output: PASSING });
      ctx.lifecycle?.addResources(survivors);
      return {
        outputText: "Changed a.js to export 2. npm test: 2 passed, 0 failed.",
        toolEvents: [
          { tool: "run_command", ok: false, summary: "run_command: failed - [Exit code 1]", raw: { command: "npm test", _outputForProof: FAILING } },
          { tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "a.js", content: "module.exports = 2;\n" } },
          { tool: "run_command", ok: true, summary: "run_command: ok", raw: { command: "npm test", _outputForProof: PASSING } },
        ],
      };
    },
  };
}

const spec = (root: string) => ({
  originalUserMessage: "Fix the failing test in a.js and run the tests.", intent: "fix", goals: ["The failing test in a.js is fixed", "Tests are run and all pass"],
  permissions: { fileRead: true, fileWrite: true, shellExec: true }, workspaceRoot: root,
}) as unknown as OrcaTaskSpec;

async function run(root: string, survivors: UnsettledResource[], opts: { probe?: ResourceProbe; maxRepairPasses?: number; maestro?: MaestroPort; pappy?: PappyPort } = {}) {
  const traces: OrcaPipelineTrace[] = [];
  const seen: Array<{ workspace?: { partial?: boolean; reason?: string } }> = [];
  const real = opts.pappy ?? createPappyPort();
  const pappy: PappyPort = { evaluate: (input) => { seen.push(input as never); return real.evaluate(input); } };
  const guard = createWorkspaceGuard({ probe: opts.probe ?? (() => "alive") });
  const maestro = opts.maestro ?? fixingWorker(root, survivors);
  const runSpy = vi.spyOn(maestro, "run");
  const result = await createOrcaRuntime({
    maestro, pappy, llm: makeLLM() as never, workspaceRoot: root, maxRepairPasses: opts.maxRepairPasses ?? 0,
    workspaceGuard: guard, ...(opts.probe ? { processProbe: opts.probe, resourceSettleWaitMs: 1500 } : {}),
    writeTrace: (t: OrcaPipelineTrace) => { traces.push(t); },
  } as never).executeTask(spec(root));
  const stages = traces.flatMap((t) => t.entries);
  return { result, seen, guard, stages, workerPasses: runSpy.mock.calls.length };
}

describe("recorded processes are re-verified before the evidence is judged", () => {
  it("an unrelated process recorded as a survivor that has exited by then does not make the evidence partial: the genuine fix is verified", async () => {
    const root = project();
    const { result, seen, guard, stages } = await run(root, [sleepExe(91001)], { probe: () => "gone" });
    expect(seen[0]?.workspace?.partial).not.toBe(true);
    expect(result.qcResult?.issues.map((i) => i.code)).not.toContain("EVIDENCE_PARTIAL");
    // Synthetic tool events carry no diff text (a MEDIUM completeness note → WARN); the full PASS on real tools is the desktop parse.js test.
    expect(result.qcResult?.verdict).not.toBe("FAIL");
    expect(result.qcResult?.verification?.status).toBe("verified");
    expect(stages.find((e) => e.stage === "lifecycle.resources.reverified")?.detail).toMatchObject({ stage: "before_evidence", released: [{ pid: 91001, ownership: "unknown" }], remaining: [] });
    expect(guard.list()).toEqual([]);
  });

  it("one that exits during the bounded wait is released too; the evidence is taken after it exited", async () => {
    const root = project();
    const exitAt = Date.now() + 600;
    const { seen, result } = await run(root, [sleepExe(91002)], { probe: () => (Date.now() >= exitAt ? "gone" : "alive") });
    expect(seen[0]?.workspace?.partial).not.toBe(true);
    expect(result.qcResult?.verdict).not.toBe("FAIL");
    expect(result.qcResult?.verification?.status).toBe("verified");
  });

  it("an unknown-ownership process still running keeps the evidence partial (named as unknown ownership, not as the task's), Pappy FAILs on EVIDENCE_PARTIAL, and the workspace is protected", async () => {
    const root = project();
    const { result, seen, guard } = await run(root, [sleepExe(91003)], { probe: () => "alive" });
    expect(seen[0]?.workspace?.partial).toBe(true);
    expect(seen[0]?.workspace?.reason).toMatch(/1 process\(es\) of unknown ownership, created while the task's commands ran, are still running/);
    expect(seen[0]?.workspace?.reason).not.toMatch(/started by the task/);
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(result.qcResult?.issues.map((i) => i.code)).toContain("EVIDENCE_PARTIAL");
    expect(guard.list()).toHaveLength(1);
  });

  it("a confirmed descendant still running is named as the task's and keeps the evidence partial", async () => {
    const root = project();
    const { seen, result } = await run(root, [{ ...sleepExe(91004, "confirmed"), label: "node.exe (descendant of: npm start)" }], { probe: () => "alive" });
    expect(seen[0]?.workspace?.reason).toMatch(/1 process\(es\) started by the task may still be writing: pid 91004/);
    expect(result.qcResult?.verdict).toBe("FAIL");
  });

  it("a probe that cannot tell keeps the process (unknown is never read as gone)", async () => {
    const root = project();
    const { seen } = await run(root, [sleepExe(91005)], { probe: () => "unknown" });
    expect(seen[0]?.workspace?.partial).toBe(true);
  });

  it("without a probe nothing changes: every recorded process still counts (the conservative default)", async () => {
    const root = project();
    const { seen, result } = await run(root, [sleepExe(91006)]);
    expect(seen[0]?.workspace?.partial).toBe(true);
    expect(result.qcResult?.verdict).toBe("FAIL");
  });
});

describe("lifecycle re-verification", () => {
  it("releases only what is verified gone, keeps alive and unknown, and records each release", async () => {
    const lc = new TaskLifecycle({ taskId: "t" });
    lc.addResources([sleepExe(1), sleepExe(2), sleepExe(3)]);
    const liveness: Record<number, "gone" | "alive" | "unknown"> = { 1: "gone", 2: "alive", 3: "unknown" };
    const { released, remaining } = await lc.reverifyResources((r) => liveness[r.pid]!, "verified gone");
    expect(released.map((r) => r.pid)).toEqual([1]);
    expect(remaining.map((r) => r.pid)).toEqual([2, 3]);
    expect(lc.snapshot().ignoredAfterEnd.some((e) => /process 1 .* released: verified gone/.test(e.event))).toBe(true);
  });

  it("a reused pid (alive, but a different creation time) counts as gone through the identity-checking probe", async () => {
    const lc = new TaskLifecycle({ taskId: "t" });
    lc.addResources([sleepExe(4)]);
    const probe: ResourceProbe = (r) => (r.identity === "2026-10-15T09:04:37.0000000-04:00" ? "gone" : "alive"); // stands in for probeProcess comparing identities
    expect((await lc.reverifyResources(probe, "verified gone")).remaining).toEqual([]);
  });

  it("a probe that throws is treated as unknown", async () => {
    const lc = new TaskLifecycle({ taskId: "t" });
    lc.addResources([sleepExe(5)]);
    expect((await lc.reverifyResources(() => { throw new Error("no access"); }, "x")).remaining).toHaveLength(1);
  });
});

describe("restart with unresolved process evidence", () => {
  it("an unknown-ownership process recorded before a restart keeps the workspace protected while it runs and is released once verified gone; its ownership is kept", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "orca-guard-")), "protection.json");
    const root = project();
    let alive = true;
    const first = createWorkspaceGuard({ filePath: file, probe: () => (alive ? "alive" : "gone") });
    first.protect(root, { taskId: "t1", reason: "ended failed, but a process it started is still running", resources: [sleepExe(92001)] });
    const restarted = createWorkspaceGuard({ filePath: file, probe: () => (alive ? "alive" : "gone") });
    const kept = await restarted.recover();
    expect(kept.kept).toHaveLength(1);
    expect(kept.kept[0]!.resources[0]).toMatchObject({ pid: 92001, ownership: "unknown" });
    alive = false;
    expect(await restarted.status(root)).toEqual([]);
  });
});

describe("repair classification", () => {
  const issue = (code: string, severity = "HIGH", text = "") => ({ issueId: code, severity, code, category: "Proof", description: text || code, expected_receipt: "", evidence: text, fix_hint: "", message: text || code }) as never;

  it("classifies by what can resolve it", () => {
    expect(classifyRepairIssue(issue("EVIDENCE_PARTIAL"))).toBe("evidence_integrity");
    expect(classifyRepairIssue(issue("TOOL_FAILURE", "HIGH", "run_command: failed - Command execution denied by user"))).toBe("authorization");
    expect(classifyRepairIssue(issue("TOOL_FAILURE", "HIGH", "run_command: failed - ENOENT"))).toBe("code_defect");
    expect(classifyRepairIssue(issue("FIX_TESTS_NOT_RERUN"))).toBe("missing_evidence");
    expect(classifyRepairIssue(issue("FIX_TESTS_FAILING"))).toBe("code_defect");
    expect(classifyRepairIssue(issue("SOMETHING_NEW"))).toBe("code_defect"); // unknown keeps today's behaviour
  });

  it("dispatches a worker only when a blocking issue is a code defect or missing evidence", () => {
    expect(decideRepair([issue("EVIDENCE_PARTIAL")]).dispatch).toBe(false);
    expect(decideRepair([issue("TOOL_FAILURE", "HIGH", "Command execution denied by user")]).dispatch).toBe(false);
    expect(decideRepair([issue("EVIDENCE_PARTIAL"), issue("FIX_TESTS_FAILING")]).dispatch).toBe(true);
    expect(decideRepair([issue("EVIDENCE_PARTIAL"), issue("FIX_TESTS_NOT_RERUN")]).dispatch).toBe(true);
    expect(decideRepair([issue("EVIDENCE_PARTIAL"), issue("STYLE_NIT", "LOW")]).dispatch).toBe(false);
    expect(decideRepair([issue("STYLE_NIT", "MEDIUM")]).dispatch).toBe(true); // no blocking issue: unchanged
  });

  it("A5 in miniature: the only blocking issue is evidence integrity — no repair pass is dispatched, the worker is not asked to rewrite correct code, and the FAIL stands", async () => {
    const root = project();
    const { result, stages, workerPasses } = await run(root, [sleepExe(93001)], { probe: () => "alive", maxRepairPasses: 1 });
    expect(workerPasses).toBe(1);
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(result.status).toBe("FAIL");
    const skipped = stages.find((e) => e.stage === "repair.skipped")?.detail as { reason: string; blocking: Array<{ code: string; class: string }> };
    expect(skipped.blocking).toEqual([{ code: "EVIDENCE_PARTIAL", severity: "HIGH", class: "evidence_integrity" }]);
    expect(skipped.reason).toMatch(/not code changes/);
    expect(stages.some((e) => e.stage === "repair.pass.spec")).toBe(false);
  });

  it("a genuine code defect still gets its repair pass (bounds unchanged)", async () => {
    const root = project();
    const broken: MaestroPort = {
      run: async (_task, ctx: OrcaRunCtx) => {
        ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
        ctx.recordTrace?.("tool.result", { tool: "run_command", ok: false, output: FAILING });
        writeFileSync(join(root, "a.js"), `module.exports = ${Math.random()};\n`);
        ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
        ctx.recordTrace?.("tool.result", { tool: "run_command", ok: false, output: FAILING });
        return { outputText: "Changed a.js; npm test still 1 failing.", toolEvents: [
          { tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "a.js" } },
          { tool: "run_command", ok: false, summary: "run_command: failed - [Exit code 1]", raw: { command: "npm test", _outputForProof: FAILING } },
        ] };
      },
    };
    const { result, workerPasses, stages } = await run(root, [], { probe: () => "gone", maxRepairPasses: 1, maestro: broken });
    expect(workerPasses).toBe(2);
    expect(result.qcResult?.verdict).toBe("FAIL");
    expect(stages.some((e) => e.stage === "repair.skipped")).toBe(false);
  });
});
