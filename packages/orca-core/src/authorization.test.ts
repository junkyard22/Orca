/**
 * The user's refusals (1.7.0, after packaged check H1: a denied command was
 * asked for again by an automatic repair pass). No means no; no answer never
 * means yes; Stop is neither.
 */
import { describe, expect, it, vi } from "vitest";
import type { Issue as PappyIssue } from "@clawde/pappy-core";
import { createAuthorizationRecord, describeRefusal, normalizeApproval, type ToolRefusal } from "./authorization.js";
import { classifyRepairIssue, decideRepair } from "./repairClassification.js";
import { createOrcaRuntime } from "./runtime.js";
import type { MaestroPort, OrcaPipelineTrace, OrcaTaskSpec, PappyPort, PappyResult } from "./types.js";

const issue = (code: string, evidence = "", severity = "HIGH"): PappyIssue => ({ issueId: code, code, severity, category: "x", description: evidence, message: evidence, evidence, expected_receipt: "", fix_hint: "" } as unknown as PappyIssue);
/** Pappy's issues in H1 (run_1792083309671_9s6szj), verbatim codes and evidence. */
const H1_ISSUES = [
  issue("TOOL_FAILURE", "run_command: failed - Command execution denied by user"),
  issue("COMPLETENESS_GOAL_COVERAGE", "Goals: [Run node -e \"console.log('h1')\" and report]. Uncovered concepts: node, console, report."),
  issue("REQUIRED_RECEIPT_MISSING", "AC1: status=MISSING; evidence=[]"),
  issue("CORE_GOAL_MISSING", "AC1: MISSING"),
];
const refusal = (outcome: ToolRefusal["outcome"], operation = "node -e \"console.log('h1')\""): ToolRefusal => ({ tool: "run_command", operation, outcome, at: "2026-10-15T16:55:23.960Z", repeats: 0 });

describe("approval answers are fail-safe", () => {
  it("only true or { approved: true } authorizes; anything else is not approved, and a bare false is not called a denial", () => {
    expect(normalizeApproval(true)).toEqual({ approved: true, outcome: "approved" });
    expect(normalizeApproval({ approved: true, outcome: "approved" }).approved).toBe(true);
    for (const raw of [false, undefined, null, "yes", 1, {}, { approved: "true" }, { approved: 1 }, { outcome: "approved" }, { approved: false, outcome: "approved" }]) {
      expect(normalizeApproval(raw).approved).toBe(false);
    }
    expect(normalizeApproval(false).outcome).toBe("not_approved");
    expect(normalizeApproval({ approved: false, outcome: "timed_out", reason: "timed out" })).toEqual({ approved: false, outcome: "timed_out", reason: "timed out" });
    expect(normalizeApproval({ approved: false, outcome: "nonsense" }).outcome).toBe("not_approved");
  });

  it("the worker is told denial, timeout and cancellation as different outcomes, each 'not approved'", () => {
    const denied = describeRefusal({ outcome: "denied" });
    const timedOut = describeRefusal({ outcome: "timed_out" });
    const cancelled = describeRefusal({ outcome: "cancelled" });
    expect(denied).toMatch(/the user denied this call/);
    expect(timedOut).toMatch(/approval timed out/);
    expect(timedOut).toMatch(/not a denial, and not an approval/);
    expect(timedOut).not.toMatch(/denied this call/);
    expect(cancelled).toMatch(/the task was stopped/);
    for (const text of [denied, timedOut, cancelled]) {
      expect(text).toMatch(/not approved/);
      // The repair classifier still recognises every wording as an authorization failure.
      expect(classifyRepairIssue(issue("TOOL_FAILURE", `run_command: failed - ${text}`))).toBe("authorization");
    }
    expect(describeRefusal({ outcome: "denied" }, true)).toMatch(/not asked for again/);
  });
});

describe("repair decisions respect a refusal", () => {
  it("H1: a denied required command → no repair pass; the task is reported as blocked by the user's authorization", () => {
    const decision = decideRepair(H1_ISSUES, [refusal("denied")]);
    expect(decision.dispatch).toBe(false);
    expect(decision.blockedByAuthorization).toBe(true);
    expect(decision.reason).toMatch(/blocked by your authorization/);
    expect(decision.reason).toMatch(/you denied it/);
  });

  it("H1 before the correction: the same issues without the refusal record would dispatch a repair (the defect)", () => {
    expect(decideRepair(H1_ISSUES).dispatch).toBe(true);
  });

  it("a timed-out approval is reported as a timeout, not a denial, and gets no repair pass either", () => {
    const decision = decideRepair(H1_ISSUES, [refusal("timed_out")]);
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toMatch(/timed out without an answer/);
    expect(decision.reason).not.toMatch(/you denied/);
  });

  it("a refusal and a genuine code defect: no repair (verifying a fix needs the refused operation); the defect is reported separately", () => {
    const decision = decideRepair([...H1_ISSUES, issue("SYNTAX_ERROR", "src/parse.js: Unexpected token")], [refusal("denied", "npm test")]);
    expect(decision.dispatch).toBe(false);
    expect(decision.reason).toMatch(/Pappy also found SYNTAX_ERROR/);
  });

  it("an optional refused operation does not stop a repair of a genuine, unrelated defect", () => {
    const decision = decideRepair([issue("SYNTAX_ERROR", "src/parse.js: Unexpected token")], [refusal("denied", "curl https://example.com")]);
    expect(decision.dispatch).toBe(true);
  });

  it("ordinary repairable failures without an authorization problem are repaired as before", () => {
    expect(decideRepair([issue("FIX_TESTS_NOT_RERUN")]).dispatch).toBe(true);
    expect(decideRepair([issue("SYNTAX_ERROR")]).dispatch).toBe(true);
    expect(decideRepair([issue("CORE_GOAL_MISSING"), issue("COMPLETENESS_GOAL_COVERAGE")]).dispatch).toBe(true);
  });

  it("Pappy's verdict is not touched: the decision only says whether to dispatch a worker", () => {
    const issues = [...H1_ISSUES];
    decideRepair(issues, [refusal("denied")]);
    expect(issues).toEqual(H1_ISSUES);
  });
});

describe("the runtime never asks again for a refused operation", () => {
  const spec = { originalUserMessage: "Run node -e \"console.log('h1')\" and report", intent: "run", goals: ["Run node -e \"console.log('h1')\" and report"], permissions: { fileRead: true, fileWrite: false, shellExec: true } } as unknown as OrcaTaskSpec;
  const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
  const fail: PappyResult = { verdict: "FAIL", trainingEligibility: "needs_human_review", confidence: 0.3, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: H1_ISSUES, repair_task: null, repairTask: "repair", internalSummary: "verdict=FAIL" } as unknown as PappyResult;
  const CMD = { command: "node -e \"console.log('h1')\"" };

  async function run(answer: () => Promise<unknown>, opts: { abort?: boolean } = {}) {
    const host = vi.fn(answer);
    const asked: boolean[] = [];
    const controller = new AbortController();
    let passes = 0;
    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        passes++;
        if (opts.abort) controller.abort(new Error("Stopped"));
        asked.push(await ctx.requestToolApproval!("run_command", CMD));
        asked.push(await ctx.requestToolApproval!("run_command", { command: "  node -e \"console.log('h1')\"  " }));
        return { outputText: "The command was not approved, so it did not run." };
      },
    };
    const pappy: PappyPort = { evaluate: () => fail };
    const traces: OrcaPipelineTrace[] = [];
    const runtime = createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, maxRepairPasses: 1, requestToolApproval: host as never, writeTrace: (t: OrcaPipelineTrace) => { traces.push(t); } } as never);
    const result = await runtime.executeTask(spec, opts.abort ? { abortSignal: controller.signal } : undefined).then((r) => r, (e: unknown) => e);
    return { host, asked, passes, result, trace: traces[0] };
  }
  const stages = (t: OrcaPipelineTrace | undefined, stage: string) => (t?.entries ?? []).filter((e) => e.stage === stage);

  it("explicit Deny: asked once; the same operation (also re-spaced) is refused without asking; no repair pass", async () => {
    const { host, asked, passes, result, trace } = await run(async () => ({ approved: false, outcome: "denied", reason: "denied by the user" }));
    expect(host).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([false, false]);
    expect(passes).toBe(1);
    expect(stages(trace, "approval.refused")[0]?.detail).toMatchObject({ outcome: "denied" });
    expect(stages(trace, "approval.not_reasked")).toHaveLength(1);
    expect(stages(trace, "repair.start")).toHaveLength(0);
    expect(stages(trace, "repair.skipped")[0]?.detail).toMatchObject({ blockedByAuthorization: true });
    expect((result as { qcResult?: PappyResult }).qcResult?.verdict).toBe("FAIL");
  });

  it("timeout: recorded as timed out (not denied), not retried, no repair pass", async () => {
    const { host, asked, passes, trace } = await run(async () => ({ approved: false, outcome: "timed_out", reason: "timed out" }));
    expect(host).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([false, false]);
    expect(passes).toBe(1);
    expect(stages(trace, "approval.refused")[0]?.detail).toMatchObject({ outcome: "timed_out" });
    expect((stages(trace, "repair.skipped")[0]?.detail as { reason: string }).reason).toMatch(/timed out without an answer/);
  });

  it("a bare false from a legacy host is still not approved, and not asked again", async () => {
    const { host, asked } = await run(async () => false);
    expect(host).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([false, false]);
  });

  it("an approval is still an approval: nothing is recorded, the same command may be asked again, and an ordinary FAIL is repaired", async () => {
    const { host, asked, passes, trace } = await run(async () => true);
    expect(passes).toBe(2); // no refusal: the FAIL gets its repair pass as before
    expect(host).toHaveBeenCalledTimes(4);
    expect(asked).toEqual([true, true, true, true]);
    expect(stages(trace, "approval.refused")).toHaveLength(0);
  });

  it("cancellation: a task that is stopping never asks; the refusal is recorded as cancelled, not as the user's", async () => {
    const { host, asked } = await run(async () => true, { abort: true });
    expect(host).not.toHaveBeenCalled();
    expect(asked).toEqual([false, false]);
    const record = createAuthorizationRecord();
    record.record("run_command", CMD, { approved: false, outcome: "cancelled" });
    expect(record.refusals()[0]!.outcome).toBe("cancelled");
    expect(decideRepair(H1_ISSUES, record.refusals()).blockedByAuthorization).toBeUndefined();
  });
});
