/**
 * Completeness checks — unit tests (Phase 4.1 & 4.2 coverage)
 */

import { describe, it, expect } from "vitest";
import { runCompletenessChecks, runSatisfactionChecks } from "./completeness.js";
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
// Routing criteria mismatch
// ---------------------------------------------------------------------------

describe("runCompletenessChecks - routing criteria mismatch", () => {
  it("does not treat PASS/WARN/FAIL verdict formatting as limitation language", () => {
    const issues = runCompletenessChecks({
      task: "Run a read-only smoke test and end with a PASS/WARN/FAIL verdict.",
      goals: [
        "Output ends with a PASS/WARN/FAIL verdict and supporting evidence",
      ],
      outputText: "The renderer is owned by @clawde/desktop.\n\nVerdict: PASS",
      toolEvents: [{ tool: "read_file", ok: true, summary: "read package.json" }],
    });

    expect(issues.find((i) => i.code === "ROUTING_CRITERIA_MISMATCH")).toBeUndefined();
  });

  it("still flags genuine limitation criteria when all tools succeeded", () => {
    const issues = runCompletenessChecks({
      task: "Inspect the workspace.",
      goals: [
        "Output explains inability to access the filesystem",
      ],
      outputText: "The workspace is readable.",
      toolEvents: [{ tool: "list_directory", ok: true, summary: "list root" }],
    });

    const mismatch = issues.find((i) => i.code === "ROUTING_CRITERIA_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe("HIGH");
  });
});

describe("runCompletenessChecks — script references", () => {
  it("does not require code when an audit asks to inspect package scripts", () => {
    const issues = runSatisfactionChecks({
      task: "Read the desktop package scripts and identify the exact command used to build the EXE.",
      outputText: "The desktop package defines dev, build, dist, and test scripts. The EXE is built by npm run dist --workspace @clawde/desktop.",
    });

    expect(issues.find((i) => i.code === "SATISFACTION_CODE_MISSING")).toBeUndefined();
  });

  it("still requires code when the task asks to write a script", () => {
    const issues = runSatisfactionChecks({
      task: "Write a script that prints hello.",
      outputText: "This should print hello.",
    });

    expect(issues.find((i) => i.code === "SATISFACTION_CODE_MISSING")).toBeDefined();
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

// ---------------------------------------------------------------------------
// File-change intent relevance
// ---------------------------------------------------------------------------

describe("runCompletenessChecks - file-change intent relevance", () => {
  it("allows implementation changes for function-name fix tasks", () => {
    const issues = runCompletenessChecks({
      task: "Fix formatRelativeDate so yesterday renders correctly.",
      outputText: "Updated formatRelativeDate.",
      filesChanged: [
        {
          path: "src/date/formatRelativeDate.ts",
          changeType: "M",
          diff: "export function formatRelativeDate(value: Date) { return isYesterday(value) ? 'yesterday' : format(value); }",
        },
      ],
    });

    expect(issues.find((i) => i.code === "UNREQUESTED_FILE_CHANGE")).toBeUndefined();
  });

  it("allows relevant UI file changes for UI tasks", () => {
    const issues = runCompletenessChecks({
      task: "Update the settings modal button state for disabled saves.",
      outputText: "Updated the settings modal button disabled state.",
      filesChanged: [
        {
          path: "src/components/SettingsModal.tsx",
          changeType: "M",
          diff: "export function SettingsModal() { return <button disabled={isSaving}>Save</button>; }",
        },
      ],
    });

    expect(issues.find((i) => i.code === "UNREQUESTED_FILE_CHANGE")).toBeUndefined();
  });

  it("allows normal bug-fix implementation changes without hardcoded domain nouns", () => {
    const issues = runCompletenessChecks({
      task: "Fix the off-by-one pagination regression.",
      outputText: "Fixed the pagination regression.",
      filesChanged: [
        {
          path: "src/paginate.ts",
          changeType: "M",
          diff: "export function pageCount(total: number, size: number) { return Math.ceil(total / size); }",
        },
      ],
    });

    expect(issues.find((i) => i.code === "UNREQUESTED_FILE_CHANGE")).toBeUndefined();
  });

  it("still blocks file changes for read-only inspection tasks", () => {
    const issues = runCompletenessChecks({
      task: "Explain what formatRelativeDate does.",
      outputText: "formatRelativeDate renders a relative date label.",
      filesChanged: [
        {
          path: "src/date/formatRelativeDate.ts",
          changeType: "M",
          diff: "export function formatRelativeDate() { return 'changed'; }",
        },
      ],
    });

    const issue = issues.find((i) => i.code === "UNREQUESTED_FILE_CHANGE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// Semantic completeness verification (Case studies)
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — semantic completeness case studies", () => {
  // Case 1 — should produce no completeness issues
  // The output uses synonyms like "contains", "returns", "basic example", "simple Python function"
  // which semantically cover the task concepts of "read" and "explain/purpose"
  it("Case 1: read file and explain purpose - should PASS with no issues", () => {
    const issues = runCompletenessChecks({
      task: "read the file hello_world.py and tell me what it does",
      goals: [
        "Output contains a summary of the file's contents",
        "Output explains the purpose/functionality of the code",
      ],
      outputText:
        "## TL;DR\n" +
        "This file contains a single Python function `hello_world()` that returns the string 'Hello, World!'. It's a basic example of a simple Python function with no dependencies or external calls.\n\n" +
        "## File Analysis\n" +
        "### Structure\n" +
        "- **1 function** defined: `hello_world()`\n" +
        "- **1 return statement** returning a string literal\n\n" +
        "### Key Points\n" +
        "- Function name: `hello_world`\n" +
        "- No parameters required\n" +
        "- Returns: 'Hello, World!' (string)\n" +
        "- No side effects or external operations",
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read_file: ok (51 chars)" },
      ],
    });

    // Should have no COMPLETENESS_MISSING_DOMAIN_TERMS issue
    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    expect(domainTermsIssue).toBeUndefined();

    // Should have no COMPLETENESS_GOAL_COVERAGE issue
    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeUndefined();
  });

  // Case 2 — should still catch a real failure
  // The output "I was unable to complete this task." does not address any
  // of the semantic concepts from the task (read, explain, purpose, functionality)
  it("Case 2: unable to complete task - should flag MEDIUM issues", () => {
    const issues = runCompletenessChecks({
      task: "read the file hello_world.py and tell me what it does",
      goals: [
        "Output contains a summary of the file's contents",
        "Output explains the purpose/functionality of the code",
      ],
      outputText: "I was unable to complete this task.",
      toolEvents: [],
    });

    // Should flag COMPLETENESS_MISSING_DOMAIN_TERMS as MEDIUM
    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    expect(domainTermsIssue).toBeDefined();
    expect(domainTermsIssue!.severity).toBe("MEDIUM");

    // Should flag COMPLETENESS_GOAL_COVERAGE as MEDIUM
    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeDefined();
    expect(goalCoverageIssue!.severity).toBe("MEDIUM");
  });

  // Additional test: verify severity downgrade when output >200 chars, tools exist, and AC proved
  it("Case 3: substantial output with tools - should downgrade to LOW severity", () => {
    const issues = runCompletenessChecks({
      task: "read the file hello_world.py and tell me what it does",
      goals: [
        "Output contains a summary of the file's contents",
        "Output explains the purpose/functionality of the code",
      ],
      outputText:
        "## TL;DR\n" +
        "This file contains a single Python function `hello_world()` that returns the string 'Hello, World!'. It's a basic example of a simple Python function with no dependencies or external calls.\n\n" +
        "## File Analysis\n" +
        "### Structure\n" +
        "- **1 function** defined: `hello_world()`\n" +
        "- **1 return statement** returning a string literal\n\n" +
        "### Key Points\n" +
        "- Function name: `hello_world`\n" +
        "- No parameters required\n" +
        "- Returns: 'Hello, World!' (string)\n" +
        "- No side effects or external operations",
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read_file: ok (51 chars)" },
      ],
    });

    // With substantial output (>200 chars), tool events, and AC proved,
    // the severity should be LOW instead of MEDIUM
    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    expect(domainTermsIssue).toBeUndefined(); // No issue because concepts are covered

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeUndefined(); // No issue because concepts are covered
  });

  it("does not flag goal coverage for condensed bullet summaries with successful tool use", () => {
    const issues = runCompletenessChecks({
      task: "summarize hello_world.py in 3 bullet points",
      goals: [
        "Output contains exactly 3 bullet points",
        "Each bullet point summarizes a key aspect of hello_world.py",
        "Summary is concise and captures the file's purpose",
      ],
      outputText:
        "- Defines a single function named `hello_world()` that takes no parameters\n" +
        "- The function returns a hardcoded string \"Hello, World!\"\n" +
        "- Minimal implementation with no additional logic, imports, or complexity",
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read_file: ok (51 chars)" },
      ],
    });

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeUndefined();
  });

  it("still flags thin condensed bullet summaries when no tool evidence exists", () => {
    const issues = runCompletenessChecks({
      task: "summarize hello_world.py in 3 bullet points",
      goals: [
        "Each bullet point summarizes a key aspect of hello_world.py",
        "Summary is concise and captures the file's purpose",
      ],
      outputText:
        "- First bullet\n" +
        "- Second bullet\n" +
        "- Third bullet",
      toolEvents: [],
    });

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeDefined();
  });

  it("lowers the threshold for brief overview requests with structured output", () => {
    const issues = runCompletenessChecks({
      task: "give me a brief overview of hello_world.py",
      goals: [
        "Provide a brief overview of hello_world.py",
        "Summary is concise and captures the file's purpose",
      ],
      outputText:
        "- Defines hello_world()\n" +
        "- Returns \"Hello, World!\"",
    });

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeUndefined();
  });

  it("still flags low-coverage detailed explanations at the normal threshold", () => {
    const issues = runCompletenessChecks({
      task: "explain in detail what hello_world.py does and how it works",
      goals: [
        "Explain in detail what hello_world.py does",
        "Describe how the code works internally",
      ],
      outputText: "It prints hello.",
    });

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeDefined();
    expect(goalCoverageIssue!.severity).toBe("MEDIUM");
  });

  it("keeps empty condensed responses at MEDIUM severity for goal coverage", () => {
    const issues = runCompletenessChecks({
      task: "summarize hello_world.py in 3 bullet points",
      goals: [
        "Each bullet point summarizes a key aspect of hello_world.py",
        "Summary is concise and captures the file's purpose",
      ],
      outputText: "",
      toolEvents: [
        { tool: "read_file", ok: true, summary: "read_file: ok (51 chars)" },
      ],
    });

    const goalCoverageIssue = issues.find(
      (i) => i.code === "COMPLETENESS_GOAL_COVERAGE",
    );
    expect(goalCoverageIssue).toBeDefined();
    expect(goalCoverageIssue!.severity).toBe("MEDIUM");
  });
});

// ---------------------------------------------------------------------------
// Generic task handling — no false positives for action verbs
// ---------------------------------------------------------------------------

describe("runCompletenessChecks — generic task handling (no false positives)", () => {
  it("does NOT flag COMPLETENESS_MISSING_DOMAIN_TERMS for 'create a file called config.json with a name and version'", () => {
    const issues = runCompletenessChecks({
      task: "create a file called config.json with a name, version, and description field",
      outputText: "Created config.json with the required fields.",
      filesChanged: [
        {
          path: "config.json",
          changeType: "A",
          diff: '{"name": "test", "version": "1.0.0", "description": "A test config"}',
        },
      ],
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Should NOT flag because "create", "file", "name", "version", "description" are generic
    expect(domainTermsIssue).toBeUndefined();
  });

  it("does NOT flag COMPLETENESS_MISSING_DOMAIN_TERMS for 'write a function to sort an array'", () => {
    const issues = runCompletenessChecks({
      task: "write a function to sort an array",
      outputText: "Here's a function that sorts an array:",
      filesChanged: [
        {
          path: "sort.ts",
          changeType: "A",
          diff: "export function sortArray(arr: number[]) { return arr.sort((a, b) => a - b); }",
        },
      ],
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Should NOT flag because "write", "function", "array" are generic
    expect(domainTermsIssue).toBeUndefined();
  });

  it("correctly extracts domain terms for 'build a REST API endpoint for user login'", () => {
    const issues = runCompletenessChecks({
      task: "build a REST API endpoint for user login",
      outputText: "Created an API endpoint for authentication.",
      filesChanged: [
        {
          path: "api/auth.ts",
          changeType: "A",
          diff: "export async function login(req, res) { /* auth logic */ }",
        },
      ],
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Should NOT flag because output mentions "API" and "authentication" (auth domain)
    expect(domainTermsIssue).toBeUndefined();
  });

  it("correctly extracts domain terms for 'create a database schema for users'", () => {
    const issues = runCompletenessChecks({
      task: "create a database schema for users",
      outputText: "Created a database schema with a users table.",
      filesChanged: [
        {
          path: "schema.sql",
          changeType: "A",
          diff: "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255));",
        },
      ],
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Should NOT flag because output mentions "database" and "schema" and "table"
    expect(domainTermsIssue).toBeUndefined();
  });

  it("skips domain term matching entirely for generic tasks with no domain nouns", () => {
    const issues = runCompletenessChecks({
      task: "make a script that prints hello",
      outputText: "Created a script that prints hello.",
      filesChanged: [
        {
          path: "hello.py",
          changeType: "A",
          diff: "print('hello')",
        },
      ],
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // Should NOT flag because this is a generic task with no domain-specific nouns
    expect(domainTermsIssue).toBeUndefined();
  });

  it("still flags domain terms for tasks with genuine domain-specific nouns", () => {
    const issues = runCompletenessChecks({
      task: "create a login form with email validation",
      outputText: "The sky is blue.",
    });

    const domainTermsIssue = issues.find(
      (i) => i.code === "COMPLETENESS_MISSING_DOMAIN_TERMS",
    );
    // SHOULD flag because "form", "login", "validation" are domain-specific nouns
    expect(domainTermsIssue).toBeDefined();
    expect(domainTermsIssue!.severity).toBe("MEDIUM");
  });
});
