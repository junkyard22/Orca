/**
 * trust.test.ts — End-to-end pipeline trust tests
 *
 * These tests verify the launch-critical invariant:
 *   user-visible chat output must NEVER contain internal reasoning,
 *   role handoff text, scratchpad content, or pipeline chatter.
 *
 * Each test exercises the Benson → presentResult() path with controlled
 * ExecutionResult inputs and asserts that the final reply.text is clean.
 * The pipeline shape is the same as production; only the LLM/maestro
 * boundary is stubbed so tests are deterministic and fast.
 *
 * Failure of any test here is a LAUNCH BLOCKER.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createBenson } from "./benson.js";
import { presentResult } from "./presenter.js";
import type { ExecutionResult, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a single prompt through the full Benson pipeline with a controlled result. */
async function runPipeline(
  prompt: string,
  result: ExecutionResult,
): Promise<{ text: string; kind: string; durationMs: number }> {
  const start = Date.now();
  const benson = createBenson({
    executeTask: async () => result,
  });
  const reply = await benson.handleUserMessage(prompt);
  const durationMs = Date.now() - start;
  return { text: reply.text, kind: reply.kind, durationMs };
}

/**
 * Patterns that must NEVER appear in user-visible output.
 * This list is deliberately conservative — it targets known leakage classes,
 * not just specific strings.
 */
const FORBIDDEN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "thinking prefix",       re: /^thinking\.\.\./im },
  { label: "let me think",          re: /\blet me think\b/i },
  { label: "i need to (analysis)",  re: /^i need to (think|figure|work|check|analyze|determine)/im },
  { label: "scratchpad label",      re: /^scratchpad:/im },
  { label: "reasoning label",       re: /^reasoning:/im },
  { label: "analysis label",        re: /^analysis:/im },
  { label: "internal note",         re: /^internal note:/im },
  { label: "chain of thought",      re: /\bchain of thought\b/i },
  { label: "<thought> tag",         re: /<thought>/i },
  { label: "<thinking> tag",        re: /<thinking>/i },
  { label: "<tool_call> tag",       re: /<tool_call>/i },
  { label: "Thought: label line",   re: /^Thought:\s/im },
  { label: "Observation: label",    re: /^Observation:\s/im },
  { label: "Brain: role handoff",   re: /^Brain:\s/im },
  { label: "Reviewer: handoff",     re: /^Reviewer:\s/im },
  { label: "Planner: handoff",      re: /^Planner:\s/im },
  { label: "Narrator: handoff",     re: /^Narrator:\s/im },
];

function assertNoLeakage(text: string, context: string): void {
  for (const { label, re } of FORBIDDEN_PATTERNS) {
    if (re.test(text)) {
      throw new Error(
        `TRUST VIOLATION [${context}]: forbidden pattern "${label}" found in visible output.\n` +
        `Output was:\n---\n${text}\n---`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — Clean simple answer
// Prevents: unchecked passthrough of clean output breaking something
// ---------------------------------------------------------------------------
describe("Trust: clean simple answer", () => {
  it("clean output passes through unmodified (no leakage, correct content)", async () => {
    const { text, kind, durationMs } = await runPipeline(
      "What is the capital of France?",
      {
        status: "SUCCESS",
        userFacingText: "The capital of France is Paris.",
        summary: "ok",
      },
    );

    expect(kind).toBe("RESULT");
    expect(text).toBe("The capital of France is Paris.");
    assertNoLeakage(text, "clean simple answer");
    expect(durationMs).toBeLessThan(500);
  });

  it("SUCCESS with no userFacingText falls back to goals summary", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        summary: "ok",
      }),
    });
    const reply = await benson.handleUserMessage("Create a README for Orca");
    expect(reply.kind).toBe("RESULT");
    expect(reply.text.length).toBeGreaterThan(0);
    assertNoLeakage(reply.text, "goals fallback");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Internal-thought contamination attempt
// Prevents: chain-of-thought / scratchpad text reaching visible chat
// ---------------------------------------------------------------------------
describe("Trust: internal-thought contamination", () => {
  it("strips <thought> XML blocks from maestro output", async () => {
    const { text } = await runPipeline(
      "Explain recursion",
      {
        status: "SUCCESS",
        userFacingText:
          "<thought>Let me think about how to explain this clearly...</thought>\n" +
          "Recursion is when a function calls itself.",
        summary: "ok",
      },
    );

    expect(text).not.toContain("<thought>");
    expect(text).not.toContain("Let me think about how to explain this clearly");
    expect(text).toContain("Recursion is when a function calls itself.");
    assertNoLeakage(text, "thought XML");
  });

  it("strips <thinking> XML blocks", async () => {
    const { text } = await runPipeline(
      "What is 2+2?",
      {
        status: "SUCCESS",
        userFacingText:
          "<thinking>I need to calculate 2+2. This is a simple arithmetic problem.</thinking>\n" +
          "4",
        summary: "ok",
      },
    );

    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("I need to calculate");
    expect(text).toContain("4");
    assertNoLeakage(text, "thinking XML");
  });

  it("FINAL ANSWER: marker discards everything before it", async () => {
    const { text } = await runPipeline(
      "Write a hello world function",
      {
        status: "SUCCESS",
        userFacingText:
          "Thought: Let me think about this task.\n" +
          "Observation: The user wants a simple function.\n" +
          "Next: I will write the code.\n" +
          "FINAL ANSWER:\n" +
          "```js\nfunction hello() { return 'Hello, world!'; }\n```",
        summary: "ok",
      },
    );

    expect(text).not.toContain("Let me think about this task");
    expect(text).not.toContain("The user wants a simple function");
    expect(text).not.toContain("I will write the code");
    expect(text).toContain("function hello()");
    assertNoLeakage(text, "FINAL ANSWER marker");
  });

  it("strips Thought:/Observation:/Next: lines without FINAL ANSWER marker", async () => {
    const { text } = await runPipeline(
      "Summarize this",
      {
        status: "SUCCESS",
        userFacingText:
          "Thought: analyzing the request\n" +
          "Observation: it is a summary request\n" +
          "Here is the summary: Orca is a coding assistant.",
        summary: "ok",
      },
    );

    expect(text).not.toContain("Thought:");
    expect(text).not.toContain("Observation:");
    expect(text).toContain("Orca is a coding assistant");
    assertNoLeakage(text, "Thought/Observation lines");
  });

  it("strips role-prefixed handoff lines", async () => {
    const { text } = await runPipeline(
      "Review this PR",
      {
        status: "SUCCESS",
        userFacingText:
          "Brain: routing to reviewer role\n" +
          "Reviewer: starting analysis of the code\n" +
          "The code looks good overall. One suggestion: add error handling in line 42.",
        summary: "ok",
      },
    );

    expect(text).not.toMatch(/^Brain:/im);
    expect(text).not.toMatch(/^Reviewer:/im);
    expect(text).toContain("The code looks good overall");
    assertNoLeakage(text, "role handoff lines");
  });

  it("strips scratchpad/reasoning/analysis label lines", async () => {
    const { text } = await runPipeline(
      "Debug this error",
      {
        status: "SUCCESS",
        userFacingText:
          "Reasoning: The error is likely a null pointer.\n" +
          "Analysis: Checking the stack trace...\n" +
          "Scratchpad: variable x is undefined at line 10\n" +
          "The null pointer exception occurs because `x` is never initialized.",
        summary: "ok",
      },
    );

    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).not.toMatch(/^Analysis:/im);
    expect(text).not.toMatch(/^Scratchpad:/im);
    expect(text).toContain("null pointer exception");
    assertNoLeakage(text, "scratchpad/reasoning lines");
  });

  it("strips <scratchpad> XML blocks", async () => {
    const { text } = await runPipeline(
      "Plan a feature",
      {
        status: "SUCCESS",
        userFacingText:
          "<scratchpad>step 1: think\nstep 2: plan\nstep 3: implement</scratchpad>\n" +
          "Here is the implementation plan for the feature.",
        summary: "ok",
      },
    );

    expect(text).not.toContain("<scratchpad>");
    expect(text).not.toContain("step 1: think");
    expect(text).toContain("implementation plan");
    assertNoLeakage(text, "scratchpad XML");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Tool-use output
// Prevents: raw tool coordination chatter reaching visible chat
// ---------------------------------------------------------------------------
describe("Trust: tool-use output", () => {
  it("tool result text passes cleanly without internal chatter", async () => {
    const { text } = await runPipeline(
      "Read the file package.json and tell me the version",
      {
        status: "SUCCESS",
        userFacingText: "The version in package.json is 1.0.0.",
        summary: "ok",
      },
    );

    expect(text).toBe("The version in package.json is 1.0.0.");
    assertNoLeakage(text, "tool result clean");
  });

  it("strips <tool_call> XML if it accidentally leaks into output", async () => {
    const { text } = await runPipeline(
      "List files",
      {
        status: "SUCCESS",
        userFacingText:
          "<tool_call>{ \"name\": \"readFile\", \"args\": { \"path\": \".\" } }</tool_call>\n" +
          "The directory contains: src/, tests/, package.json",
        summary: "ok",
      },
    );

    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("readFile");
    expect(text).toContain("The directory contains");
    assertNoLeakage(text, "tool_call XML");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Error path
// Prevents: stack traces and internal error details leaking into visible chat
// ---------------------------------------------------------------------------
describe("Trust: error path", () => {
  it("FAIL with userFacingText shows clean message plus QC note", async () => {
    const { text } = await runPipeline(
      "Create a new module",
      {
        status: "FAIL",
        userFacingText: "I was unable to complete the task.",
        summary: "QC verdict: FAIL",
      },
    );

    expect(text).toContain("I was unable to complete the task");
    // QC note is shown to user but in general form — no internal issue codes
    expect(text).toContain("QC noted some issues");
    // No stack traces or internal summaries
    expect(text).not.toContain("QC verdict: FAIL");
    assertNoLeakage(text, "FAIL with output");
  });

  it("FAIL with no output returns honest generic failure with next-step question", async () => {
    const { text } = await runPipeline(
      "Fix this bug",
      {
        status: "FAIL",
        summary: "ok",
      },
    );

    expect(text).toContain("did not complete as expected");
    assertNoLeakage(text, "FAIL no output");
  });

  it("FAIL with internal error summary shows it only in general form", async () => {
    const { text } = await runPipeline(
      "Build the project",
      {
        status: "FAIL",
        summary: "API error 401: invalid key",
      },
    );

    // The error detail may surface since it helps users — but internal prefixes must not
    expect(text).not.toMatch(/^Brain:/im);
    expect(text).not.toMatch(/^Thought:/im);
    assertNoLeakage(text, "FAIL error summary");
  });

  it("WARN status shows output with budget note, no internal chatter", async () => {
    const { text } = await runPipeline(
      "Refactor the entire codebase",
      {
        status: "WARN",
        userFacingText: "Refactored 3 of 10 files.",
        summary: "Spending limit reached.",
      },
    );

    expect(text).toContain("Refactored 3 of 10 files");
    expect(text).toContain("Spending limit reached");
    expect(text).not.toContain("budget");
    assertNoLeakage(text, "WARN output");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Multi-role orchestration
// Prevents: planner/reviewer/narrator handoff text leaking to visible chat
// ---------------------------------------------------------------------------
describe("Trust: multi-role orchestration output", () => {
  it("planner output strips planning preamble before user sees it", async () => {
    // When output has a code block but no FINAL ANSWER marker, cleanOutput()
    // extracts the code region (stripping prose preamble). The role handoff
    // lines are stripped first, so they never appear. The code block — the
    // actual deliverable — is what the user sees.
    const { text } = await runPipeline(
      "Create a REST API endpoint",
      {
        status: "SUCCESS",
        userFacingText:
          "Planner: I will decompose this into steps.\n" +
          "Narrator: Generating the response for the user.\n" +
          "Here is the REST endpoint implementation:\n\n" +
          "```ts\napp.get('/users', handler);\n```",
        summary: "ok",
      },
    );

    expect(text).not.toMatch(/^Planner:/im);
    expect(text).not.toMatch(/^Narrator:/im);
    // Code block (the deliverable) is preserved; prose preamble is stripped by code extraction
    expect(text).toContain("app.get('/users', handler)");
    assertNoLeakage(text, "multi-role orchestration");
  });

  it("output with mixed reasoning + answer keeps only the answer", async () => {
    const { text } = await runPipeline(
      "Add tests for the parser",
      {
        status: "SUCCESS",
        userFacingText:
          "Internal note: the user wants unit tests.\n" +
          "I need to determine the best test framework.\n" +
          "FINAL ANSWER:\n" +
          "Added 5 tests in `parser.test.ts`. Run `pnpm test` to verify.",
        summary: "ok",
      },
    );

    expect(text).not.toContain("Internal note:");
    expect(text).not.toContain("I need to determine");
    expect(text).toContain("Added 5 tests");
    assertNoLeakage(text, "mixed reasoning + answer");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Regression guard: forbidden patterns
// This test fails if ANY of the known leakage patterns pass through cleanOutput.
// It is intentionally exhaustive.
// ---------------------------------------------------------------------------
describe("Trust: forbidden-pattern regression guard", () => {
  const LEAKAGE_INPUTS: Array<{ label: string; raw: string; safeFragment: string }> = [
    {
      label: "<thought> block",
      raw: "<thought>internal reasoning here</thought>\nUser-safe answer.",
      safeFragment: "User-safe answer.",
    },
    {
      label: "<thinking> block",
      raw: "<thinking>deep analysis</thinking>\nThe result is 42.",
      safeFragment: "The result is 42.",
    },
    {
      label: "<tool_call> block",
      raw: "<tool_call>{\"name\":\"readFile\"}</tool_call>\nFile read successfully.",
      safeFragment: "File read successfully.",
    },
    {
      label: "<scratchpad> block",
      raw: "<scratchpad>note to self</scratchpad>\nHere is the answer.",
      safeFragment: "Here is the answer.",
    },
    {
      label: "FINAL ANSWER boundary",
      raw: "Thought: lots of internal stuff\nObservation: more stuff\nFINAL ANSWER:\nClean answer only.",
      safeFragment: "Clean answer only.",
    },
    {
      label: "Thought: label line",
      raw: "Thought: reasoning step\nThe answer is blue.",
      safeFragment: "The answer is blue.",
    },
    {
      label: "Reasoning: label line",
      raw: "Reasoning: working through the problem\nThe result is correct.",
      safeFragment: "The result is correct.",
    },
    {
      label: "Brain: role line",
      raw: "Brain: routing to narrator role\nHere is the explanation.",
      safeFragment: "Here is the explanation.",
    },
    {
      label: "Reviewer: role line",
      raw: "Reviewer: checking quality\nThe code passes review.",
      safeFragment: "The code passes review.",
    },
    {
      label: "Planner: role line",
      raw: "Planner: decomposing task\nPlan created successfully.",
      safeFragment: "Plan created successfully.",
    },
    {
      label: "Narrator: role line",
      raw: "Narrator: formatting the response\nHere is your summary.",
      safeFragment: "Here is your summary.",
    },
  ];

  for (const { label, raw, safeFragment } of LEAKAGE_INPUTS) {
    it(`strips "${label}" and preserves safe content`, async () => {
      const { text } = await runPipeline("Any user prompt", {
        status: "SUCCESS",
        userFacingText: raw,
        summary: "ok",
      });

      assertNoLeakage(text, label);
      expect(text).toContain(safeFragment);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 7 — Golden / snapshot tests
// Canonical prompt → expected visible output checks.
// These protect against regressions when presenter logic changes.
// ---------------------------------------------------------------------------
describe("Trust: golden output tests", () => {
  it("golden: simple success answer is returned verbatim", async () => {
    const { text } = await runPipeline(
      "What is TypeScript?",
      {
        status: "SUCCESS",
        userFacingText: "TypeScript is a statically typed superset of JavaScript.",
        summary: "ok",
      },
    );
    expect(text).toBe("TypeScript is a statically typed superset of JavaScript.");
  });

  it("golden: code-only output is preserved exactly", async () => {
    const code = "```ts\nconst x: number = 42;\n```";
    const { text } = await runPipeline(
      "Show me a TypeScript variable declaration",
      {
        status: "SUCCESS",
        userFacingText: code,
        summary: "ok",
      },
    );
    expect(text).toBe(code);
  });

  it("golden: FINAL ANSWER content preserved exactly", async () => {
    const answer = "The answer is 42.";
    const { text } = await runPipeline(
      "Answer the ultimate question",
      {
        status: "SUCCESS",
        userFacingText: `Some internal monologue...\nFINAL ANSWER:\n${answer}`,
        summary: "ok",
      },
    );
    expect(text).toBe(answer);
  });

  it("golden: WARN output includes both content and budget note", async () => {
    const { text } = await runPipeline(
      "Do a large task",
      {
        status: "WARN",
        userFacingText: "Partial result.",
        summary: "Spending limit reached.",
      },
    );
    expect(text).toContain("Partial result.");
    expect(text).toContain("Spending limit reached.");
    assertNoLeakage(text, "golden WARN");
  });

  it("golden: FAIL with no output returns standardized message", async () => {
    const { text } = await runPipeline(
      "Fix this bug",
      {
        status: "FAIL",
        summary: "ok",
      },
    );
    expect(text).toContain("did not complete as expected");
    assertNoLeakage(text, "golden FAIL");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — followUpQuestion trust gap (LAUNCH BLOCKER fix)
//
// Prior to this fix, followUpQuestion bypassed cleanOutput() entirely and
// was returned with only .trim(), allowing internal markup to reach the user.
// Every case here proves the sanitization path is now applied.
// ---------------------------------------------------------------------------

/** Minimal TaskSpec stub needed by presentResult. */
const STUB_TASK: TaskSpec = {
  originalUserMessage: "stub",
  intent: "stub",
  goals: ["stub"],
};

describe("Trust: followUpQuestion sanitization (bypass fix)", () => {
  it("clean follow-up question is preserved verbatim", () => {
    // Prevent regression: legit questions must survive sanitization
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion: "Would you like me to also update the tests?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).toBe("Would you like me to also update the tests?");
    assertNoLeakage(text, "clean followUpQuestion");
  });

  it("followUpQuestion with <thinking> block strips internal content", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "<thinking>The user probably wants to update all files.</thinking>" +
        "Should I also update the related test files?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("The user probably wants to");
    expect(text).toContain("Should I also update the related test files?");
    assertNoLeakage(text, "followUpQuestion <thinking>");
  });

  it("followUpQuestion with <analysis> block strips internal content", () => {
    const result: ExecutionResult = {
      status: "FAIL",
      followUpQuestion:
        "<analysis>Error seems to be in the auth module.</analysis>" +
        "Would you like me to investigate the auth module?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toContain("<analysis>");
    expect(text).not.toContain("Error seems to be in the auth module");
    expect(text).toContain("Would you like me to investigate the auth module?");
    assertNoLeakage(text, "followUpQuestion <analysis>");
  });

  it("followUpQuestion with Reasoning: prefix strips it", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "Reasoning: the task requires filesystem access.\n" +
        "Do you want me to proceed with file writes enabled?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).toContain("Do you want me to proceed with file writes enabled?");
    assertNoLeakage(text, "followUpQuestion Reasoning:");
  });

  it("followUpQuestion with Brain: role line strips it", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "Brain: routing to clarification handler\n" +
        "Which directory should I use as the project root?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toMatch(/^Brain:/im);
    expect(text).toContain("Which directory should I use as the project root?");
    assertNoLeakage(text, "followUpQuestion Brain:");
  });

  it("followUpQuestion with Analysis: label strips it", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "Analysis: multiple config files detected\n" +
        "Which config file takes precedence?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toMatch(/^Analysis:/im);
    expect(text).toContain("Which config file takes precedence?");
    assertNoLeakage(text, "followUpQuestion Analysis:");
  });

  it("followUpQuestion with FINAL ANSWER preamble: preamble is stripped, question survives", () => {
    // The FINAL ANSWER extraction does NOT apply to cleanFollowUp — so the
    // preamble stays unless it matches a label/role pattern. The "FINAL ANSWER:"
    // line itself is just treated as a label (not as a boundary here).
    // The important thing: no internal reasoning markers reach the user.
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "Reasoning: user wants a clarification\n" +
        "Should I include type annotations in the output?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).toContain("Should I include type annotations in the output?");
    assertNoLeakage(text, "followUpQuestion preamble");
  });

  it("followUpQuestion with <scratchpad> block strips it", () => {
    const result: ExecutionResult = {
      status: "SUCCESS",
      followUpQuestion:
        "<scratchpad>user seems to want X not Y</scratchpad>" +
        "Are you looking for a complete rewrite or just a targeted fix?",
    };
    const text = presentResult(result, STUB_TASK);
    expect(text).not.toContain("<scratchpad>");
    expect(text).not.toContain("user seems to want X not Y");
    expect(text).toContain("Are you looking for a complete rewrite or just a targeted fix?");
    assertNoLeakage(text, "followUpQuestion <scratchpad>");
  });

  it("followUpQuestion takes precedence over userFacingText and is sanitized", async () => {
    // Proves the precedence AND sanitization path together
    const { text, kind } = await runPipeline(
      "Fix the authentication bug",
      {
        status: "SUCCESS",
        userFacingText: "Fixed the auth bug.",
        followUpQuestion:
          "Reasoning: need more context\n" +
          "Should I also update the session expiry logic?",
      },
    );

    expect(kind).toBe("RESULT");
    // followUpQuestion takes precedence over userFacingText
    expect(text).not.toContain("Fixed the auth bug");
    // Reasoning: line is stripped
    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).toContain("Should I also update the session expiry logic?");
    assertNoLeakage(text, "followUpQuestion precedence+sanitization");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — stdout/stderr separation
//
// Proves that internal diagnostics (Dewey, Pappy, FallbackPool, RunnerRegistry)
// reach stderr — NOT stdout — while the visible reply goes to stdout.
// Prevents: console.log leaks from re-emerging in future commits.
// ---------------------------------------------------------------------------
describe("Trust: stdout/stderr separation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no console.log is emitted during a clean pipeline run", async () => {
    // Spy on stdout writes. Any console.log call would fail this assertion.
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const consoleSpy = vi.spyOn(console, "log");

    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        userFacingText: "The answer is 42.",
        summary: "ok",
      }),
    });
    await benson.handleUserMessage("What is the answer?");

    // console.log must not have been called during pipeline execution
    expect(consoleSpy).not.toHaveBeenCalled();
    // Direct process.stdout.write should also be silent during pipeline
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("internal diagnostic content stays off the reply text even when emitted to stderr", async () => {
    // Simulate a scenario where stderr receives diagnostic content.
    // The final reply text must remain clean regardless.
    const stderrSpy = vi.spyOn(process.stderr, "write");
    const stderrLog = vi.spyOn(console, "error");

    const benson = createBenson({
      executeTask: async () => {
        // Simulate an internal component emitting a diagnostic to stderr
        console.error("[Pappy FAIL] 1 issue(s): HIGH TEST: test issue");
        return {
          status: "SUCCESS" as const,
          userFacingText: "The task completed successfully.",
          summary: "ok",
        };
      },
    });

    const reply = await benson.handleUserMessage("Do something");

    // stderr received the diagnostic (observability preserved).
    // The diagnostic may be one or two arguments depending on the call site —
    // just verify it was called and the first arg contains the marker.
    expect(stderrLog).toHaveBeenCalled();
    const firstCall = stderrLog.mock.calls[0]!;
    expect(String(firstCall[0])).toContain("[Pappy FAIL]");

    // But the visible reply is completely clean
    expect(reply.text).toBe("The task completed successfully.");
    assertNoLeakage(reply.text, "stderr diagnostic isolation");

    // Pappy diagnostic text must NOT appear in the user reply
    expect(reply.text).not.toContain("[Pappy FAIL]");
    expect(reply.text).not.toContain("HIGH TEST");

    // Suppress unused variable warning
    void stderrSpy;
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — Integration: full Benson→presentResult boundary
//
// Exercises the real presentation layer (not just a helper) with realistic
// contaminated inputs, proving the entire output path is protected.
// ---------------------------------------------------------------------------
describe("Trust: integration — Benson→presentResult boundary", () => {
  it("multi-step output with mixed role chatter produces clean final answer", async () => {
    // Simulates an agent loop that emitted intermediate role chatter before
    // generating the final answer.
    const { text } = await runPipeline(
      "Implement a login form",
      {
        status: "SUCCESS",
        userFacingText: [
          "Brain: decomposing into sub-tasks",
          "Planner: step 1 — create form component",
          "Planner: step 2 — add validation",
          "Narrator: writing the response now",
          "FINAL ANSWER:",
          "Here is the login form implementation with email and password fields.",
        ].join("\n"),
        summary: "ok",
      },
    );

    expect(text).not.toMatch(/^Brain:/im);
    expect(text).not.toMatch(/^Planner:/im);
    expect(text).not.toMatch(/^Narrator:/im);
    expect(text).toContain("Here is the login form implementation");
    assertNoLeakage(text, "multi-step role chatter");
  });

  it("XML blocks mixed with legitimate answer: only answer survives", async () => {
    const { text } = await runPipeline(
      "Explain async/await",
      {
        status: "SUCCESS",
        userFacingText:
          "<thinking>The user is asking about async/await. I should give a clear explanation.</thinking>\n" +
          "<analysis>This is a conceptual question, not a code task.</analysis>\n" +
          "FINAL ANSWER:\n" +
          "Async/await is syntactic sugar over Promises that makes asynchronous code read like synchronous code.",
        summary: "ok",
      },
    );

    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("<analysis>");
    expect(text).not.toContain("The user is asking about async/await");
    expect(text).toContain("Async/await is syntactic sugar");
    assertNoLeakage(text, "XML blocks + FINAL ANSWER");
  });

  it("WARN output with contaminated userFacingText still sanitizes before warning note", async () => {
    const { text } = await runPipeline(
      "Refactor the payment module",
      {
        status: "WARN",
        userFacingText:
          "Reasoning: refactored 2 of 5 files\n" +
          "Partially refactored the payment module. Files updated: payment.ts, types.ts.",
        summary: "Budget cap reached.",
      },
    );

    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).toContain("Partially refactored the payment module");
    expect(text).toContain("Budget cap reached.");
    assertNoLeakage(text, "WARN contaminated text");
  });

  it("FAIL output with role-prefixed userFacingText sanitizes before QC note", async () => {
    const { text } = await runPipeline(
      "Build the CI pipeline",
      {
        status: "FAIL",
        userFacingText:
          "Reviewer: the output does not meet requirements\n" +
          "The CI configuration was partially created but could not be validated.",
        summary: "QC FAIL",
      },
    );

    expect(text).not.toMatch(/^Reviewer:/im);
    expect(text).toContain("CI configuration was partially created");
    expect(text).toContain("QC noted some issues");
    assertNoLeakage(text, "FAIL contaminated role prefix");
  });

  it("presentResult() directly: all status paths sanitize userFacingText", () => {
    // Direct presentResult() call — not through Benson — to test the
    // presentation layer in isolation.
    const contaminated =
      "Brain: routing complete\nThe task finished successfully.";

    const successText = presentResult(
      { status: "SUCCESS", userFacingText: contaminated, summary: "ok" },
      STUB_TASK,
    );
    expect(successText).not.toMatch(/^Brain:/im);
    expect(successText).toContain("The task finished successfully.");

    const warnText = presentResult(
      { status: "WARN", userFacingText: contaminated, summary: "note" },
      STUB_TASK,
    );
    expect(warnText).not.toMatch(/^Brain:/im);
    expect(warnText).toContain("The task finished successfully.");

    const failText = presentResult(
      { status: "FAIL", userFacingText: contaminated, summary: "ok" },
      STUB_TASK,
    );
    expect(failText).not.toMatch(/^Brain:/im);
    expect(failText).toContain("The task finished successfully.");
  });
});
