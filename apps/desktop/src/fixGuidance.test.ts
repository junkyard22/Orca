import { describe, expect, it } from "vitest";
import { fixVerificationGuidance } from "./fixGuidance";

const FIND_FIX =
  "Users reported a bug in this meeting-room booking app (see ISSUE.md). Investigate the repository, identify the root cause, " +
  "and implement the smallest correct fix in the source code. Then run the project's test suite and verify that the reported " +
  "problem is actually resolved. Do not change unrelated behavior or modify the existing tests.";

describe("fixVerificationGuidance", () => {
  it("tells a bug-fix worker to reproduce first, re-run the full suite, and how to document an alternative", () => {
    const goals = fixVerificationGuidance(FIND_FIX);
    expect(goals.join("\n")).toMatch(/Before changing any source code, run/);
    expect(goals.join("\n")).toMatch(/full test suite again/);
    expect(goals.join("\n")).toMatch(/Alternative verification:/);
    expect(goals.join("\n")).toMatch(/Do not modify, delete, skip, or weaken any existing test/);
  });

  it("adds nothing for tasks that are not bug fixes", () => {
    expect(fixVerificationGuidance("Write a README for this project.")).toEqual([]);
  });
});
