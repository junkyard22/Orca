import { describe, expect, it } from "vitest";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { DecomposeDecision } from "maestro-core";
import { normalizeDesktopRoutingForExecution } from "./routingPolicy";

function task(goals: string[] = []): OrcaTaskSpec {
  return {
    originalUserMessage: "Check this project",
    intent: "check project",
    goals,
    permissions: { fileRead: true, fileWrite: false, shellExec: false },
  };
}

describe("normalizeDesktopRoutingForExecution", () => {
  it("keeps non-brain direct worker roles unchanged", () => {
    const decision: DecomposeDecision = { routing: "direct", role: "reviewer" };

    const result = normalizeDesktopRoutingForExecution(task(), decision, null);

    expect(result.decision).toEqual(decision);
    expect(result.remappedBrainExecution).toBe(false);
  });

  it("uses deterministic audit decomposition when Brain tries to execute an audit directly", () => {
    const directBrain: DecomposeDecision = { routing: "direct", role: "brain" };
    const auditFallback: DecomposeDecision = {
      routing: "decompose",
      departments: [
        { head: "reviewer", subtask: "Audit code" },
        { head: "debugger", subtask: "Investigate failures" },
      ],
    };

    const result = normalizeDesktopRoutingForExecution(task(), directBrain, auditFallback);

    expect(result.decision).toBe(auditFallback);
    expect(result.remappedBrainExecution).toBe(true);
    expect(result.remapReason).toBe("audit_fallback");
  });

  it("maps direct Brain execution to a non-brain specialist when no audit fallback applies", () => {
    const result = normalizeDesktopRoutingForExecution(
      task(["answer the question"]),
      { routing: "direct", role: "brain", done_criteria: ["answer the question"] },
      null,
    );

    expect(result.decision).toEqual({
      routing: "direct",
      role: "narrator",
      done_criteria: ["answer the question"],
    });
    expect(result.remappedBrainExecution).toBe(true);
  });

  it("maps Brain department heads to a non-brain worker role", () => {
    const result = normalizeDesktopRoutingForExecution(
      task(),
      {
        routing: "decompose",
        departments: [
          { head: "brain", subtask: "Summarize the facts" },
          { head: "reviewer", subtask: "Review the code" },
        ],
      },
      null,
    );

    expect(result.decision.routing).toBe("decompose");
    if (result.decision.routing !== "decompose") throw new Error("expected decompose");
    // Phase 5: a Brain-headed department is remapped by its own work; "Summarize the facts" is inspection, so the reader.
    expect(result.decision.departments.map((department) => department.head)).toEqual(["reader", "reviewer"]);
    expect(result.remappedBrainExecution).toBe(true);
  });

  it("defaults missing routing decisions to a non-brain execution role", () => {
    const result = normalizeDesktopRoutingForExecution(task(["produce an answer"]), null, null);

    expect(result.decision).toEqual({
      routing: "direct",
      role: "narrator",
      done_criteria: ["produce an answer"],
    });
    expect(result.remappedBrainExecution).toBe(true);
    expect(result.remapReason).toBe("missing_decision");
  });

  it("routes explicit command verification to one debugger worker instead of decomposing", () => {
    const result = normalizeDesktopRoutingForExecution(
      {
        ...task(),
        originalUserMessage: [
          "In C:\\Orca\\Orca, actually run the verification commands for production readiness:",
          "pnpm contract:check",
          "pnpm --filter @clawde/desktop test",
          "pnpm --filter @clawde/desktop build",
          "",
          "Report exact pass/fail results and any errors. Do not do a read-only project audit.",
        ].join("\n"),
      },
      {
        routing: "decompose",
        departments: [
          { head: "reviewer", subtask: "Review readiness" },
          { head: "debugger", subtask: "Run commands" },
          { head: "narrator", subtask: "Report results" },
        ],
      },
      null,
    );

    expect(result.decision).toEqual({
      routing: "direct",
      role: "debugger",
      done_criteria: [
        "Reported completion status for command: pnpm contract:check",
        "Reported completion status for command: pnpm --filter @clawde/desktop test",
        "Reported completion status for command: pnpm --filter @clawde/desktop build",
        "Reported overall verification result",
        "Command output details are included for any non-zero command exit",
      ],
    });
    expect(result.remappedBrainExecution).toBe(true);
    expect(result.remapReason).toBe("command_verification");
  });
});

describe("objective preservation and fallback roles (phase 5)", () => {
  const request = (message: string, goals: string[] = []): OrcaTaskSpec => ({
    originalUserMessage: message,
    intent: message,
    goals,
    permissions: { fileRead: true, fileWrite: true, shellExec: true },
  });

  it("a bug-fix request that also says 'run the tests' keeps its objective: it is not turned into command verification", () => {
    const goals = ["`overlaps` must treat a meeting that starts exactly when another ends as not overlapping"];
    const result = normalizeDesktopRoutingForExecution(
      request("Fix the overlap bug in src/bookings.js, then run the test suite and verify the reported problem is resolved. Do not modify the existing tests.", goals),
      { routing: "direct", role: "debugger", done_criteria: goals },
      null,
    );
    expect(result.remapReason).toBeUndefined();
    expect(result.decision).toMatchObject({ routing: "direct", role: "debugger", done_criteria: goals });
  });

  it("running commands as the whole request is still routed to command verification", () => {
    const result = normalizeDesktopRoutingForExecution(request("Actually run pnpm test and pnpm contract:check and report the results."), null, null);
    expect(result.remapReason).toBe("command_verification");
    expect(result.decision).toMatchObject({ routing: "direct", role: "debugger" });
  });

  it("a missing Brain decision falls back to a worker that can do the work, never Narrator for code changes, with the user's goals as criteria", () => {
    const goals = ["cancelBooking must remove the booking"];
    expect(normalizeDesktopRoutingForExecution(request("Fix the crash in src/parse.js when the input is empty.", goals), null, null).decision)
      .toMatchObject({ routing: "direct", role: "debugger", done_criteria: goals });
    expect(normalizeDesktopRoutingForExecution(request("Add a cancelBooking(id) function to src/bookings.js.", goals), null, null).decision)
      .toMatchObject({ routing: "direct", role: "strong_model", done_criteria: goals });
    expect(normalizeDesktopRoutingForExecution(request("Explain how the overlap check works in src/bookings.js."), null, null).decision)
      .toMatchObject({ routing: "direct", role: "reader" });
    expect(normalizeDesktopRoutingForExecution(request("What should I cook tonight?"), null, null).decision)
      .toMatchObject({ routing: "direct", role: "narrator" });
  });

  it("direct-to-Brain execution is remapped by task kind and keeps Brain's criteria or, when it gave none, the user's goals", () => {
    const goals = ["`parse` must not crash on empty input"];
    const r = normalizeDesktopRoutingForExecution(request("Fix the crash in src/parse.js when the input is empty.", goals), { routing: "direct", role: "brain" }, null);
    expect(r.decision).toMatchObject({ routing: "direct", role: "debugger", done_criteria: goals });
    expect(r.remapReason).toBe("direct_default");
  });

  it("Brain-headed departments are remapped by the department's own work", () => {
    const r = normalizeDesktopRoutingForExecution(request("Ship it"), { routing: "decompose", departments: [{ head: "brain", subtask: "Fix the failing test in src/a.test.js" }, { head: "brain", subtask: "Explain the architecture" }], done_criteria: ["done"] }, null);
    expect((r.decision as { departments: Array<{ head: string }> }).departments.map((d) => d.head)).toEqual(["debugger", "reader"]);
  });
});
