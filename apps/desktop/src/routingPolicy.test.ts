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
    expect(result.decision.departments.map((department) => department.head)).toEqual(["narrator", "reviewer"]);
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
        "Output states the completion status for command: pnpm contract:check",
        "Output states the completion status for command: pnpm --filter @clawde/desktop test",
        "Output states the completion status for command: pnpm --filter @clawde/desktop build",
        "Output states the overall verification result",
        "Output includes command output details for any non-zero command exit",
      ],
    });
    expect(result.remappedBrainExecution).toBe(true);
    expect(result.remapReason).toBe("command_verification");
  });
});
