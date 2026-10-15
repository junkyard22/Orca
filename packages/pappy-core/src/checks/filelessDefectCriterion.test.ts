/**
 * A bug-fix criterion that names no file (1.7.0 release stabilization, after
 * live rehearsal A7): Brain's "The failing test is fixed" fell to fail-closed
 * on the first pass although the host had recorded the failure on the
 * task-start source, the edit, and the full suite passing on the final source.
 * That forced an unnecessary repair pass.
 *
 * It is now decided by the defect's own evidence: a source change on disk plus
 * a reproduction (failed on the task-start source, passes on the final source)
 * or a regression test the final suite ran. Everything that could manufacture
 * that evidence is still refused.
 *
 * Contract: the user's request plus Brain's A7 criteria, as the runtime now
 * judges every pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateWithPappy } from "../pappy.js";
import type { PappyInput, ToolEvent, WorkspaceEvidence, WorkspaceTestRun } from "../types.js";
import { isFullSuiteCommand } from "./workspaceVerification.js";

const FIX_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "parse-fix");
const fx = (name: string) => readFileSync(join(FIX_DIR, name), "utf8");
const SRC_BASE = fx("parse.base.txt");
const SRC_FIXED = fx("parse.fixed.txt");
const TEST_BASE = fx("parse.test.base.txt");
const TEST_WEAKENED = fx("parse.test.weakened.txt");

const TASK = "Fix the failing test in src/parse.js and run the tests.";
/** A7's acceptance contract: the user's goal, then Brain's criteria. */
const A7 = [TASK, "Root cause of the failing test in src/parse.js is identified", "The failing test is fixed", "Tests are run and pass successfully"];
const FILELESS = "AC3";

function cmd(command: string, fixture: string): ToolEvent {
  const output = fx(fixture);
  const ok = !output.startsWith("[Exit code");
  return { tool: "run_command", ok, summary: ok ? "run_command: ok" : "run_command: failed - [Exit code 1]", raw: { command, _outputForProof: output, _exitCodeForProof: ok ? 0 : 1 } };
}
const write = (path: string, content: string): ToolEvent => ({ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path, content, _contentForDiff: content } });
const hostRun = (command: string, fixture: string, sourceState: WorkspaceTestRun["sourceState"]): WorkspaceTestRun => {
  const output = fx(fixture);
  const ok = !output.startsWith("[Exit code");
  return { tool: "run_command", command, ok, exitCode: ok ? 0 : 1, output, fullSuite: isFullSuiteCommand(command, "node --test"), sourceState };
};
const ws = (changes: WorkspaceEvidence["changes"], testRuns: WorkspaceTestRun[] = []): WorkspaceEvidence =>
  ({ available: true, provenance: "runtime-snapshot", baselineFiles: 4, changes, testCommand: "node --test", testRuns });
const srcChange = (after: string) => ({ path: "src/parse.js", status: "modified" as const, kind: "source" as const, after, writers: ["debugger"] });
const input = (over: Partial<PappyInput>): PappyInput =>
  ({ task: TASK, goals: A7, outputText: "", filesChanged: [], toolEvents: [], metadata: { stoppedBecause: "done" }, constraints: {}, ...over });
const status = (r: ReturnType<typeof evaluateWithPappy>, ref: string) => r.receipt_ledger.find((e) => e.ref === ref)?.status;
const codes = (r: ReturnType<typeof evaluateWithPappy>) => r.issues.map((i) => i.code);

describe("file-less bug-fix criterion", () => {
  it("A7's first pass: reproduction, edit, full suite on the final source → every criterion PROVED, PASS / verified / eligible without a repair", () => {
    const r = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), cmd("npm test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "ROOT CAUSE: parse('') threw a RangeError because parseInt('') is NaN. FIX: added an empty-input guard in src/parse.js. npm test: 5 passed, 0 failed.",
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("npm test", "base_nodetest.out", "baseline"), hostRun("npm test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, FILELESS)).toBe("PROVED");
    expect(r.receipt_ledger.find((e) => e.ref === FILELESS)!.evidence.join(" ")).toMatch(/source changed on disk: src\/parse\.js/);
    expect(r.receipt_ledger.every((e) => e.status === "PROVED")).toBe(true);
    expect(r.verdict).toBe("PASS");
    expect(r.verification?.status).toBe("verified");
    expect(r.trainingEligibility).toBe("eligible");
  });

  it("no source change despite a success claim → not proved; contradicted", () => {
    const r = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out")],
      outputText: "Fixed. npm test: 5 passed, 0 failed.",
      workspace: ws([], [hostRun("npm test", "base_nodetest.out", "baseline")]),
    }));
    expect(status(r, FILELESS)).not.toBe("PROVED");
    expect(r.verdict).toBe("FAIL");
    expect(codes(r)).toContain("FIX_SOURCE_CHANGE_MISSING");
  });

  it("only an unrelated passing subset after the edit → not proved", () => {
    const r = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), cmd("node --test test/other.test.js", "base_subset.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed; the tests pass.",
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("npm test", "base_nodetest.out", "baseline"), hostRun("node --test test/other.test.js", "base_subset.out", "final")]),
    }));
    expect(status(r, FILELESS)).not.toBe("PROVED");
    expect(r.verdict).toBe("FAIL");
  });

  it("a passing suite without a reproduction does not prove that the reported failure is fixed", () => {
    const r = evaluateWithPappy(input({
      toolEvents: [write("src/parse.js", SRC_FIXED), cmd("npm test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed; npm test: 5 passed.",
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("npm test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, FILELESS)).toBe("PARTIAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("tests passed, then the source changed again without a re-run → not proved", () => {
    const later = SRC_FIXED.replace("return 0;", "return 0; // tweak");
    const r = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), cmd("npm test", "fixed_nodetest.out"), write("src/parse.js", later)],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: later }],
      outputText: "Fixed; npm test: 5 passed.",
      workspace: ws([srcChange(later)], [hostRun("npm test", "base_nodetest.out", "baseline"), hostRun("npm test", "fixed_nodetest.out", "intermediate")]),
    }));
    expect(status(r, FILELESS)).not.toBe("PROVED");
    expect(codes(r)).toContain("FIX_TESTS_NOT_RERUN");
  });

  it("a still-failing suite, or failing tests deleted, → not proved, FAIL", () => {
    const partial = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out"), write("src/parse.js", SRC_BASE + "\n// attempt\n"), cmd("npm test", "base_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_BASE }],
      outputText: "Fixed; all tests pass.",
      workspace: ws([srcChange(SRC_BASE + "\n// attempt\n")], [hostRun("npm test", "base_nodetest.out", "baseline"), hostRun("npm test", "base_nodetest.out", "final")]),
    }));
    expect(status(partial, FILELESS)).not.toBe("PROVED");
    expect(partial.verdict).toBe("FAIL");
    const deleted = evaluateWithPappy(input({
      toolEvents: [cmd("npm test", "base_nodetest.out"), write("test/parse.test.js", TEST_WEAKENED), write("src/parse.js", SRC_FIXED), cmd("npm test", "weakened_nodetest.out")],
      filesChanged: [{ path: "test/parse.test.js", changeType: "M", diff: TEST_WEAKENED }, { path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed; npm test: 3 passed.",
      workspace: ws([{ path: "test/parse.test.js", status: "modified", kind: "test", before: TEST_BASE, after: TEST_WEAKENED }, srcChange(SRC_FIXED)], [hostRun("npm test", "base_nodetest.out", "baseline"), hostRun("npm test", "weakened_nodetest.out", "final")]),
    }));
    expect(status(deleted, FILELESS)).not.toBe("PROVED");
    expect(deleted.verdict).toBe("FAIL");
  });

  it("only in bug-fix tasks: the same wording in a feature task is not decided by this rule", () => {
    const r = evaluateWithPappy({ ...input({
      toolEvents: [write("src/parse.js", SRC_FIXED), cmd("npm test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("npm test", "fixed_nodetest.out", "final")]),
    }), task: "Add a hex mode to parse in src/parse.js", goals: ["The failing test is fixed"] });
    expect(r.receipt_ledger[0]?.evidence.join(" ") ?? "").not.toMatch(/the defect's own test evidence/);
  });
});
