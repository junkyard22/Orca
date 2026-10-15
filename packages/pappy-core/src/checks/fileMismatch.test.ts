/**
 * COMPLETENESS_FILE_MISMATCH (LOW) — why it fired in live rehearsal A6, and
 * that the rule itself needed no change.
 *
 * A6's final QC judged the repair pass. That pass edited nothing; the only
 * file it "reported" was "&1", invented by run_command from `npm test 2>&1`.
 * "&1" carries no extension the rule recognises for the task's categories
 * (testing, and the default .ts/.js/.py), so every category lacked file
 * evidence and the rule fired. With the redirection corrected, the repair pass
 * reports no files and the rule does not run; a real change to src/parse.js
 * already counts as evidence through its .js extension. These tests pin that
 * behaviour: the rule is unchanged and still fires on a genuinely unrelated
 * change.
 */
import { describe, expect, it } from "vitest";
import { runCompletenessChecks } from "./completeness.js";
import type { PappyInput } from "../types.js";

const TASK = "Fix the failing test in src/parse.js and run the tests.";
const input = (task: string, files: string[]): PappyInput => ({
  task,
  goals: [task],
  outputText: "ROOT CAUSE: parse('') threw because parseInt('') is NaN. Added an empty-input guard in src/parse.js; npm test: 13 passed, 0 failed. ".repeat(3),
  filesChanged: files.map((path) => ({ path, changeType: "A" as const })),
  toolEvents: [{ tool: "run_command", ok: true, summary: "run_command: ok" }],
} as unknown as PappyInput);
const mismatch = (task: string, files: string[]) => runCompletenessChecks(input(task, files)).some((i) => i.code === "COMPLETENESS_FILE_MISMATCH");

describe("COMPLETENESS_FILE_MISMATCH", () => {
  it("A6's trigger: the phantom \"&1\" as the pass's only reported file", () => {
    expect(mismatch(TASK, ["&1"])).toBe(true);
  });
  it("without the phantom, a pass that changed nothing reports no files and the rule does not run", () => {
    expect(mismatch(TASK, [])).toBe(false);
  });
  it("a real change to the named source file is file evidence (.js)", () => {
    expect(mismatch(TASK, ["src/parse.js"])).toBe(false);
  });
  it("the rule still fires on changes with no relevant file type", () => {
    expect(mismatch(TASK, ["notes/README.md"])).toBe(true);
    expect(mismatch("Add tests for the date parser and run them.", ["docs/dates.md"])).toBe(true);
  });
});
