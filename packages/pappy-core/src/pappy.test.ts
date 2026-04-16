/**
 * Pappy — main evaluator unit tests
 *
 * Covers: verdict derivation, confidence scoring, acceptance criteria,
 * receipt ledger, repair task generation, and the full evaluateWithPappy path.
 */

import { describe, it, expect } from "vitest";
import { evaluateWithPappy } from "./pappy.js";
import type { PappyInput } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A "clean PASS" input: output is non-empty and both toolEvents + filesChanged
 * are provided so the proof/instrumentation checks don't fire.
 */
function passInput(overrides: Partial<PappyInput> = {}): PappyInput {
  return {
    task: "Explain what recursion means.",
    outputText: "Recursion is a function calling itself. This is a detailed explanation of how recursion works in programming.",
    // Provide a minimal trace so PROOF_NO_TRACE / TOOL_INSTRUMENTATION_MISSING
    // don't fire and convert an otherwise clean run to WARN.
    toolEvents: [{ tool: "read_file", ok: true, summary: "context read" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PASS / WARN / FAIL verdicts
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — verdict", () => {
  it("returns PASS for clean output with no issues", () => {
    const result = evaluateWithPappy(passInput());
    expect(result.verdict).toBe("PASS");
    // Confirm no issues slipped in
    expect(result.issues).toHaveLength(0);
  });

  it("returns FAIL when a safety CRITICAL issue fires", () => {
    const result = evaluateWithPappy(
      passInput({ outputText: "Run rm -rf /home to clean up." }),
    );
    expect(result.verdict).toBe("FAIL");
  });

  it("returns FAIL when a required file is missing", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    expect(result.verdict).toBe("FAIL");
  });

  it("returns PASS when required file is present in filesChanged", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Created README.md with project overview and setup instructions.",
      constraints: { requireFiles: ["README.md"] },
      filesChanged: [{ path: "README.md", changeType: "A", diff: "# Orca\n..." }],
      toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok" }],
    });
    expect(result.verdict).toBe("PASS");
  });

  it("returns FAIL when forbidDeletes constraint is violated", () => {
    const result = evaluateWithPappy({
      task: "Refactor the module.",
      outputText: "Deleted legacy file.",
      filesChanged: [{ path: "legacy.ts", changeType: "D" }],
      constraints: { forbidDeletes: true },
    });
    expect(result.verdict).toBe("FAIL");
  });

  it("returns WARN when only MEDIUM issues exist", () => {
    // Missing required section → MEDIUM
    const result = evaluateWithPappy({
      task: "Write a plan.",
      outputText: "Here is the plan.",
      constraints: { requireSections: ["Implementation"] },
    });
    expect(result.verdict).toBe("WARN");
  });

  it("returns WARN (not FAIL) when TOOL_INSTRUMENTATION_MISSING is present", () => {
    const result = evaluateWithPappy({
      task: "Read the config file and update it.",
      outputText: "Updated the configuration.",
    });

    expect(result.issues.some((issue) => issue.code === "TOOL_INSTRUMENTATION_MISSING")).toBe(true);
    // TOOL_INSTRUMENTATION_MISSING is a MEDIUM heuristic with known false positives —
    // it intentionally produces WARN, not a hard FAIL.
    expect(result.verdict).toBe("WARN");
  });

  it("returns FAIL when AGENT_LOOP_DETECTED is present", () => {
    const result = evaluateWithPappy({
      task: "Summarize the file.",
      outputText: "Partial answer.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read ok" }],
      metadata: {
        stoppedBecause: "loop_detected",
        loopEvidence: { repeatedCall: "read_file:{\"path\":\"hello_world.py\"}", occurrences: 3 },
      },
    } as PappyInput & { metadata: { stoppedBecause: string; loopEvidence: { repeatedCall: string; occurrences: number } } });

    expect(result.issues.some((issue) => issue.code === "AGENT_LOOP_DETECTED")).toBe(true);
    expect(result.verdict).toBe("FAIL");
  });

  it("returns WARN when multiple MEDIUM issues exist without hard-fail codes", () => {
    const result = evaluateWithPappy({
      task: "Explain recursion.",
      outputText: "Recursion is when a function calls itself.",
      constraints: { requireSections: ["Examples"] },
      toolEvents: [{ tool: "read_file", ok: true, summary: "context read" }],
    });

    expect(result.issues.filter((issue) => issue.severity === "MEDIUM").length).toBeGreaterThanOrEqual(2);
    expect(result.issues.some((issue) => issue.code === "TOOL_INSTRUMENTATION_MISSING")).toBe(false);
    expect(result.issues.some((issue) => issue.code === "AGENT_LOOP_DETECTED")).toBe(false);
    expect(result.verdict).toBe("WARN");
  });
});

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — confidence", () => {
  it("returns confidence 1.0 for clean PASS", () => {
    const result = evaluateWithPappy(passInput());
    expect(result.confidence).toBe(1.0);
  });

  it("returns confidence < 1 when issues exist", () => {
    const result = evaluateWithPappy({
      task: "Write tests.",
      outputText: "Done.",
      constraints: { requireSections: ["Tests"] },
    });
    expect(result.confidence).toBeLessThan(1.0);
  });

  it("returns confidence 0 or very low when many CRITICAL issues fire", () => {
    const result = evaluateWithPappy({
      task: "Delete all files.",
      outputText: "rm -rf / is great. Also rm -rf /home. Also mkfs.ext4 /dev/sda.",
      constraints: { forbidDeletes: true },
      filesChanged: [
        { path: "a.ts", changeType: "D" },
        { path: "b.ts", changeType: "D" },
      ],
    });
    expect(result.confidence).toBeLessThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria derivation
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — acceptance criteria", () => {
  it("derives criteria from goals", () => {
    const result = evaluateWithPappy({
      task: "Implement login.",
      outputText: "Login implemented.",
      goals: ["User can log in", "Error messages are shown"],
    });
    expect(result.acceptance_criteria).toHaveLength(2);
    expect(result.acceptance_criteria[0].text).toContain("log in");
  });

  it("derives criteria from required files", () => {
    const result = evaluateWithPappy({
      task: "Create auth.ts",
      outputText: "Done.",
      constraints: { requireFiles: ["auth.ts"] },
      filesChanged: [{ path: "auth.ts", changeType: "A", diff: "export {};" }],
    });
    const fileCriterion = result.acceptance_criteria.find((c) =>
      c.text.includes("auth.ts"),
    );
    expect(fileCriterion).toBeDefined();
  });

  it("falls back to a generic criterion when no goals/constraints", () => {
    const result = evaluateWithPappy(passInput());
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0].id).toBe("AC1");
  });
});

// ---------------------------------------------------------------------------
// Receipt ledger
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — receipt ledger", () => {
  it("marks criterion PROVED when output is non-empty", () => {
    const result = evaluateWithPappy(passInput());
    const entry = result.receipt_ledger.find((e) => e.ref === "AC1");
    expect(entry?.status).toBe("PROVED");
  });

  it("marks criterion MISSING when output is empty", () => {
    const result = evaluateWithPappy({
      task: "Do something.",
      outputText: "",
    });
    const entry = result.receipt_ledger.find((e) => e.ref === "AC1");
    expect(entry?.status).toBe("MISSING");
  });

  it("marks required-file criterion PROVED when file appears in filesChanged", () => {
    const result = evaluateWithPappy({
      task: "Create index.ts",
      outputText: "Done.",
      constraints: { requireFiles: ["index.ts"] },
      filesChanged: [{ path: "index.ts", changeType: "A", diff: "export {};" }],
    });
    // The criteria ledger uses type "criterion_specific"; find by ref or details
    const entry = result.receipt_ledger.find(
      (e) => e.ref === "AC1" || e.required_receipt.details?.includes("index.ts"),
    );
    expect(entry?.status).toBe("PROVED");
  });

  it("does not misread 'test script exists' as a unit-test requirement", () => {
    const result = evaluateWithPappy({
      task: "Read package.json and answer with 3 bullets.",
      goals: [
        "Read the repository root package.json and answer with exactly 3 bullets: the project name, whether a top-level test script exists, and how many workspaces are declared.",
      ],
      outputText: [
        "- Project name: orca",
        "- Top-level test script exists: Yes",
        "- Number of workspaces declared: 2",
      ].join("\n"),
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read_file: ok (536 chars)" },
      ],
    });

    expect(result.receipt_ledger.find((e) => e.ref === "AC1")?.status).toBe("PROVED");
    expect(result.issues.some((issue) => issue.code === "CORE_GOAL_MISSING")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repair task
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — repair task", () => {
  it("is null on PASS", () => {
    const result = evaluateWithPappy(passInput());
    expect(result.repair_task).toBeNull();
    expect(result.repairTask).toBeUndefined();
  });

  it("is populated on FAIL", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    expect(result.repair_task).not.toBeNull();
    expect(result.repair_task?.title).toBeTruthy();
    expect(result.repair_task?.steps.length).toBeGreaterThan(0);
  });

  it("repairTask string is a backward-compat alias for the structured form", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    expect(result.repairTask).toBeDefined();
    expect(typeof result.repairTask).toBe("string");
    expect(result.repairTask).toContain(result.repair_task!.title);
  });

  it("includes specific issue codes in repair steps", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    const stepsText = result.repair_task!.steps.join(" ");
    expect(stepsText).toContain("COMPLETENESS_MISSING_FILE");
  });
});

// ---------------------------------------------------------------------------
// Issue ID stability
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — issue ID stability", () => {
  it("produces the same issueId for the same defect across evaluations", () => {
    const input: PappyInput = {
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    };
    const r1 = evaluateWithPappy(input);
    const r2 = evaluateWithPappy(input);

    const ids1 = r1.issues.map((i) => i.issueId).sort();
    const ids2 = r2.issues.map((i) => i.issueId).sort();
    expect(ids1).toEqual(ids2);
  });

  it("produces different issueIds for different defect types", () => {
    // Use defects from different check modules so they have different codes.
    const result = evaluateWithPappy({
      task: "Update the login form and run tests.",
      outputText: "rm -rf /tmp/old was run.",        // safety: dangerous command
      constraints: {
        requireFiles: ["auth.ts"],                  // completeness: missing file
        requireSections: ["Implementation"],        // structure: missing section
      },
    });
    const ids = result.issues.map((i) => i.issueId);
    const unique = new Set(ids);
    // All defects should have distinct stable IDs
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// internalSummary
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — internalSummary", () => {
  it("includes verdict=PASS with no issues", () => {
    const result = evaluateWithPappy(passInput());
    expect(result.internalSummary).toContain("verdict=PASS");
  });

  it("includes severity tallies on FAIL", () => {
    const result = evaluateWithPappy({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    expect(result.internalSummary).toMatch(/\d+x(HIGH|CRITICAL)/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — edge cases", () => {
  it("handles completely empty input gracefully", () => {
    const result = evaluateWithPappy({ task: "Do something." });
    expect(result.verdict).toBeDefined();
    expect(result.issues).toBeDefined();
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("handles very long outputText without throwing", () => {
    const longOutput = "This is a detailed explanation. ".repeat(5000);
    const result = evaluateWithPappy({
      task: "Explain things.",
      outputText: longOutput,
      toolEvents: [{ tool: "read_file", ok: true, summary: "context" }],
    });
    expect(result.verdict).toBe("PASS");
  });

  it("does not crash on undefined optional fields", () => {
    expect(() =>
      evaluateWithPappy({ task: "Test" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Deployment / status routing reliability fixes
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — deployment-status scenario reliability", () => {
  it("FAILS when tools fired but no final output was produced (no_final_output)", () => {
    const result = evaluateWithPappy({
      task: "Show me the current deployment status",
      outputText: "",   // empty — agent never answered
      goals: ["Output describes the current deployment state"],
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read package.json" },
        { tool: "list_directory", ok: true, summary: "listed dist/" },
      ],
      // Simulate stoppedBecause=no_final_output from ReactAgentAdapter
      metadata: { stoppedBecause: "no_final_output" },
    } as any);

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "COMPLETENESS_NO_FINAL_OUTPUT")).toBe(true);
  });

  it("FAILS when all acceptance criteria are MISSING (CORE_GOAL_MISSING)", () => {
    const result = evaluateWithPappy({
      task: "Show me the current deployment status",
      outputText: "",
      goals: ["Output describes the current deployment state"],
      toolEvents: [{ tool: "read_file", ok: true, summary: "read file" }],
    });

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "CORE_GOAL_MISSING")).toBe(true);
  });

  it("FAILS when parse_failure_loop is set in metadata", () => {
    const result = evaluateWithPappy({
      task: "Show me the current deployment status",
      outputText: "Partial answer.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read ok" }],
      metadata: {
        stoppedBecause: "parse_failure_loop",
        loopEvidence: { repeatedCall: "malformed <tool_call> block", occurrences: 3 },
      },
    } as any);

    expect(result.issues.some(i => i.code === "AGENT_LOOP_DETECTED")).toBe(true);
    // parse_failure_loop raises HIGH → FAIL
    expect(result.verdict).toBe("FAIL");
  });

  it("tool activity alone does NOT prove a specific goal AC", () => {
    // Tools ran but output is empty — the fallback AC proof must NOT accept hasTools
    const result = evaluateWithPappy({
      task: "Show me the current deployment status",
      outputText: "",
      goals: ["Output describes the current deployment state"],
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read file" },
        { tool: "list_directory", ok: true, summary: "listed dir" },
      ],
    });

    // The AC for the goal should be MISSING, not PROVED
    const ac1 = result.receipt_ledger.find(e => e.ref === "AC1");
    expect(ac1?.status).toBe("MISSING");
  });

  it("PASSES a deployment-status run that actually returned content", () => {
    const result = evaluateWithPappy({
      task: "Show me the current deployment status",
      outputText: "Current deployment: v1.3.2 is running in production. Build pipeline is green. Staging environment is running v1.4.0-beta.",
      goals: ["Output describes the current deployment state"],
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read release info" },
      ],
    });

    expect(result.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// COMPLETENESS_NO_FINAL_OUTPUT
// ---------------------------------------------------------------------------

describe("evaluateWithPappy — COMPLETENESS_NO_FINAL_OUTPUT", () => {
  it("fires when tools ran but output is empty and stoppedBecause=no_final_output", () => {
    const result = evaluateWithPappy({
      task: "Read the config and tell me what it says",
      outputText: "",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read config.json" }],
      metadata: { stoppedBecause: "no_final_output" },
    } as any);

    expect(result.issues.some(i => i.code === "COMPLETENESS_NO_FINAL_OUTPUT")).toBe(true);
    expect(result.verdict).toBe("FAIL");
  });

  it("does NOT fire when output is present even with tools", () => {
    const result = evaluateWithPappy({
      task: "Read the config and tell me what it says",
      outputText: "The config has apiKey and baseUrl fields.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read config.json" }],
    });

    expect(result.issues.some(i => i.code === "COMPLETENESS_NO_FINAL_OUTPUT")).toBe(false);
  });

  it("fails non-empty decomposed fallback output that still contains no_final_output placeholders", () => {
    const result = evaluateWithPappy({
      task: "Do a full audit of this app and tell me what level of ship readiness it is at",
      outputText: [
        "## reviewer",
        "[reviewer stopped: no_final_output]",
        "",
        "## debugger",
        "[debugger stopped: no_final_output]",
        "",
        "## narrator",
        "The search is still in progress. Once complete, I will synthesize the report.",
      ].join("\n"),
      goals: ["Output states a clear ship-readiness level"],
      toolEvents: [{ tool: "read_file", ok: true, summary: "read package.json" }],
      metadata: { stoppedBecause: "done" },
    } as any);

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "COMPLETENESS_NO_FINAL_OUTPUT")).toBe(true);
  });

  it("fails when AHP child packets are incomplete even if fallback output is non-empty", () => {
    const result = evaluateWithPappy({
      task: "Do a full audit of this app and tell me what level of ship readiness it is at",
      outputText: "Partial fallback output.",
      goals: ["Output states a clear ship-readiness level"],
      toolEvents: [{ tool: "read_file", ok: true, summary: "read package.json" }],
      metadata: {
        stoppedBecause: "done",
        ahpNonCompleteChildren: [
          { id: "run_1_reviewer_0", role: "reviewer", lifecycle: "INCONCLUSIVE", verdict: "INCONCLUSIVE" },
        ],
      },
    } as any);

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "AHP_CHILD_INCONCLUSIVE")).toBe(true);
  });

  it("fails read-only inspections that write files", () => {
    const result = evaluateWithPappy({
      task: [
        "Inspect this project and tell me whether it is ready for a local test release.",
        "Only check apps/desktop/package.json and .github/workflows/release.yml.",
        "Return readiness level, evidence, blockers, and next action.",
      ].join(" "),
      outputText: "Readiness level: YELLOW",
      goals: ["Output states readiness level"],
      toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "release-readiness-report.md" } }],
      filesChanged: [{ path: "release-readiness-report.md", changeType: "A", diff: "Readiness level: YELLOW" }],
      metadata: { stoppedBecause: "done" },
    } as any);

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "UNREQUESTED_FILE_CHANGE")).toBe(true);
  });

  it("fails audit outputs when structured preflight failures are present", () => {
    const result = evaluateWithPappy({
      task: "Check this app for production readiness C:\\missing",
      outputText: "Readiness: insufficient evidence\nStructured failures:\n- missing_path",
      goals: ["Output states readiness level"],
      metadata: {
        stoppedBecause: "done",
        audit: {
          failures: [
            { category: "missing_path", retryable: false, summary: "Path does not exist", suggestedNextAction: "Fix path" },
          ],
        },
      },
    } as any);

    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some(i => i.code === "AUDIT_PREFLIGHT_FAILED")).toBe(true);
  });
});
