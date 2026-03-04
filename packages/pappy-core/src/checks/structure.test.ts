/**
 * Structure checks — unit tests
 */

import { describe, it, expect } from "vitest";
import { runStructureChecks } from "./structure.js";

describe("runStructureChecks — required sections", () => {
  it("flags MEDIUM when required heading is absent", () => {
    const issues = runStructureChecks({
      task: "Write a plan.",
      outputText: "Here is some content without the heading.",
      constraints: { requireSections: ["Implementation"] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("STRUCTURE_MISSING_SECTION");
    expect(issues[0].severity).toBe("MEDIUM");
    expect(issues[0].description).toContain("Implementation");
  });

  it("passes when heading is present with # prefix", () => {
    const issues = runStructureChecks({
      task: "Write a plan.",
      outputText: "# Implementation\nDetails here.",
      constraints: { requireSections: ["Implementation"] },
    });
    expect(issues).toHaveLength(0);
  });

  it("passes when heading uses multiple hash levels (##, ###)", () => {
    const issues = runStructureChecks({
      task: "Write a plan.",
      outputText: "## Implementation\nDetails here.",
      constraints: { requireSections: ["Implementation"] },
    });
    expect(issues).toHaveLength(0);
  });

  it("flags each missing section separately", () => {
    const issues = runStructureChecks({
      task: "Write a full doc.",
      outputText: "Some content.",
      constraints: { requireSections: ["Overview", "Usage", "API"] },
    });
    expect(issues).toHaveLength(3);
    const codes = issues.map((i) => i.code);
    expect(codes.every((c) => c === "STRUCTURE_MISSING_SECTION")).toBe(true);
  });

  it("only flags missing sections, not present ones", () => {
    const issues = runStructureChecks({
      task: "Write docs.",
      outputText: "## Overview\nHere is an overview.\n\nSome content.",
      constraints: { requireSections: ["Overview", "Usage"] },
    });
    // Only "Usage" is missing
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("Usage");
  });

  it("returns no issues when requireSections is not set", () => {
    const issues = runStructureChecks({
      task: "Write anything.",
      outputText: "Some content.",
    });
    expect(issues).toHaveLength(0);
  });

  it("returns no issues when requireSections is empty", () => {
    const issues = runStructureChecks({
      task: "Write anything.",
      outputText: "Some content.",
      constraints: { requireSections: [] },
    });
    expect(issues).toHaveLength(0);
  });

  it("returns no issues when outputText is absent and no sections required", () => {
    const issues = runStructureChecks({
      task: "Do something.",
    });
    expect(issues).toHaveLength(0);
  });

  it("is case-insensitive for section headings (regex uses i flag)", () => {
    // The regex is built with the "im" flags, so lowercase heading matches.
    const issues = runStructureChecks({
      task: "Write plan.",
      outputText: "# implementation\nDetails.",
      constraints: { requireSections: ["Implementation"] },
    });
    // "implementation" (lowercase) DOES match "Implementation" via i flag
    expect(issues).toHaveLength(0);
  });

  it("handles sections with regex-special characters safely", () => {
    expect(() =>
      runStructureChecks({
        task: "Write plan.",
        outputText: "# Section (A+B)\nContent.",
        constraints: { requireSections: ["Section (A+B)"] },
      }),
    ).not.toThrow();
  });
});
