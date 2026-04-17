/**
 * Task type classifier — unit tests
 *
 * Covers: classifyTaskType, deriveDefaultACs, mergeAcceptanceCriteria.
 * Uses lightweight AHPPacket stubs — only the `objective` field is inspected
 * by the classifier so the rest can be minimal.
 */

import { describe, it, expect } from "vitest";
import { AHPLifecycle } from "@clawde/miranda-core";
import type { AHPPacket } from "@clawde/miranda-core";
import {
  TaskType,
  classifyTaskType,
  deriveDefaultACs,
  mergeAcceptanceCriteria,
  getACPriority,
} from "./taskClassifier.js";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makePacket(objective: string): AHPPacket {
  return {
    id:        "test-id",
    objective,
    lifecycle: AHPLifecycle.RUNNING,
    inputs:    [],
    constraints: [],
    expectedOutput: { schema: {}, acceptanceCriteria: [] },
    trace: [],
    meta:  {
      ackRequired: false,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// classifyTaskType
// ---------------------------------------------------------------------------

describe("classifyTaskType", () => {
  // code_edit
  it("classifies 'refactor the Auth module' as CodeEdit", () => {
    expect(classifyTaskType(makePacket("Refactor the Auth module to remove duplication"))).toBe(TaskType.CodeEdit);
  });

  it("classifies 'fix the bug in parser' as CodeEdit", () => {
    expect(classifyTaskType(makePacket("Fix the bug in the parser where it crashes on empty input"))).toBe(TaskType.CodeEdit);
  });

  it("classifies 'update the UserService class' as CodeEdit", () => {
    expect(classifyTaskType(makePacket("Update the UserService class to use async/await"))).toBe(TaskType.CodeEdit);
  });

  // code_generation
  it("classifies 'implement a binary search function' as CodeGeneration", () => {
    expect(classifyTaskType(makePacket("Implement a binary search function in TypeScript"))).toBe(TaskType.CodeGeneration);
  });

  it("classifies 'write a class for HTTP requests' as CodeGeneration", () => {
    expect(classifyTaskType(makePacket("Write a class for making HTTP requests with retry logic"))).toBe(TaskType.CodeGeneration);
  });

  it("classifies 'scaffold a new REST API endpoint' as CodeGeneration", () => {
    expect(classifyTaskType(makePacket("Scaffold a new REST API endpoint for user authentication"))).toBe(TaskType.CodeGeneration);
  });

  // file_write
  it("classifies 'create a file at config/settings.json' as FileWrite", () => {
    expect(classifyTaskType(makePacket("Create a file at config/settings.json with default settings"))).toBe(TaskType.FileWrite);
  });

  it("classifies 'save to file the output' as FileWrite", () => {
    expect(classifyTaskType(makePacket("Save to file the generated report as report.md"))).toBe(TaskType.FileWrite);
  });

  // research
  it("classifies 'research the best caching strategies' as Research", () => {
    expect(classifyTaskType(makePacket("Research the best caching strategies for high-traffic APIs"))).toBe(TaskType.Research);
  });

  it("classifies 'summarize the RFC document' as Research", () => {
    expect(classifyTaskType(makePacket("Summarize the RFC document on WebSockets"))).toBe(TaskType.Research);
  });

  it("classifies 'analyze the performance data' as Research", () => {
    expect(classifyTaskType(makePacket("Analyze the performance data and find bottlenecks"))).toBe(TaskType.Research);
  });

  // explanation
  it("classifies 'explain what recursion means' as Explanation", () => {
    expect(classifyTaskType(makePacket("Explain what recursion means in programming"))).toBe(TaskType.Explanation);
  });

  it("classifies 'what is dependency injection' as Explanation", () => {
    expect(classifyTaskType(makePacket("What is dependency injection and why is it useful"))).toBe(TaskType.Explanation);
  });

  it("classifies 'describe the SOLID principles' as Explanation", () => {
    expect(classifyTaskType(makePacket("Describe the SOLID principles with examples"))).toBe(TaskType.Explanation);
  });

  // other
  it("classifies an ambiguous objective as Other", () => {
    expect(classifyTaskType(makePacket("Do the thing"))).toBe(TaskType.Other);
  });

  it("classifies an empty objective as Other", () => {
    expect(classifyTaskType(makePacket(""))).toBe(TaskType.Other);
  });

  // priority: CodeEdit wins over CodeGeneration when both signals present
  it("prefers CodeEdit over CodeGeneration when both signals are present", () => {
    // 'fix' + 'function' — CodeEdit should win via priority
    expect(classifyTaskType(makePacket("Fix the binary search function bug"))).toBe(TaskType.CodeEdit);
  });
});

// ---------------------------------------------------------------------------
// deriveDefaultACs
// ---------------------------------------------------------------------------

describe("deriveDefaultACs", () => {
  it("returns three ACs for CodeGeneration", () => {
    const acs = deriveDefaultACs(TaskType.CodeGeneration);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("compiles without errors");
    expect(acs).toContain("implements the described interface");
    expect(acs).toContain("avoids unjustified hardcoded values");
  });

  it("returns three ACs for CodeEdit", () => {
    const acs = deriveDefaultACs(TaskType.CodeEdit);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("existing tests continue to pass");
    expect(acs).toContain("the change matches the described intent");
    expect(acs).toContain("no unintended files modified");
  });

  it("returns three ACs for FileWrite", () => {
    const acs = deriveDefaultACs(TaskType.FileWrite);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("file exists at expected path");
    expect(acs).toContain("content matches described intent");
    expect(acs).toContain("no unintended files created");
  });

  it("returns three ACs for Research", () => {
    const acs = deriveDefaultACs(TaskType.Research);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("covers the key points from the source");
    expect(acs).toContain("does not hallucinate facts");
    expect(acs).toContain("appropriate length");
  });

  it("returns three ACs for Explanation", () => {
    const acs = deriveDefaultACs(TaskType.Explanation);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("clearly explains the concept");
    expect(acs).toContain("uses accurate terminology");
    expect(acs).toContain("appropriate level of detail");
  });

  it("returns empty array for Other", () => {
    expect(deriveDefaultACs(TaskType.Other)).toHaveLength(0);
  });

  it("returns a fresh mutable array (not the internal constant)", () => {
    const a = deriveDefaultACs(TaskType.Explanation);
    const b = deriveDefaultACs(TaskType.Explanation);
    a.push("extra");
    expect(b).toHaveLength(3); // b is unaffected
  });
});

// ---------------------------------------------------------------------------
// mergeAcceptanceCriteria
// ---------------------------------------------------------------------------

describe("mergeAcceptanceCriteria", () => {
  it("appends all derived ACs when packet has none", () => {
    const merged = mergeAcceptanceCriteria([], ["compiles without errors", "no hardcoded values"]);
    expect(merged).toEqual(["compiles without errors", "no hardcoded values"]);
  });

  it("places packet ACs first", () => {
    const merged = mergeAcceptanceCriteria(["my custom AC"], ["compiles without errors"]);
    expect(merged[0]).toBe("my custom AC");
    expect(merged[1]).toBe("compiles without errors");
  });

  it("does not duplicate an AC that already exists in the packet list (case-insensitive)", () => {
    const merged = mergeAcceptanceCriteria(
      ["compiles without errors"],
      ["compiles without errors", "no hardcoded values"],
    );
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(["compiles without errors", "no hardcoded values"]);
  });

  it("deduplication is case-insensitive", () => {
    const merged = mergeAcceptanceCriteria(
      ["Compiles Without Errors"],
      ["compiles without errors"],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe("Compiles Without Errors"); // packet AC kept verbatim
  });

  it("deduplication trims whitespace", () => {
    const merged = mergeAcceptanceCriteria(
      ["  compiles without errors  "],
      ["compiles without errors"],
    );
    expect(merged).toHaveLength(1);
  });

  it("returns only packet ACs when derived list is empty", () => {
    const merged = mergeAcceptanceCriteria(["custom AC"], []);
    expect(merged).toEqual(["custom AC"]);
  });

  it("returns empty array when both inputs are empty", () => {
    expect(mergeAcceptanceCriteria([], [])).toHaveLength(0);
  });

  it("packet ACs of same count as derived are not duplicated", () => {
    const packet  = ["compiles without errors", "implements the described interface", "avoids unjustified hardcoded values"];
    const derived = ["compiles without errors", "implements the described interface", "avoids unjustified hardcoded values"];
    const merged  = mergeAcceptanceCriteria(packet, derived);
    expect(merged).toHaveLength(3); // no duplicates added
  });
});

// ---------------------------------------------------------------------------
// getACPriority
// ---------------------------------------------------------------------------

describe("getACPriority", () => {
  it("classifies 'appropriate length' as soft", () => {
    expect(getACPriority("appropriate length")).toBe("soft");
  });

  it("classifies 'appropriate level of detail' as soft", () => {
    expect(getACPriority("appropriate level of detail")).toBe("soft");
  });

  it("classifies 'compiles without errors' as hard", () => {
    expect(getACPriority("compiles without errors")).toBe("hard");
  });

  it("classifies 'avoids unjustified hardcoded values' as hard", () => {
    expect(getACPriority("avoids unjustified hardcoded values")).toBe("hard");
  });

  it("is case-insensitive for soft ACs", () => {
    expect(getACPriority("APPROPRIATE LENGTH")).toBe("soft");
    expect(getACPriority("Appropriate Level Of Detail")).toBe("soft");
  });

  it("trims whitespace before matching", () => {
    expect(getACPriority("  appropriate length  ")).toBe("soft");
  });

  it("classifies user-authored ACs as hard by default", () => {
    expect(getACPriority("implements the described interface")).toBe("hard");
    expect(getACPriority("does not hallucinate facts")).toBe("hard");
    expect(getACPriority("")).toBe("hard");
  });
});

// ---------------------------------------------------------------------------
// CommandExecution classification
// ---------------------------------------------------------------------------

describe("classifyTaskType — CommandExecution", () => {
  it("classifies 'run the build' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run the build"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'run the tests' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run the tests"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'run the lint' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run the lint"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'run build' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run build"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'run tests' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run tests"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'npm run build' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("npm run build"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'npm test' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("npm test"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'pnpm run test' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("pnpm run test"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'run these in the app runtime build/test/lint' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("run these in the app runtime build/test/lint"))).toBe(TaskType.CommandExecution);
  });

  it("classifies 'build and test the project' as CommandExecution", () => {
    expect(classifyTaskType(makePacket("build and test the project"))).toBe(TaskType.CommandExecution);
  });

  it("CommandExecution wins over CodeEdit when both signals present", () => {
    // 'run the build' should beat any incidental code-related words
    expect(classifyTaskType(makePacket("run the build and fix any errors after"))).toBe(TaskType.CommandExecution);
  });
});

describe("deriveDefaultACs — CommandExecution", () => {
  it("returns three ACs for CommandExecution", () => {
    const acs = deriveDefaultACs(TaskType.CommandExecution);
    expect(acs).toHaveLength(3);
    expect(acs).toContain("output contains command execution results");
    expect(acs).toContain("commands ran to completion");
    expect(acs).toContain("no unintended files modified");
  });

  it("all CommandExecution ACs are hard", () => {
    for (const ac of deriveDefaultACs(TaskType.CommandExecution)) {
      expect(getACPriority(ac)).toBe("hard");
    }
  });
});
