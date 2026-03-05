/**
 * Completeness checks — unit tests (Phase 4.1 & 4.2 coverage)
 */

import { describe, it, expect } from "vitest";
import { runCompletenessChecks } from "./completeness.js";
import type { PappyInput } from "../types.js";

// ---------------------------------------------------------------------------
// Required files (constraint-based)
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — required files", () => {
  it("flags HIGH when a required file is absent from filesChanged", () => {
    const issues = runCompletenessChecks({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
    });
    const missing = issues.find((i) => i.code === "COMPLETENESS_MISSING_FILE");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("HIGH");
    expect(missing!.description).toContain("README.md");
  });

  it("does NOT flag when required file appears in filesChanged", () => {
    const issues = runCompletenessChecks({
      task: "Create README.md",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md"] },
      filesChanged: [{ path: "README.md", changeType: "A", diff: "# Orca\n" }],
    });
    const missing = issues.filter((i) => i.code === "COMPLETENESS_MISSING_FILE");
    expect(missing).toHaveLength(0);
  });

  it("flags each missing required file separately", () => {
    const issues = runCompletenessChecks({
      task: "Create README.md and LICENSE",
      outputText: "Done.",
      constraints: { requireFiles: ["README.md", "LICENSE"] },
    });
    const missing = issues.filter((i) => i.code === "COMPLETENESS_MISSING_FILE");
    expect(missing).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// No output at all
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — no output", () => {
  it("flags HIGH when there is no output, no files, and no tools", () => {
    const issues = runCompletenessChecks({
      task: "Do something.",
    });
    const noOutput = issues.find((i) => i.code === "COMPLETENESS_NO_OUTPUT");
    expect(noOutput).toBeDefined();
    expect(noOutput!.severity).toBe("HIGH");
  });

  it("does NOT flag when outputText is present", () => {
    const issues = runCompletenessChecks({
      task: "Explain something.",
      outputText: "Here is the explanation.",
    });
    const noOutput = issues.find((i) => i.code === "COMPLETENESS_NO_OUTPUT");
    expect(noOutput).toBeUndefined();
  });

  it("does NOT flag when only filesChanged is present", () => {
    const issues = runCompletenessChecks({
      task: "Create a file.",
      filesChanged: [{ path: "a.ts", changeType: "A", diff: "export {};" }],
    });
    const noOutput = issues.find((i) => i.code === "COMPLETENESS_NO_OUTPUT");
    expect(noOutput).toBeUndefined();
  });

  it("does NOT flag when only toolEvents are present", () => {
    const issues = runCompletenessChecks({
      task: "Do something.",
      toolEvents: [{ tool: "read_file", ok: true, summary: "Read" }],
    });
    const noOutput = issues.find((i) => i.code === "COMPLETENESS_NO_OUTPUT");
    expect(noOutput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task-aware semantic completeness (Phase 4.1)
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — domain keyword completeness (Phase 4.1)", () => {
  it("flags MEDIUM when login-form task output mentions nothing related", () => {
    const issues = runCompletenessChecks({
      task: "Implement a login form with validation.",
      outputText: "The sky is blue.",
    });
    const domainIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    expect(domainIssue).toBeDefined();
    expect(domainIssue!.severity).toBe("MEDIUM");
  });

  it("does NOT flag when output addresses domain keywords", () => {
    const issues = runCompletenessChecks({
      task: "Implement a login form with validation.",
      outputText:
        "The login form has an email field, a password field, a submit button, and client-side validation for each field.",
    });
    const domainIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    expect(domainIssue).toBeUndefined();
  });

  it("counts keyword evidence from diff content, not just outputText", () => {
    // Agent wrote all code to files; prose output is minimal.
    const issues = runCompletenessChecks({
      task: "Add unit tests for the auth module.",
      outputText: "Done.",
      filesChanged: [
        {
          path: "auth.test.ts",
          changeType: "A",
          diff: "describe('auth', () => { it('test login', () => { expect(true).toBe(true); }); });",
        },
      ],
    });
    const domainIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Diff contains 'test', 'expect' etc — should not flag as missing
    expect(domainIssue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File change verification (Phase 4.2)
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — empty diff verification (Phase 4.2)", () => {
  it("flags MEDIUM when a modified file has no diff", () => {
    const issues = runCompletenessChecks({
      task: "Update config.",
      outputText: "Config updated.",
      filesChanged: [{ path: "config.json", changeType: "M" }], // no diff
    });
    const emptyDiff = issues.find((i) => i.code === "COMPLETENESS_EMPTY_DIFF");
    expect(emptyDiff).toBeDefined();
    expect(emptyDiff!.severity).toBe("MEDIUM");
  });

  it("flags MEDIUM when an added file has empty diff", () => {
    const issues = runCompletenessChecks({
      task: "Create new file.",
      outputText: "Created.",
      filesChanged: [{ path: "new.ts", changeType: "A", diff: "" }],
    });
    const emptyDiff = issues.find((i) => i.code === "COMPLETENESS_EMPTY_DIFF");
    expect(emptyDiff).toBeDefined();
  });

  it("flags LOW for suspiciously short diff", () => {
    const issues = runCompletenessChecks({
      task: "Create a module.",
      outputText: "Done.",
      filesChanged: [{ path: "mod.ts", changeType: "A", diff: "// hi" }],
    });
    const suspDiff = issues.find((i) => i.code === "COMPLETENESS_SUSPICIOUS_DIFF");
    expect(suspDiff).toBeDefined();
    expect(suspDiff!.severity).toBe("LOW");
  });

  it("does NOT flag when diff is present and substantial", () => {
    const issues = runCompletenessChecks({
      task: "Implement auth module.",
      outputText: "Done.",
      filesChanged: [
        {
          path: "auth.ts",
          changeType: "A",
          diff: "export function login(user: string) { return user.length > 0; }",
        },
      ],
    });
    const emptyDiff = issues.filter(
      (i) =>
        i.code === "COMPLETENESS_EMPTY_DIFF" ||
        i.code === "COMPLETENESS_SUSPICIOUS_DIFF",
    );
    expect(emptyDiff).toHaveLength(0);
  });

  it("does NOT flag deleted files for missing diff", () => {
    // Deleted files don't need a diff in the same sense
    const issues = runCompletenessChecks({
      task: "Remove old file.",
      outputText: "Removed.",
      filesChanged: [{ path: "old.ts", changeType: "D" }],
    });
    const emptyDiff = issues.find((i) => i.code === "COMPLETENESS_EMPTY_DIFF");
    expect(emptyDiff).toBeUndefined();
  });
});
