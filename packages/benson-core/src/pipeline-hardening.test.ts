/**
 * pipeline-hardening.test.ts
 *
 * Targeted validation suite for the pipeline hardening patch.
 * Tests patterns NOT covered by trust.test.ts — specifically the structural
 * artifacts produced by the Pappy / Dewey runtime internals.
 *
 * Covers:
 *   Scenario 4 — Failure-path / Pappy internalSummary leakage prevention
 *   Scenario 6 — Benson boundary hardening for known structural artifacts
 *
 * A test marked "DOCUMENTS" records observed behavior for a partial gap and
 * expected to PASS (non-strict assertion). Pure PASS/FAIL tests assert hard
 * requirements.
 */

import { describe, it, expect } from "vitest";
import { presentResult } from "./presenter.js";
import type { ExecutionResult, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_TASK: TaskSpec = {
  originalUserMessage: "stub",
  intent: "stub",
  goals: ["stub"],
};

/** Structural artifact patterns that must never appear in user-facing text. */
function assertArtifactFree(text: string, label: string): void {
  const forbidden: Array<[string, RegExp]> = [
    ["verdict= token",           /\bverdict=(PASS|WARN|FAIL)\b/i],
    ["severity tally NxSEV",     /\b\d+x(CRITICAL|HIGH|MEDIUM|LOW)\b/i],
    ["run_id= token",            /\brun_id=\S+/i],
    ["dewey_blocked marker",     /\bdewey_blocked\b/i],
    ["dewey_review_blocked leak", /\bdewey_review_blocked\b/i],
  ];
  for (const [name, re] of forbidden) {
    if (re.test(text)) {
      throw new Error(
        `ARTIFACT LEAK [${label}]: forbidden pattern "${name}" found.\nOutput:\n---\n${text}\n---`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 6 — Benson boundary hardening
// Verifies cleanOutput() / cleanFollowUp() strip known structural artifacts
// while leaving legitimate content intact.
// ---------------------------------------------------------------------------

describe("Scenario 6: Benson boundary hardening — structural artifact stripping", () => {
  it("6.1 strips verdict=FAIL 2xHIGH 1xMEDIUM embedded in SUCCESS output, leaves code intact", () => {
    // Simulates a scenario where the LLM echoed an internal verdict string
    // into its output text before Benson sanitises.
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText:
        "Here is the implementation:\n\nverdict=FAIL 2xHIGH 1xMEDIUM\n\n```ts\nconst x = 1;\n```",
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.1");
    expect(text).toContain("const x = 1");
  });

  it("6.2 strips run_id= token while preserving surrounding content", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText: "Task completed. run_id=run_1234abc\nThe file was written.",
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.2");
    expect(text).toContain("The file was written");
  });

  it("6.3 strips dewey_blocked line while preserving user-safe content after it", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText:
        "Processing...\ndewey_blocked scheduling preference violated\nHere is the answer.",
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.3");
    expect(text).toContain("Here is the answer");
  });

  it("6.4 legitimate markdown content survives after full artifact stripping", () => {
    // Multiple artifact types in a single string. Legitimate content must survive.
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText:
        "verdict=PASS no_issues\n\nrun_id=xyz789\n\nHere is the final answer with `code`.",
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.4");
    expect(text).toContain("Here is the final answer with `code`");
  });

  it("6.5 strips multi-severity tally as a standalone phrase in prose context", () => {
    // The tally can appear mid-sentence if a model echoed a QC summary.
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText:
        "Some output. 2xHIGH 1xMEDIUM issues found internally. But here is the answer.",
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.5");
    expect(text).toContain("here is the answer");
  });

  it("6.6 strips structural artifacts from followUpQuestion path (artifact on own line)", () => {
    // followUpQuestion uses cleanFollowUp() which must also strip these artifacts.
    // The artifact is on its own line; the user-facing question is on a separate
    // line so it survives the strip. In practice, "verdict=FAIL" is a runtime
    // token that the model should never emit inline with question text.
    const result: ExecutionResult = {
      status: "FAIL",
      followUpQuestion: "verdict=FAIL 2xHIGH\nWould you like me to try again?",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.6");
    expect(text).toContain("Would you like me to try again");
  });

  it("6.6b DOCUMENTS: verdict= artifact on same line as question destroys question (greedy strip)", () => {
    // The regex /\bverdict=(PASS|WARN|FAIL)\b[^\n]*/gi strips from the verdict= token
    // to end-of-line. If a model emits "verdict=FAIL ... real question?" on a single
    // line, the entire line (including the question) is removed.
    // This is the correct security behavior (don't preserve tainted lines), but it
    // means the follow-up question is also lost. Document for awareness.
    const result: ExecutionResult = {
      status: "FAIL",
      followUpQuestion: "verdict=FAIL 2xHIGH — would you like me to try again?",
    };
    const text = presentResult(result, STUB_TASK);
    // The artifact IS stripped — no leakage
    assertArtifactFree(text, "6.6b");
    // The question is also destroyed (same line) — this is current behavior
    // and is noted as a "greedy strip" characteristic.
    expect(text).not.toContain("verdict=FAIL");
    // No assertion on question survival — it was on the same line as the artifact
  });

  it("6.7 run_id inside followUpQuestion is stripped", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "run_id=run_timeline_abc Should I also update the index.ts?",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.7");
    expect(text).toContain("Should I also update the index.ts");
  });

  it("6.8 complex mixed artifact + repair scaffold stripped, legitimate content preserved", () => {
    // Simulates an LLM that echoed repair-loop scaffolding lines alongside
    // legitimate user-facing content.
    const result: ExecutionResult = {
      status: "SUCCESS",
      userFacingText: [
        "Brain: routing to strong_model",
        "verdict=FAIL 1xHIGH",
        "run_id=run_17140000_abc",
        "dewey_blocked preference check failed",
        "Thought: Let me fix the issue now.",
        "",
        "Here is the corrected implementation:",
        "",
        "```ts",
        "export function greet(): string { return 'hello world'; }",
        "```",
      ].join("\n"),
      summary: "ok",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "6.8");
    expect(text).toContain("export function greet");
    expect(text).toContain("return 'hello world'");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Failure path / Pappy internalSummary leakage prevention
//
// In runtime.ts, result.summary = qcResult.internalSummary.
// Pappy's buildInternalSummary() produces "verdict=FAIL 2xHIGH 1xMEDIUM".
// presentFailure() calls cleanFollowUp(result.summary) before showing it.
// ---------------------------------------------------------------------------

describe("Scenario 4: Failure path — Pappy internalSummary leak prevention", () => {
  it("4.1 FAIL with Pappy tally in summary: artifacts stripped, user gets generic message", () => {
    // This is the exact scenario: pappy returns FAIL with internalSummary like
    // "verdict=FAIL 2xHIGH 1xMEDIUM" and the runtime sets result.summary to this.
    const result: ExecutionResult = {
      status: "FAIL",
      summary: "verdict=FAIL 2xHIGH 1xMEDIUM",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "4.1");
    // User still gets a navigable failure message
    expect(text).toContain("did not complete as expected");
  });

  it("4.2 FAIL with pappy PASS no_issues summary: artifacts stripped", () => {
    // Covers the "verdict=PASS no_issues" edge case — verdict= prefix still stripped
    const result: ExecutionResult = {
      status: "FAIL",
      summary: "verdict=PASS no_issues",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "4.2");
  });

  it("4.3 FAIL with run_id in summary: run_id stripped", () => {
    const result: ExecutionResult = {
      status: "FAIL",
      summary: "run_id=run_1714000000_abc123 unexpected failure",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "4.3");
    // Non-artifact text from summary may surface (acceptable)
    expect(text).toContain("did not complete as expected");
  });

  it("4.4 FAIL with userFacingText: summary is NOT shown, no verdict leak via text path", () => {
    // When FAIL has userFacingText, presentFailure() shows that text + QC note,
    // NOT the summary. Verify the summary's artifact can't contaminate this path.
    const result: ExecutionResult = {
      status: "FAIL",
      userFacingText: "I could not modify the file as it does not exist.",
      summary: "verdict=FAIL 2xHIGH 1xMEDIUM",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "4.4");
    expect(text).toContain("I could not modify the file as it does not exist");
    // QC note surfaced to user (generic form — no issue codes)
    expect(text).toContain("QC noted some issues");
    // The verdict= from summary must NOT bleed into output
    // (summary is only used when userFacingText is absent)
  });

  it("4.5 dewey_review_blocked summary is stripped (Benson leak closed)", () => {
    // maestroAdapter sets summary="dewey_review_blocked" when Dewey hard-blocks.
    // presenter.ts step 5d now uses /^dewey_[a-z_]*blocked\b/ which matches this.
    // This test changed from DOCUMENTS (partial gap) to a hard assertion (gap fixed).
    const result: ExecutionResult = {
      status: "FAIL",
      summary: "dewey_review_blocked",
    };
    const text = presentResult(result, STUB_TASK);
    // The string must not reach the user — strip pattern now covers it.
    expect(text).not.toContain("dewey_review_blocked");
    // assertArtifactFree also validates absence via the new forbidden pattern.
    assertArtifactFree(text, "4.5");
    // Response should fall back to the generic FAIL message.
    expect(text).toContain("did not complete as expected");
  });

  it("4.6 Pappy CRITICAL tally stripped: 3xCRITICAL", () => {
    const result: ExecutionResult = {
      status: "FAIL",
      summary: "verdict=FAIL 3xCRITICAL 1xHIGH 2xMEDIUM",
    };
    const text = presentResult(result, STUB_TASK);
    assertArtifactFree(text, "4.6");
    expect(text).toContain("did not complete as expected");
  });
});
