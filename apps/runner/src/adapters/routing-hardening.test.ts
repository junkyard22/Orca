/**
 * routing-hardening.test.ts
 *
 * Targeted validation suite for the pipeline hardening patch.
 *
 * Covers:
 *   Scenario 1 — Simple direct-answer routing (no decomposition, narrator/brain)
 *   Scenario 2 — Single file-write routing (strong_model, no decomposition)
 *   Scenario 3 — Multi-file coordinated task decomposition behavior
 *   Scenario 5 — Dewey advisory propagation (advisory notes reach agent prompt)
 */

import { describe, it, expect } from "vitest";
import { pickCoreRole } from "maestro-core";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import {
  shouldAttemptSubagentDecomposition,
  buildTaskPrompt,
  mapDepartmentsToSubtasks,
} from "./maestroAdapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(message: string, extra: Partial<OrcaTaskSpec> = {}): OrcaTaskSpec {
  return {
    originalUserMessage: message,
    intent: "task",
    goals: [message.slice(0, 80)],
    ...extra,
  };
}

function makeWritableCtx(depth = 0) {
  return {
    subagentDepth: depth,
  };
}

function makeWritableMaestroClassification(multiStep: boolean) {
  return { classification: { multiStep } };
}

// ---------------------------------------------------------------------------
// Scenario 1:  Simple direct-answer request
// "Explain in 3 short paragraphs what dependency injection is in TypeScript,
//  with one tiny code example."
// ---------------------------------------------------------------------------

describe("Scenario 1: Simple direct-answer request", () => {
  const SIMPLE_EXPLAIN =
    "Explain in 3 short paragraphs what dependency injection is in TypeScript, with one tiny code example.";

  it("1.1 pickCoreRole routes explain request to narrator (not brain or strong_model)", () => {
    const role = pickCoreRole(SIMPLE_EXPLAIN);
    // "Explain" matches the narrator pattern /\b(describe|explain|summarize)\b/i
    expect(role).toBe("narrator");
  });

  it("1.2 shouldAttemptSubagentDecomposition returns false for simple explain (non-multiStep)", () => {
    const task = makeTask(SIMPLE_EXPLAIN);
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(false) as any,
      makeWritableCtx(),
    );
    expect(result).toBe(false);
  });

  it("1.3 shouldAttemptSubagentDecomposition returns false even when classification.multiStep=true", () => {
    // Even if the orchestrator sees a multi-step signal, shouldDecompose()
    // must gate against low-keyword-count explain requests.
    const task = makeTask(SIMPLE_EXPLAIN);
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(),
    );
    // shouldDecompose threshold: <3 deliverable keywords → false.
    // "explain", "paragraphs", "dependency injection", "TypeScript", "code example"
    // do NOT match: files?, functions?, each|every|all, first|second|and
    expect(result).toBe(false);
  });

  it("1.4 shouldAttemptSubagentDecomposition returns false inside a subagent (depth=1)", () => {
    const task = makeTask(SIMPLE_EXPLAIN, {
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    });
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(1), // depth=1 → subagent → never decomposes
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2:  Single file-write task
// "Create a file called hello.ts that exports a function named greet
//  returning the string 'hello world'."
// ---------------------------------------------------------------------------

describe("Scenario 2: Single file-write task", () => {
  const SINGLE_FILE =
    "Create a file called hello.ts that exports a function named greet returning the string 'hello world'.";

  it("2.1 pickCoreRole routes single file-write to strong_model", () => {
    // Matches: /\b(write|create|add|implement)\b.{0,30}\b(function|method|...)\b/i
    // "Create" + ... + "function" within 30 chars: "Create a file called hello.ts that exports a function"
    // chars between Create and function: " a file called hello.ts that exports a " = 38 chars
    // Actually the pattern allows .{0,30} — let's check if this fires via a different path.
    // Pattern also: /\bfunction\s+that\b/ — no. /\b(write|generate)\b.{0,30}\b(code|script|program)\b/ — no.
    // "Create" -> with "function" >30 chars away, pattern 6 won't fire.
    // But narrator pattern: /\b(give me|tell me|what is|how do I|can you)\b/ — no.
    // None of brain, narrator, reviewer, cheap_model patterns fire first.
    // Falls to strong_model as fallback (default for unclassified coding tasks).
    const role = pickCoreRole(SINGLE_FILE);
    expect(role).toBe("strong_model");
  });

  it("2.2 shouldAttemptSubagentDecomposition returns false for single file-write", () => {
    const task = makeTask(SINGLE_FILE, {
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    });
    // Even with multiStep=true, shouldDecompose checks keyword count.
    // "file" (1), "function" (1) — only 2 deliverable keywords < 3 threshold.
    // File pattern: only "hello.ts" → 1 match, not >2.
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(),
    );
    expect(result).toBe(false);
  });

  it("2.3 shouldAttemptSubagentDecomposition returns false for read-only variant", () => {
    const task = makeTask(SINGLE_FILE, {
      permissions: { fileRead: true, fileWrite: false, shellExec: false },
    });
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(),
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3:  Multi-file coordinated task
// "Create two files:
//   1. math.ts exporting add(a, b)
//   2. math.test.ts with one basic test for add"
// ---------------------------------------------------------------------------

describe("Scenario 3: Multi-file coordinated task", () => {
  const TWO_FILE =
    "Create two files:\n1. math.ts exporting add(a, b)\n2. math.test.ts with one basic test for add";

  it("3.1 pickCoreRole routes two-file task to strong_model", () => {
    // The "test ... add" match via /\b(test|unit_test|integration_test)\b.*\b(write|create|add)\b/
    // fires because "test" appears before "add" in "one basic test for add".
    const role = pickCoreRole(TWO_FILE);
    expect(role).toBe("strong_model");
  });

  it("3.2 shouldAttemptSubagentDecomposition returns false for two-file task (below threshold)", () => {
    // Checks whether the two-file prompt triggers decomposition.
    // Expected: NO — "Create two files: 1. math.ts... 2. math.test.ts..."
    // Keyword analysis:
    //   files? → "files" (1 match)
    //   each|every|all|multiple|several → no match
    //   first|second|third|then|also|and → no match
    //   Total = 1 < 3 → shouldDecompose returns false
    //   File pattern: math.ts, math.test.ts → 2 matches (not >2)
    // Therefore: decomposition does NOT fire for this two-file prompt.
    const task = makeTask(TWO_FILE, {
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    });
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(),
    );
    expect(result).toBe(false);
  });

  it("3.3 three-file task with explicit file names triggers decomposition gate (keyword threshold)", () => {
    // This tests the boundary of shouldDecompose for a task that SHOULD decompose.
    // With 3 distinct file mentions and explicit keywords, threshold is crossed.
    const THREE_FILE =
      "Create three files: math.ts, math.test.ts, and index.ts that re-exports add and also exports multiply.";
    const task = makeTask(THREE_FILE, {
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    });
    const result = shouldAttemptSubagentDecomposition(
      task,
      makeWritableMaestroClassification(true) as any,
      makeWritableCtx(),
    );
    // "files" (1), "and" (1), "also" (1) = 3 deliverable keywords → threshold met
    // File pattern: math.ts, math.test.ts, index.ts → 3 matches (>2) → true
    expect(result).toBe(true);
  });

  it("3.4 mapDepartmentsToSubtasks: siblings are populated from co-departments (gap fixed)", () => {
    // Previously: Brain's DepartmentTask had no coordination fields and the
    // decomposeTask() mapper dropped context entirely. After the patch:
    // mapDepartmentsToSubtasks() populates siblings for every department.
    const departments = [
      { head: "strong_model", subtask: "Create math.ts exporting add(a, b)", context: undefined },
      { head: "strong_model", subtask: "Create math.test.ts with tests for add", context: undefined },
    ];
    const subtasks = mapDepartmentsToSubtasks(departments);

    expect(subtasks).toHaveLength(2);

    // First subtask must know about the second.
    expect(subtasks[0]!.siblings).toBeDefined();
    expect(subtasks[0]!.siblings).toHaveLength(1);
    expect(subtasks[0]!.siblings![0]).toContain("math.test.ts");

    // Second subtask must know about the first.
    expect(subtasks[1]!.siblings).toBeDefined();
    expect(subtasks[1]!.siblings).toHaveLength(1);
    expect(subtasks[1]!.siblings![0]).toContain("math.ts");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7:  mapDepartmentsToSubtasks — sibling coordination population
// Verifies that the Brain routing → subtask mapping now carries meaningful
// coordination context for all parallel agents.
// ---------------------------------------------------------------------------

describe("Scenario 7: mapDepartmentsToSubtasks sibling coordination", () => {
  it("7.1 two departments: each receives the other as a sibling", () => {
    const depts = [
      { head: "strong_model", subtask: "Create src/api.ts with POST /items handler" },
      { head: "narrator",     subtask: "Write README.md documenting the /items API" },
    ];
    const subtasks = mapDepartmentsToSubtasks(depts);
    expect(subtasks[0]!.siblings).toHaveLength(1);
    expect(subtasks[0]!.siblings![0]).toContain("narrator");
    expect(subtasks[0]!.siblings![0]).toContain("README.md");
    expect(subtasks[1]!.siblings).toHaveLength(1);
    expect(subtasks[1]!.siblings![0]).toContain("strong_model");
    expect(subtasks[1]!.siblings![0]).toContain("src/api.ts");
  });

  it("7.2 three departments: each receives two siblings", () => {
    const depts = [
      { head: "strong_model",  subtask: "Create math.ts" },
      { head: "strong_model",  subtask: "Create math.test.ts" },
      { head: "narrator",      subtask: "Write MATH.md" },
    ];
    const subtasks = mapDepartmentsToSubtasks(depts);
    expect(subtasks[0]!.siblings).toHaveLength(2);
    expect(subtasks[1]!.siblings).toHaveLength(2);
    expect(subtasks[2]!.siblings).toHaveLength(2);
  });

  it("7.3 coordinationHint is carried from Brain department context field", () => {
    const depts = [
      { head: "strong_model", subtask: "Create utils.ts", context: "Must export helpers for the test file" },
      { head: "strong_model", subtask: "Create utils.test.ts", context: "Import helpers from ./utils" },
    ];
    const subtasks = mapDepartmentsToSubtasks(depts);
    expect(subtasks[0]!.coordinationHint).toBe("Must export helpers for the test file");
    expect(subtasks[1]!.coordinationHint).toBe("Import helpers from ./utils");
  });

  it("7.4 absent context field leaves coordinationHint undefined", () => {
    const depts = [
      { head: "strong_model", subtask: "Create foo.ts" },
      { head: "strong_model", subtask: "Create bar.ts" },
    ];
    const subtasks = mapDepartmentsToSubtasks(depts);
    expect(subtasks[0]!.coordinationHint).toBeUndefined();
    expect(subtasks[1]!.coordinationHint).toBeUndefined();
  });

  it("7.5 single department: sibling list is empty (no self-reference)", () => {
    const depts = [{ head: "strong_model", subtask: "Create solo.ts" }];
    const subtasks = mapDepartmentsToSubtasks(depts);
    expect(subtasks[0]!.siblings).toHaveLength(0);
  });

  it("7.6 coordination section appears in subagent prompt when context.coordination is set", () => {
    // Simulate what runSubagentPool injects for a Brain-routed subagent.
    const task = makeTask("Create two files: api.ts and README.md", {
      context: {
        forcedRole: "strong_model",
        coordination: {
          siblings: ["narrator: Create README.md documenting the /items API"],
          message: "You are one of 2 parallel agents. Other agents are handling: narrator: Create README.md.",
        },
      },
    });
    const workspaceCtx = { cwd: "/project" };
    const prompt = buildTaskPrompt(
      task,
      "strong_model",
      false,
      workspaceCtx,
      undefined,
      true, // isSubagent = true
    );
    expect(prompt).toContain("### Coordination Context");
    expect(prompt).toContain("narrator: Create README.md");
    expect(prompt).toContain("2 parallel agents");
  });
});

// Verifies advisory notes are assembled in the prompt via buildTaskPrompt.
// ---------------------------------------------------------------------------

describe("Scenario 5: Dewey advisory propagation into agent prompt", () => {
  it("5.1 advisory notes appear under ### User Context Notes in the task prompt", () => {
    const task = makeTask("Schedule a meeting for tomorrow at 9am.");
    const prompt = buildTaskPrompt(
      task,
      "brain",
      false,
      undefined,
      undefined,
      false,
      ["Connect Gmail in Orca settings to enable this", "Review timing against your scheduling preference"],
    );
    expect(prompt).toContain("### User Context Notes");
    expect(prompt).toContain("Connect Gmail in Orca settings to enable this");
    expect(prompt).toContain("Review timing against your scheduling preference");
  });

  it("5.2 no advisory notes → ### User Context Notes section is absent from prompt", () => {
    const task = makeTask("Explain what async/await does in TypeScript.");
    const prompt = buildTaskPrompt(
      task,
      "narrator",
      false,
      undefined,
      undefined,
      false,
      undefined, // no advisory
    );
    expect(prompt).not.toContain("### User Context Notes");
  });

  it("5.3 empty advisory array → section absent from prompt", () => {
    const task = makeTask("Create a simple TypeScript function.");
    const prompt = buildTaskPrompt(
      task,
      "strong_model",
      false,
      undefined,
      undefined,
      false,
      [], // empty array
    );
    expect(prompt).not.toContain("### User Context Notes");
  });

  it("5.4 advisory notes are advisory, not injected as goals", () => {
    // Core invariant: advisory notes must appear in a SEPARATE section,
    // NOT merged into the ### Goals section. This prevents plan mutation.
    const advisoryNotes = ["Prefer brief responses.", "Avoid emoji in output."];
    const task = makeTask("Write a short poem.", { goals: ["Write a short poem"] });
    const prompt = buildTaskPrompt(
      task,
      "narrator",
      false,
      undefined,
      undefined,
      false,
      advisoryNotes,
    );
    // Verify advisory appears in its own section
    expect(prompt).toContain("### User Context Notes");
    // Verify goals section does not contain advisory text
    const goalsSection = prompt.split("###").find((s) => s.startsWith(" Goals"));
    expect(goalsSection).toBeDefined();
    if (goalsSection) {
      expect(goalsSection).not.toContain("Prefer brief responses");
      expect(goalsSection).not.toContain("Avoid emoji");
    }
  });

  it("5.5 multiple advisory notes all appear in prompt", () => {
    const task = makeTask("Check the build status.");
    const advisory = [
      "Connect Gmail in Orca settings.",
      "Review timing of steps.",
      "Prefer brief responses.",
    ];
    const prompt = buildTaskPrompt(
      task,
      "brain",
      false,
      undefined,
      undefined,
      false,
      advisory,
    );
    for (const note of advisory) {
      expect(prompt).toContain(note);
    }
  });

  it("5.6 advisory propagation: Dewey concerns do not become hard blocks in prompt", () => {
    // Advisory notes must be in a non-critical section (User Context Notes),
    // NOT in the Execution Limits section which the agent treats as restrictions.
    const task = makeTask("Schedule a meeting.", {
      permissions: { fileRead: true, fileWrite: true, shellExec: false },
    });
    const prompt = buildTaskPrompt(
      task,
      "brain",
      false,
      undefined,
      undefined,
      false,
      ["Review timing against preference: 'no meetings before 9am'"],
    );
    // Advisory must be in User Context Notes (non-blocking)
    expect(prompt).toContain("### User Context Notes");
    // Advisory text must NOT appear in Execution Limits (blocking)
    const limitsIdx = prompt.indexOf("### Execution Limits");
    const notesIdx = prompt.indexOf("### User Context Notes");
    if (limitsIdx !== -1 && notesIdx !== -1) {
      // If both sections exist, User Context Notes comes after Execution Limits
      // in the file's layout. The advisory note should only be in Notes, not Limits.
      const limitsSection = prompt.slice(limitsIdx, notesIdx);
      expect(limitsSection).not.toContain("Review timing against preference");
    }
  });
});
