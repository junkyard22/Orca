import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const DM = requireCjs("../renderer/demo-mode.js");

type Ev = Record<string, unknown>;
const API_400 = "API error 400: temperature is deprecated for this model.";

function run(events: Ev[]) {
  const tracker = DM.createDemoStageTracker();
  for (const e of events) tracker.consume(e);
  return tracker.getState();
}
const statusOf = (steps: Array<{ stage: string; status: string }>, stage: string) =>
  steps.find((s) => s.stage === stage)?.status;

const workerFails: Ev[] = [
  { type: "maestro:agent_start", role: "debugger" },
  { type: "maestro:agent_done", role: "debugger", stoppedBecause: "error", iterations: 0 },
  { type: "subagent:failed", role: "debugger", error: API_400 },
  { type: "maestro:done" },
];
const workerSucceeds: Ev[] = [
  { type: "maestro:agent_start", role: "debugger" },
  { type: "maestro:agent_done", role: "debugger", stoppedBecause: "done", iterations: 6 },
  { type: "maestro:done" },
];

describe("demo strip — BUILD reflects worker success, not just stage progress", () => {
  // Regression: Live Find & Fix, worker hit a provider 400, Pappy rejected,
  // the repair hit the same 400 — yet BUILD was shown as complete.
  const failingRun: Ev[] = [
    { type: "task:start" },
    { type: "maestro:start" },
    ...workerFails,
    { type: "qc:result", verdict: "FAIL", issueCount: 2 },
    { type: "repair:start", pass: 1, maxPasses: 2 },
    ...workerFails,
    { type: "qc:result", verdict: "FAIL", issueCount: 2 },
    { type: "task:done", status: "FAIL" },
  ];

  it("shows BUILD as failed while Pappy verifies the errored work", () => {
    const state = run(failingRun.slice(0, 6)); // through the first maestro:done
    expect(state.stage).toBe("verify");
    expect(statusOf(DM.stripSteps(state, null), "build")).toBe("failed");
  });

  it("keeps BUILD failed at the end of the run, and Pappy's rejection stands", () => {
    const state = run(failingRun);
    const steps = DM.stripSteps(state, "not_verified");
    expect(statusOf(steps, "plan")).toBe("complete");
    expect(statusOf(steps, "build")).toBe("failed");
    expect(statusOf(steps, "verify")).toBe("failed");
    expect(state.lastVerdict).toBe("FAIL");
    expect(DM.isVerified(state)).toBe(false);
  });

  it("still shows BUILD complete when the worker finished its work", () => {
    const state = run([{ type: "task:start" }, ...workerSucceeds, { type: "qc:result", verdict: "PASS" }, { type: "task:done", status: "SUCCESS" }]);
    const steps = DM.stripSteps(state, "verified");
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["complete", "complete", "complete", "complete"]);
  });

  it("judges BUILD by the latest pass: a repair that succeeds clears the earlier error", () => {
    const state = run([
      { type: "task:start" },
      ...workerFails,
      { type: "qc:result", verdict: "FAIL" },
      { type: "repair:start", pass: 1, maxPasses: 2 },
      ...workerSucceeds,
    ]);
    expect(statusOf(DM.stripSteps(state, null), "build")).toBe("complete");
  });

  it("does not change Pappy's verdict handling", () => {
    const state = run([{ type: "task:start" }, ...workerFails, { type: "qc:result", verdict: "PASS" }, { type: "task:done", status: "SUCCESS" }]);
    const steps = DM.stripSteps(state, "verified");
    expect(statusOf(steps, "build")).toBe("failed");
    expect(statusOf(steps, "verify")).toBe("complete");
    expect(DM.isVerified(state)).toBe(true);
  });
});

describe("demo strip — PLAN fallback and critical issues", () => {
  it("shows PLAN as a fallback (not complete) when Brain could not plan", () => {
    const state = run([{ type: "task:start" }, { type: "brain:fallback", reason: "brain routing failed", error: API_400 }, ...workerFails]);
    const steps = DM.stripSteps(state, null);
    expect(statusOf(steps, "plan")).toBe("fallback");
    expect(statusOf(steps, "build")).toBe("failed");
  });

  it("PLAN stays complete when Brain planned normally", () => {
    const state = run([{ type: "task:start" }, ...workerSucceeds]);
    expect(statusOf(DM.stripSteps(state, null), "plan")).toBe("complete");
  });

  it("never reports Verified while HIGH/CRITICAL issues are unmet, even on a WARN verdict", () => {
    const state = run([
      { type: "task:start" }, ...workerSucceeds,
      { type: "qc:result", verdict: "WARN", issues: [{ severity: "HIGH", code: "FIX_TESTS_FAILING", description: "1 failing" }] },
      { type: "task:done", status: "WARN" },
    ]);
    expect(DM.isVerified(state)).toBe(false);
    expect(DM.classifyRunOutcome({ result: { ok: true }, state })).toBe("not_verified");
  });

  it("a WARN with only minor notes is still verified with notes", () => {
    const state = run([
      { type: "task:start" }, ...workerSucceeds,
      { type: "qc:result", verdict: "WARN", issues: [{ severity: "MEDIUM", code: "X", description: "note" }] },
      { type: "task:done", status: "WARN" },
    ]);
    expect(DM.isVerified(state)).toBe(true);
    expect(DM.classifyRunOutcome({ result: { ok: true }, state })).toBe("verified_with_warnings");
  });
});
