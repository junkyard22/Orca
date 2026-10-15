/**
 * Which workers may not write files. The 1.7.0 live rehearsal's bug-fix
 * worker was given `no_file_writes` because its objective ended "and run the
 * tests"; every edit was refused. A pure run-and-report request must keep the
 * constraint.
 */
import { describe, expect, it } from "vitest";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import { isCommandExecutionObjective, workerMustNotWriteFiles } from "./workerConstraints";

const task = (message: string): OrcaTaskSpec =>
  ({ originalUserMessage: message, intent: message.toLowerCase(), goals: [message] }) as unknown as OrcaTaskSpec;
const verdict = (message: string) => workerMustNotWriteFiles(task(message), message.toLowerCase());

describe("no_file_writes for worker packets", () => {
  it("a change request that also asks to run the tests may write (the rehearsal case)", () => {
    for (const m of [
      "Fix the failing test in src/parse.js and run the tests.",
      "Fix the bug in src/app.ts, then run npm test.",
      "Add a --verbose flag to the CLI and run the tests.",
      "Refactor utils.ts and run the tests",
      "Update docs/README.md and run the build.",
    ]) {
      expect(isCommandExecutionObjective(m.toLowerCase()), m).toBe(true);
      expect(verdict(m), m).toBe(false);
    }
  });

  it("a pure command run keeps the constraint, including a run-and-report phrased like a failure", () => {
    for (const m of [
      "Run the tests.",
      "run the tests and report",
      "npm test",
      "Run the build and lint and tell me what fails.",
      "Do not change any files. Run the tests and report the failures.",
    ]) expect(verdict(m), m).toBe(true);
  });

  it("an objective that is not command execution never gets the constraint from this rule", () => {
    expect(verdict("Explain what src/parse.js does.")).toBe(false);
    expect(verdict("Fix the off-by-one in src/range.ts.")).toBe(false);
  });
});
