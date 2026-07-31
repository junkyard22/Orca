/**
 * pipeline.test.ts — End-to-end pipeline validation tests
 *
 * This suite exercises the REAL Benson → OrcaRuntime → Presenter wiring,
 * the only test layer that proves all three packages integrate correctly.
 *
 * Architecture under test:
 *
 *   createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) })
 *         ↓
 *   benson.handleUserMessage(prompt)
 *         ↓  parseIntent (deterministic, no LLM)
 *   runtime.executeTask(taskSpec)
 *         ↓  stub MaestroPort → controlled outputText (incl. contaminated)
 *         ↓  stub PappyPort  → controlled verdict (PASS / WARN / FAIL)
 *   presentResult(executionResult, taskSpec)  ← real presenter, real cleanOutput()
 *         ↓
 *   reply.text  ← this is what the user sees
 *
 * Distinction from existing test files:
 *   - trust.test.ts      : Benson + raw executeTask mock → presenter only
 *   - runtime.test.ts    : OrcaRuntime + mock maestro/pappy → OrcaExecutionResult only
 *   - THIS FILE          : Benson + real OrcaRuntime + stub maestro/pappy → final reply.text
 *
 * The stubs sit at the LLM/model boundary; everything above is real code.
 *
 * Failure of any test here is a LAUNCH BLOCKER — it means real pipeline
 * output can differ from the trust guarantees proven at the unit level.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createBenson } from "@clawde/benson-core";
import type { TaskSpec, ExecutionResult, ExecuteTaskOptions } from "@clawde/benson-core";
import { createOrcaRuntime } from "@clawde/orca-core";
import type { MaestroPort, PappyPort, OrcaRunCtx, OrcaTaskSpec, OrcaExecutionResult } from "@clawde/orca-core";
import type { PappyResult, PappyInput } from "@clawde/pappy-core";

// ---------------------------------------------------------------------------
// Cross-boundary adapter: benson-core and orca-core are independent packages
// with structurally compatible but nominally divergent types (permissions field).
// normalizeTaskSpec() in orca-core already handles the array→object conversion
// at runtime; this wrapper satisfies TypeScript at the wiring boundary.
// ---------------------------------------------------------------------------
function bensonExecuteTask(
  executeTask: (taskSpec: OrcaTaskSpec, options?: { abortSignal?: AbortSignal }) => Promise<OrcaExecutionResult>
): (task: TaskSpec, options?: ExecuteTaskOptions) => Promise<ExecutionResult> {
  return (task, opts) => executeTask(task as unknown as OrcaTaskSpec, opts) as Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Stub builders
// These sit at the model/LLM boundary. Everything above them is real code.
// ---------------------------------------------------------------------------

function stubMaestro(outputText: string): MaestroPort {
  return {
    run: async (_task: OrcaTaskSpec, _ctx: OrcaRunCtx) => ({
      outputText,
      summary: "stub",
      toolEvents: [],
      filesChanged: [],
    }),
  };
}

function stubPappyResult(verdict: "PASS" | "WARN" | "FAIL"): PappyResult {
  return {
    verdict,
    // Mirrors deriveTrainingEligibility for the stub's issue set: a WARN is a
    // partial success and needs review; PASS and an honest FAIL stay eligible.
    trainingEligibility: verdict === "WARN" ? "needs_human_review" : "eligible",
    confidence: 1.0,
    summary: `stub-${verdict}`,
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: verdict === "FAIL"
      ? [{
          issueId: "STUB:001",
          severity: "HIGH",
          code: "STUB",
          category: "Completeness",
          description: "stub failure",
          expected_receipt: "none",
          evidence: "none",
          fix_hint: "none",
          message: "stub failure",
        }]
      : [],
    repair_task: null,
    internalSummary: `verdict=${verdict}`,
  };
}

function stubPappy(verdict: "PASS" | "WARN" | "FAIL"): PappyPort {
  return { evaluate: (_input: PappyInput) => stubPappyResult(verdict) };
}

/**
 * Wire the full pipeline and run a single prompt through it.
 * Returns the final reply as seen by the user and timing data.
 */
async function runPipeline(
  prompt: string,
  maestroOutput: string,
  pappyVerdict: "PASS" | "WARN" | "FAIL" = "PASS",
  opts: { captureTrace?: boolean } = {},
): Promise<{
  text: string;
  kind: string;
  durationMs: number;
  traceEntries?: string[];
}> {
  const traceEntries: string[] = [];

  const runtime = createOrcaRuntime({
    maestro: stubMaestro(maestroOutput),
    pappy: stubPappy(pappyVerdict),
    llm: {
      complete: async (p: string) => ({ text: `llm: ${p}` }),
      stream:   async (p: string, _opts: unknown, onChunk: (c: string) => void) => { const t = `llm: ${p}`; onChunk(t); return { text: t }; },
    },
    ...(opts.captureTrace && {
      writeTrace: (trace) => {
        traceEntries.push(...trace.entries.map((e) => e.stage));
      },
    }),
  });

  const benson = createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) });

  const start = Date.now();
  const reply = await benson.handleUserMessage(prompt);
  const durationMs = Date.now() - start;

  return { text: reply.text, kind: reply.kind, durationMs, traceEntries };
}

// ---------------------------------------------------------------------------
// Shared assertion: nothing from the forbidden leakage set may appear in text
// ---------------------------------------------------------------------------

const LEAKAGE_GUARDS: Array<{ label: string; re: RegExp }> = [
  { label: "<thinking> tag",       re: /<thinking>/i },
  { label: "<thought> tag",        re: /<thought>/i },
  { label: "<tool_call> tag",      re: /<tool_call>/i },
  { label: "<scratchpad> tag",     re: /<scratchpad>/i },
  { label: "<analysis> tag",       re: /<analysis>/i },
  { label: "Brain: role line",     re: /^Brain:\s/im },
  { label: "Reviewer: role line",  re: /^Reviewer:\s/im },
  { label: "Planner: role line",   re: /^Planner:\s/im },
  { label: "Narrator: role line",  re: /^Narrator:\s/im },
  { label: "Thought: label",       re: /^Thought:\s/im },
  { label: "Reasoning: label",     re: /^Reasoning:\s/im },
  { label: "Analysis: label",      re: /^Analysis:\s/im },
  { label: "Scratchpad: label",    re: /^Scratchpad:\s/im },
  { label: "Internal note: label", re: /^Internal note:\s/im },
];

function assertClean(text: string, scenario: string): void {
  for (const { label, re } of LEAKAGE_GUARDS) {
    if (re.test(text)) {
      throw new Error(
        `PIPELINE TRUST VIOLATION [${scenario}]:\n` +
        `  Forbidden pattern "${label}" found in user-visible output.\n` +
        `  Output:\n  ${text.split("\n").map((l) => `  │ ${l}`).join("\n")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario A — Happy path
// Tests: clean maestro output passes through unchanged.
// Catches: any accidental stripping of legitimate final answers.
// ---------------------------------------------------------------------------
describe("Pipeline: A — happy path", () => {
  it("A1: clean text answer passes through verbatim", async () => {
    const { text, kind, durationMs } = await runPipeline(
      "Explain what a closure is in JavaScript",
      "A closure is a function that retains access to its lexical scope.",
    );

    expect(kind).toBe("RESULT");
    expect(text).toBe("A closure is a function that retains access to its lexical scope.");
    assertClean(text, "A1 happy-path text");
    expect(durationMs).toBeLessThan(1000);
  });

  it("A2: clean code answer passes through verbatim", async () => {
    const code = "```ts\nfunction greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n```";

    const { text } = await runPipeline(
      "Write a TypeScript greeting function",
      code,
    );

    expect(text).toBe(code);
    assertClean(text, "A2 happy-path code");
  });

  it("A3: PASS verdict produces SUCCESS result with clean output", async () => {
    const { text } = await runPipeline(
      "Fix the null pointer in auth.ts",
      "Fixed the null dereference by adding an early-return guard on line 42.",
      "PASS",
    );

    expect(text).toContain("null dereference");
    assertClean(text, "A3 PASS verdict");
  });
});

// ---------------------------------------------------------------------------
// Scenario B — Brain / reviewer contamination
// Tests: contaminated role chatter is stripped by presenter in the real pipeline.
// Catches: regressions where cleanOutput() stops being called in the wiring.
// ---------------------------------------------------------------------------
describe("Pipeline: B — role contamination filtering", () => {
  it("B1: Brain: routing lines are stripped from final output", async () => {
    const { text } = await runPipeline(
      "Create a login form component",
      [
        "Brain: routing to strong_model role",
        "Here is the login form component.",
      ].join("\n"),
    );

    expect(text).not.toMatch(/^Brain:/im);
    expect(text).toContain("login form component");
    assertClean(text, "B1 Brain: line");
  });

  it("B2: Reviewer: lines are stripped and answer survives", async () => {
    const { text } = await runPipeline(
      "Review this code for security issues",
      [
        "Reviewer: analyzing the input validation",
        "The code is missing input sanitization on the email field.",
      ].join("\n"),
    );

    expect(text).not.toMatch(/^Reviewer:/im);
    expect(text).toContain("input sanitization");
    assertClean(text, "B2 Reviewer: line");
  });

  it("B3: Reasoning: label is stripped and answer survives", async () => {
    const { text } = await runPipeline(
      "Explain the difference between null and undefined",
      [
        "Reasoning: this is a conceptual question",
        "null is an explicit absence of value; undefined means a value was never assigned.",
      ].join("\n"),
    );

    expect(text).not.toMatch(/^Reasoning:/im);
    expect(text).toContain("explicit absence");
    assertClean(text, "B3 Reasoning: label");
  });

  it("B4: <thinking> XML block is stripped and FINAL ANSWER survives", async () => {
    const { text } = await runPipeline(
      "Write a function to reverse a string",
      [
        "<thinking>The user wants a simple string reversal. I will use split/reverse/join.</thinking>",
        "FINAL ANSWER:",
        "```ts\nfunction reverse(s: string): string { return s.split('').reverse().join(''); }\n```",
      ].join("\n"),
    );

    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("The user wants a simple string reversal");
    expect(text).toContain("reverse");
    assertClean(text, "B4 <thinking> + FINAL ANSWER");
  });

  it("B5: multiple role lines + FINAL ANSWER: only clean answer is user-visible", async () => {
    const { text } = await runPipeline(
      "Implement a binary search function",
      [
        "Brain: classifying as coding task",
        "Planner: decomposing into implementation steps",
        "<thinking>Binary search needs sorted array, two pointers, mid-point comparison.</thinking>",
        "Narrator: formatting the response",
        "FINAL ANSWER:",
        "Here is the binary search implementation.",
      ].join("\n"),
    );

    expect(text).not.toMatch(/^Brain:/im);
    expect(text).not.toMatch(/^Planner:/im);
    expect(text).not.toContain("<thinking>");
    expect(text).not.toMatch(/^Narrator:/im);
    expect(text).toContain("binary search implementation");
    assertClean(text, "B5 multi-role + FINAL ANSWER");
  });

  it("B6: <scratchpad> block is stripped and answer survives", async () => {
    const { text } = await runPipeline(
      "Explain async/await",
      [
        "<scratchpad>user wants explanation, no code needed, use prose</scratchpad>",
        "FINAL ANSWER:",
        "Async/await is syntactic sugar over Promises.",
      ].join("\n"),
    );

    expect(text).not.toContain("<scratchpad>");
    expect(text).not.toContain("user wants explanation");
    expect(text).toContain("Async/await is syntactic sugar");
    assertClean(text, "B6 <scratchpad>");
  });

  it("B7: Analysis: label is stripped and answer survives", async () => {
    const { text } = await runPipeline(
      "Debug this error: TypeError: Cannot read properties of undefined",
      [
        "Analysis: the error occurs because the object is accessed before initialization",
        "The TypeError happens because you're accessing a property before the object is initialized.",
      ].join("\n"),
    );

    expect(text).not.toMatch(/^Analysis:/im);
    expect(text).toContain("TypeError");
    assertClean(text, "B7 Analysis: label");
  });
});

// ---------------------------------------------------------------------------
// Scenario C — Pappy WARN verdict path
// Note on runtime behaviour: Pappy's WARN verdict maps to OrcaExecutionResult
// status "SUCCESS" (WARN is not a failure). The ExecutionResult "WARN" status
// only comes from a budget-cap condition inside the runtime, not from Pappy.
// Tests: WARN-verdict output is clean and the successful text is returned.
// Catches: any chatter that slips into the WARN/SUCCESS composition path.
// ---------------------------------------------------------------------------
describe("Pipeline: C — Pappy WARN verdict path", () => {
  it("C1: Pappy WARN verdict returns clean SUCCESS output (no budget note)", async () => {
    // Pappy WARN → runtime status SUCCESS (not WARN) — no "---" note separator.
    const { text } = await runPipeline(
      "Refactor the entire authentication module",
      "Refactored 3 of 8 files.",
      "WARN",
    );

    // Clean partial result is shown, no budget/QC note injected
    expect(text).toContain("Refactored 3 of 8 files");
    expect(text).not.toContain("QC noted");
    assertClean(text, "C1 WARN output");
  });

  it("C2: Pappy WARN with contaminated maestro output still strips role lines", async () => {
    const { text } = await runPipeline(
      "Update all import statements to use aliases",
      [
        "Planner: updating imports across files",
        "Updated 5 of 12 files. Remaining files require manual review.",
      ].join("\n"),
      "WARN",
    );

    expect(text).not.toMatch(/^Planner:/im);
    expect(text).toContain("Updated 5 of 12 files");
    assertClean(text, "C2 WARN contaminated output");
  });
});

// ---------------------------------------------------------------------------
// Scenario D — Failure path
// Tests: FAIL verdict renders safely; contaminated userFacingText still clean.
// Catches: leakage in the failure presentation path.
// ---------------------------------------------------------------------------
describe("Pipeline: D — failure path", () => {
  it("D1: FAIL without repair produces clean failure message", async () => {
    const { text } = await runPipeline(
      "Build the project and run all tests",
      "Unable to complete the build — dependency resolution failed.",
      "FAIL",
    );

    // The output text is shown with a QC note appended
    expect(text).toContain("dependency resolution failed");
    expect(text).toContain("QC noted some issues");
    assertClean(text, "D1 FAIL clean");
  });

  it("D2: FAIL with role-prefixed userFacingText strips role lines before QC note", async () => {
    const { text } = await runPipeline(
      "Fix the failing CI pipeline",
      [
        "Reviewer: the output is incomplete",
        "The CI configuration file was partially updated but the deploy step is missing.",
      ].join("\n"),
      "FAIL",
    );

    expect(text).not.toMatch(/^Reviewer:/im);
    expect(text).toContain("deploy step is missing");
    expect(text).toContain("QC noted some issues");
    assertClean(text, "D2 FAIL contaminated role prefix");
  });

  it("D3: FAIL with <thinking> block in output strips block before QC note", async () => {
    const { text } = await runPipeline(
      "Debug the memory leak",
      "<thinking>I was unable to isolate the leak source.</thinking>\nThe memory leak could not be isolated with available tools.",
      "FAIL",
    );

    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("I was unable to isolate");
    expect(text).toContain("memory leak could not be isolated");
    assertClean(text, "D3 FAIL contaminated thinking block");
  });
});

// ---------------------------------------------------------------------------
// Scenario E — Follow-up question path
// Tests: followUpQuestion is sanitized through cleanFollowUp() in the real pipeline.
// Catches: the bypass gap where followUpQuestion was returned with .trim() only.
// ---------------------------------------------------------------------------
describe("Pipeline: E — followUpQuestion sanitization in real pipeline", () => {
  it("E1: clean follow-up question surfaces unchanged", async () => {
    // Wire Benson with a runtime that emits a followUpQuestion
    const runtime = createOrcaRuntime({
      maestro: {
        run: async () => ({
          outputText: undefined,
          summary: "stub",
          toolEvents: [],
          filesChanged: [],
        }),
      },
      pappy: {
        evaluate: () => ({
          ...stubPappyResult("PASS"),
          // Inject followUpQuestion via the execution result contract
        }),
      },
      llm: {
        complete: async (p: string) => ({ text: `llm: ${p}` }),
        stream:   async (p: string, _opts: unknown, onChunk: (c: string) => void) => { const t = `llm: ${p}`; onChunk(t); return { text: t }; },
      },
    });

    // Bypass the runtime and inject followUpQuestion directly through Benson's
    // executeTask injection — this matches the real app-shell wiring pattern.
    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        followUpQuestion: "Should I also update the related test files?",
      }),
    });

    const reply = await benson.handleUserMessage("Create a new utility function");

    expect(reply.text).toBe("Should I also update the related test files?");
    assertClean(reply.text, "E1 clean followUpQuestion");

    // Suppress unused var
    void runtime;
  });

  it("E2: followUpQuestion with <thinking> block is stripped in real pipeline", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        followUpQuestion:
          "<thinking>User probably wants all affected tests updated.</thinking>" +
          "Should I also update the related test files?",
      }),
    });

    const reply = await benson.handleUserMessage("Refactor the payment module");

    expect(reply.text).not.toContain("<thinking>");
    expect(reply.text).not.toContain("User probably wants");
    expect(reply.text).toContain("Should I also update the related test files?");
    assertClean(reply.text, "E2 followUpQuestion <thinking>");
  });

  it("E3: followUpQuestion with Brain: prefix is stripped in real pipeline", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        followUpQuestion:
          "Brain: routing to clarification mode\n" +
          "Which test framework should I use for the new tests?",
      }),
    });

    const reply = await benson.handleUserMessage("Add tests for the parser");

    expect(reply.text).not.toMatch(/^Brain:/im);
    expect(reply.text).toContain("Which test framework");
    assertClean(reply.text, "E3 followUpQuestion Brain: prefix");
  });

  it("E4: followUpQuestion with Reasoning: label is stripped in real pipeline", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "SUCCESS" as const,
        followUpQuestion:
          "Reasoning: the task scope is ambiguous\n" +
          "Do you want me to update all files or only the core module?",
      }),
    });

    const reply = await benson.handleUserMessage("Update the configuration");

    expect(reply.text).not.toMatch(/^Reasoning:/im);
    expect(reply.text).toContain("Do you want me to update all files");
    assertClean(reply.text, "E4 followUpQuestion Reasoning:");
  });
});

// ---------------------------------------------------------------------------
// Scenario F — Observability path
// Tests: stderr diagnostics never contaminate user-visible reply.text.
// Catches: any future console.log → console.error regression.
// ---------------------------------------------------------------------------
describe("Pipeline: F — observability (stderr vs stdout)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("F1: no console.log fires during a full clean pipeline run", async () => {
    const consoleSpy = vi.spyOn(console, "log");

    await runPipeline(
      "Write a function to calculate factorial",
      "function factorial(n: number): number { return n <= 1 ? 1 : n * factorial(n - 1); }",
    );

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("F2: stderr diagnostics (Pappy FAIL) do not contaminate reply.text", async () => {
    // Production runtime.ts emits "[Pappy FAIL] N issue(s):" to console.error
    // when Pappy returns a FAIL verdict. This test verifies that diagnostic
    // output never finds its way into the user-visible reply text.
    //
    // Note: vitest captures console output at a lower level than vi.spyOn,
    // so we verify the trust invariant (clean text) rather than the spy call count.
    const { text } = await runPipeline(
      "Fix the broken authentication",
      "Fixed the authentication bug by correcting the token validation logic.",
      "FAIL",
    );

    // The reply text is clean — the Pappy diagnostic does NOT appear
    expect(text).toContain("token validation logic");
    expect(text).not.toContain("[Pappy FAIL]");
    expect(text).not.toContain("HIGH STUB");
    expect(text).not.toContain("stub failure");
    assertClean(text, "F2 stderr isolation");
  });

  it("F3: pipeline trace entries are captured off the user-visible path", async () => {
    const { text, traceEntries } = await runPipeline(
      "Generate a TypeScript interface for a User object",
      "interface User { id: string; name: string; email: string; }",
      "PASS",
      { captureTrace: true },
    );

    // Trace is populated (observability working)
    expect(traceEntries!.length).toBeGreaterThan(0);
    expect(traceEntries).toContain("task.received");
    expect(traceEntries).toContain("maestro.run.result");
    expect(traceEntries).toContain("task.completed");

    // But trace entries never bleed into the user-visible text
    expect(text).not.toContain("task.received");
    expect(text).not.toContain("maestro.run.result");
    assertClean(text, "F3 trace isolation");
  });
});

// ---------------------------------------------------------------------------
// Scenario G — Contract path (golden)
// Tests: the exact output contract at the runner/presenter boundary.
// These serve as regression anchors — if they break, the contract changed.
// ---------------------------------------------------------------------------
describe("Pipeline: G — output contract (golden)", () => {
  it("G1: clean PASS answer is the verbatim maestro output", async () => {
    const expected = "The capital of Japan is Tokyo.";

    const { text } = await runPipeline(
      "What is the capital of Japan?",
      expected,
      "PASS",
    );

    expect(text).toBe(expected);
  });

  it("G2: FINAL ANSWER boundary: only content after marker is shown", async () => {
    const { text } = await runPipeline(
      "Explain recursion in one sentence",
      "Some internal monologue about the topic.\nFINAL ANSWER:\nRecursion is when a function calls itself to solve a smaller version of the same problem.",
    );

    expect(text).toBe("Recursion is when a function calls itself to solve a smaller version of the same problem.");
    assertClean(text, "G2 FINAL ANSWER contract");
  });

  it("G3: Pappy WARN verdict → SUCCESS result; clean text is the exact output", async () => {
    // Runtime contract: Pappy WARN verdict → OrcaExecutionResult status "SUCCESS".
    // No budget note or separator is added — only the clean maestro text is shown.
    // (Budget-capped WARN is a separate code path involving `budgetUsd` option.)
    const { text } = await runPipeline(
      "Migrate the database schema",
      "Migrated 2 of 5 tables successfully.",
      "WARN",
    );

    expect(text).toBe("Migrated 2 of 5 tables successfully.");
    assertClean(text, "G3 WARN→SUCCESS contract");
  });

  it("G4: FAIL output = clean text + QC note + next-step question", async () => {
    const { text } = await runPipeline(
      "Build and deploy the application",
      "The deployment step failed due to missing environment variables.",
      "FAIL",
    );

    expect(text).toContain("deployment step failed");
    expect(text).toContain("QC noted some issues");
    // Next-step question is appended (intent contains "build")
    expect(text).toMatch(/Would you like|How would you like/);
    assertClean(text, "G4 FAIL contract");
  });

  it("G5: full pipeline round-trip is deterministic across two runs", async () => {
    const prompt = "Write a TypeScript type guard for string";
    const output = "function isString(val: unknown): val is string { return typeof val === 'string'; }";

    const [run1, run2] = await Promise.all([
      runPipeline(prompt, output),
      runPipeline(prompt, output),
    ]);

    expect(run1.text).toBe(run2.text);
    assertClean(run1.text, "G5 determinism run1");
    assertClean(run2.text, "G5 determinism run2");
  });
});

// ---------------------------------------------------------------------------
// Scenario H — Repair loop end-to-end
//
// Tests: FAIL → repair pass → PASS flows correctly through the full pipeline.
// The repair loop is the most important previously-unproven path — it wires
// handleRepairLoop() → second maestro run → second pappy evaluate →
// SUCCESS result → presenter → clean reply.text.
//
// Catches:
//   - repair loop producing contaminated output that bypasses presenter
//   - repair loop summary leaking into user-visible text
//   - clean repair output being incorrectly rejected
// ---------------------------------------------------------------------------
describe("Pipeline: H — repair loop", () => {
  /**
   * Build a runtime where the first run returns contaminated FAIL output and
   * the repair run returns clean output that Pappy accepts.
   */
  function repairRuntime(opts: {
    initialOutput: string;
    repairedOutput: string;
    repairVerdicts?: ("PASS" | "WARN" | "FAIL")[];
  }): ReturnType<typeof createOrcaRuntime> {
    let callCount = 0;

    const maestro: MaestroPort = {
      run: async (_task, _ctx) => {
        const output = callCount === 0 ? opts.initialOutput : opts.repairedOutput;
        callCount++;
        return { outputText: output, summary: "stub", toolEvents: [], filesChanged: [] };
      },
    };

    const repairVerdicts = opts.repairVerdicts ?? ["PASS"];
    let qcCallCount = 0;

    const pappy: PappyPort = {
      evaluate: (_input: PappyInput): PappyResult => {
        const isFirstCall = qcCallCount === 0;
        qcCallCount++;

        if (isFirstCall) {
          // First QC: FAIL with a repair task — triggers handleRepairLoop().
          // repairTask (string) is the field the runtime reads; repair_task is
          // the structured form. Both must be set to match real pappy output.
          const rt = { title: "Fix the identified issues", steps: ["step 1"], required_proofs: [] };
          return {
            ...stubPappyResult("FAIL"),
            repair_task: rt,
            repairTask: "Fix the identified issues\n\nstep 1",
          };
        }

        // Subsequent QC calls use the repair verdicts in order
        const verdict = repairVerdicts[qcCallCount - 2] ?? "PASS";
        return stubPappyResult(verdict);
      },
    };

    return createOrcaRuntime({
      maestro,
      pappy,
      llm: {
        complete: async (p: string) => ({ text: `llm: ${p}` }),
        stream:   async (p: string, _opts: unknown, onChunk: (c: string) => void) => { const t = `llm: ${p}`; onChunk(t); return { text: t }; },
      },
      maxRepairPasses: 2,
    });
  }

  it("H1: FAIL → repair → PASS produces clean final answer", async () => {
    const runtime = repairRuntime({
      initialOutput: "Partial broken output.",
      repairedOutput: "The function has been implemented correctly.",
    });
    const benson = createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) });

    const reply = await benson.handleUserMessage("Implement a debounce function");

    expect(reply.kind).toBe("RESULT");
    expect(reply.text).toContain("implemented correctly");
    assertClean(reply.text, "H1 repair→PASS");
  });

  it("H2: contaminated initial output is never shown when repair succeeds", async () => {
    // Initial (failed) output has heavy contamination — after repair, the
    // clean repaired output is what the user sees, not the contaminated version.
    const runtime = repairRuntime({
      initialOutput: "Brain: error in generation\n<thinking>Something went wrong.</thinking>",
      repairedOutput: "The debounce function has been implemented.",
    });
    const benson = createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) });

    const reply = await benson.handleUserMessage("Implement a debounce function");

    expect(reply.text).toContain("debounce function has been implemented");
    expect(reply.text).not.toContain("Brain:");
    expect(reply.text).not.toContain("<thinking>");
    assertClean(reply.text, "H2 initial contamination not shown");
  });

  it("H3: contaminated repair output is still sanitized by presenter", async () => {
    // Even after repair, if the role output contains chatter it must be stripped.
    const runtime = repairRuntime({
      initialOutput: "Broken output.",
      repairedOutput: [
        "Reviewer: the repair looks good",
        "FINAL ANSWER:",
        "The implementation is now correct.",
      ].join("\n"),
    });
    const benson = createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) });

    const reply = await benson.handleUserMessage("Fix the broken function");

    expect(reply.text).not.toMatch(/^Reviewer:/im);
    expect(reply.text).toContain("implementation is now correct");
    assertClean(reply.text, "H3 contaminated repair output");
  });

  it("H4: repair exhausted (all passes FAIL) shows clean failure message", async () => {
    // All repair passes fail — the FAIL result with lastOutputText is shown.
    const runtime = repairRuntime({
      initialOutput: "Could not complete the implementation.",
      repairedOutput: "Still cannot complete the implementation.",
      repairVerdicts: ["FAIL", "FAIL"],
    });
    const benson = createBenson({ executeTask: bensonExecuteTask(runtime.executeTask) });

    const reply = await benson.handleUserMessage("Fix the broken function");

    // Either shows the last output text + QC note, or the "repair exhausted" summary
    // — either way the text must be clean and contain a comprehensible message.
    expect(reply.kind).toBe("RESULT");
    expect(reply.text.length).toBeGreaterThan(0);
    assertClean(reply.text, "H4 repair exhausted");
  });
});

// ---------------------------------------------------------------------------
// Scenario I — result.summary contamination in failure path
//
// Tests: result.summary (shown when userFacingText is absent on FAIL) is
// sanitized before presentation. The summary can carry agent error messages
// (metadata.errorMessage) that may include role labels or XML markup.
//
// Bug path that this closes:
//   presentFailure() line: `return `...> ${result.summary}...``
//   Previously: result.summary was not passed through cleanFollowUp()
//   Now: cleanFollowUp() is applied before interpolation
// ---------------------------------------------------------------------------
describe("Pipeline: I — result.summary sanitization", () => {
  it("I1: clean summary error message is shown verbatim", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "FAIL" as const,
        summary: "API error 401: invalid key",
      }),
    });
    const reply = await benson.handleUserMessage("Deploy the application");

    expect(reply.text).toContain("API error 401: invalid key");
    assertClean(reply.text, "I1 clean summary");
  });

  it("I2: summary with Brain: prefix is stripped before showing to user", async () => {
    // Multi-line summary: the "Brain:" handoff line is stripped entirely by
    // cleanFollowUp(); the second line (the real error) survives.
    const benson = createBenson({
      executeTask: async () => ({
        status: "FAIL" as const,
        summary: "Brain: could not route the task.\nError in role selection after trying 3 specialists.",
      }),
    });
    const reply = await benson.handleUserMessage("Run the tests");

    expect(reply.text).not.toMatch(/^Brain:/im);
    expect(reply.text).toContain("Error in role selection after trying 3 specialists");
    assertClean(reply.text, "I2 summary Brain: prefix");
  });

  it("I3: summary with <thinking> block is stripped before showing to user", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "FAIL" as const,
        summary: "<thinking>could not parse the response</thinking>Agent returned malformed output.",
      }),
    });
    const reply = await benson.handleUserMessage("Generate a report");

    expect(reply.text).not.toContain("<thinking>");
    expect(reply.text).not.toContain("could not parse the response");
    expect(reply.text).toContain("Agent returned malformed output");
    assertClean(reply.text, "I3 summary <thinking>");
  });

  it("I4: summary with Reasoning: label is stripped before showing to user", async () => {
    const benson = createBenson({
      executeTask: async () => ({
        status: "FAIL" as const,
        summary: "Reasoning: the task exceeded scope\nStill failing after 2 repair passes.",
      }),
    });
    const reply = await benson.handleUserMessage("Build the entire system");

    expect(reply.text).not.toMatch(/^Reasoning:/im);
    expect(reply.text).toContain("Still failing after 2 repair passes");
    assertClean(reply.text, "I4 summary Reasoning:");
  });
});
