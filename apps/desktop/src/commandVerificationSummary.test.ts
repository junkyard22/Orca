import { describe, expect, it } from "vitest";
import { buildCommandVerificationSummary, isCommandVerificationCriteria } from "./commandVerificationSummary";

describe("commandVerificationSummary", () => {
  const doneCriteria = [
    "Reported completion status for command: pnpm contract:check",
    "Reported completion status for command: pnpm --filter @clawde/desktop test",
    "Reported overall verification result",
  ];

  it("builds a command-status report from tool events when the agent has no final output", () => {
    const summary = buildCommandVerificationSummary({
      doneCriteria,
      toolEvents: [
        {
          tool: "run_command",
          ok: true,
          summary: "run_command: ok (120 chars)",
          raw: { command: "pnpm contract:check", _outputForProof: "Status: CLEAR" },
        },
        {
          tool: "run_command",
          ok: true,
          summary: "run_command: ok (240 chars)",
          raw: { command: "pnpm --filter @clawde/desktop test", _outputForProof: "113 passed" },
        },
      ],
      stoppedBecause: "error",
      errorMessage: "model stopped",
    });

    expect(summary).toContain("Reported completion status for command: pnpm contract:check - COMPLETED");
    expect(summary).toContain("Reported completion status for command: pnpm --filter @clawde/desktop test - COMPLETED");
    expect(summary).toContain("Reported overall verification result: PASS");
    expect(summary).toContain("Agent stopped before final report: error");
  });

  it("marks requested commands as not run when no matching tool event exists", () => {
    const summary = buildCommandVerificationSummary({
      doneCriteria,
      toolEvents: [],
    });

    expect(summary).toContain("pnpm contract:check - NOT RUN");
    expect(summary).toContain("Reported overall verification result: INCOMPLETE");
  });

  it("detects command verification criteria", () => {
    expect(isCommandVerificationCriteria(doneCriteria)).toBe(true);
    expect(isCommandVerificationCriteria(["Output explains the answer"])).toBe(false);
  });
});
