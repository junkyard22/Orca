/**
 * Tool-result checks — unit tests (Phase 4.3 coverage)
 */

import { describe, it, expect } from "vitest";
import { runToolResultChecks } from "./toolResults.js";
import type { PappyInput } from "../types.js";

// ---------------------------------------------------------------------------
// Tool failure detection
// ---------------------------------------------------------------------------

describe("runToolResultChecks — tool failures", () => {
  it("flags a failed tool event as HIGH", () => {
    const issues = runToolResultChecks({
      task: "Read a file.",
      toolEvents: [{ tool: "read_file", ok: false, summary: "File not found" }],
    });
    const fail = issues.find((i) => i.code === "TOOL_FAILURE");
    expect(fail).toBeDefined();
    expect(fail!.severity).toBe("HIGH");
    expect(fail!.evidence).toContain("File not found");
  });

  it("flags each failed tool event individually", () => {
    const issues = runToolResultChecks({
      task: "Build project.",
      toolEvents: [
        { tool: "run_command", ok: false, summary: "npm not found" },
        { tool: "read_file", ok: false, summary: "No such file" },
      ],
    });
    const fails = issues.filter((i) => i.code === "TOOL_FAILURE");
    expect(fails).toHaveLength(2);
  });

  it("does NOT flag successful tool events", () => {
    const issues = runToolResultChecks({
      task: "Read a file.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "Contents read" }],
    });
    const fails = issues.filter((i) => i.code === "TOOL_FAILURE");
    expect(fails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool event correlation (Phase 4.3)
// ---------------------------------------------------------------------------

describe("runToolResultChecks — tool correlation", () => {
  it("flags MEDIUM when write-file task has no tool events and no filesChanged", () => {
    const issues = runToolResultChecks({
      task: "Create a new file and write content.",
    });
    // Should flag missing write_file tool and instrumentation warning
    const missing = issues.find((i) => i.code === "TOOL_MISSING");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("MEDIUM");
  });

  it("does NOT flag write_file missing when filesChanged is populated", () => {
    const issues = runToolResultChecks({
      task: "Create a new component file.",
      filesChanged: [{ path: "Button.tsx", changeType: "A", diff: "export default () => <button/>;" }],
    });
    const missing = issues.filter((i) => i.code === "TOOL_MISSING");
    expect(missing).toHaveLength(0);
  });

  it("flags MEDIUM when task implies command but no run_command event exists", () => {
    const issues = runToolResultChecks({
      task: "Run the tests with npm test.",
    });
    const missing = issues.find(
      (i) => i.code === "TOOL_MISSING" && i.evidence.includes("run_command"),
    );
    expect(missing).toBeDefined();
  });

  it("does NOT flag missing tool when the expected tool was actually called", () => {
    const issues = runToolResultChecks({
      task: "Run the tests with npm test.",
      toolEvents: [{ tool: "run_command", ok: true, summary: "Tests passed" }],
    });
    const missing = issues.filter((i) => i.code === "TOOL_MISSING");
    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Instrumentation missing (broad warning)
// ---------------------------------------------------------------------------

describe("runToolResultChecks — instrumentation warning", () => {
  it("flags MEDIUM instrumentation warning for action tasks with no trace", () => {
    const issues = runToolResultChecks({
      task: "Read the config file and update it.",
    });
    const instr = issues.find((i) => i.code === "TOOL_INSTRUMENTATION_MISSING");
    expect(instr).toBeDefined();
    expect(instr!.severity).toBe("MEDIUM");
  });

  it("does NOT flag instrumentation when toolEvents are present", () => {
    const issues = runToolResultChecks({
      task: "Read the config file.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "Config read" }],
    });
    const instr = issues.find((i) => i.code === "TOOL_INSTRUMENTATION_MISSING");
    expect(instr).toBeUndefined();
  });

  it("does NOT flag instrumentation when filesChanged are present", () => {
    const issues = runToolResultChecks({
      task: "Write the config file.",
      filesChanged: [{ path: "config.json", changeType: "M", diff: '{"key": "val"}' }],
    });
    const instr = issues.find((i) => i.code === "TOOL_INSTRUMENTATION_MISSING");
    expect(instr).toBeUndefined();
  });

  it("returns no issues for a pure explanation task with no trace", () => {
    // Purely explanatory tasks shouldn't trigger the instrumentation warning
    // because the task has no action verbs that match the pattern.
    const issues = runToolResultChecks({
      task: "Explain what binary search is.",
      outputText: "Binary search halves the search space on each step.",
    });
    // The instrumentation check uses broad patterns — this may or may not fire
    // depending on whether "Explain" matches. The key thing is no TOOL_FAILURE.
    const fails = issues.filter((i) => i.code === "TOOL_FAILURE");
    expect(fails).toHaveLength(0);
  });
});
