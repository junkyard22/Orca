/**
 * Behavioural criteria for code changes — the 1.7.0 rehearsal false rejection
 * and the adversarial cases that must stay rejected.
 *
 * Fixtures (__fixtures__/parse-fix) are real `node --test` outputs of the
 * rehearsal project, formatted as run_command records them: the buggy source
 * (3 pass / 2 fail), the fixed source (5 / 0), a passing one-test subset, and
 * a suite with the two failing tests deleted (3 / 0).
 *
 * Before the correction, a genuine fix with a reproduction and a passing full
 * suite on the final source was FAIL: "The failing test in src/parse.js is
 * identified and fixed" was judged by whether parse.js contained "failing"
 * and "identified", and "Tests are run and all pass after the fix" had no
 * verifier at all.
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
/** Brain's done criteria in the live A1–A3 runs. */
const LIVE = ["The failing test in src/parse.js is identified and fixed", "Tests are run and all pass after the fix"];

function cmd(command: string, fixture: string): ToolEvent {
  const output = fx(fixture);
  const ok = !output.startsWith("[Exit code");
  return { tool: "run_command", ok, summary: ok ? "run_command: ok" : "run_command: failed - Command failed with exit code 1", raw: { command, _outputForProof: output, _exitCodeForProof: ok ? 0 : 1 } };
}
const write = (path: string, content: string): ToolEvent => ({ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path, content, _contentForDiff: content } });
const read = (path: string, content: string): ToolEvent => ({ tool: "read_file", ok: true, summary: "read_file: ok", raw: { path, _outputForProof: content } });
const hostRun = (command: string, fixture: string, sourceState: WorkspaceTestRun["sourceState"]): WorkspaceTestRun => {
  const output = fx(fixture);
  const ok = !output.startsWith("[Exit code");
  return { tool: "run_command", command, ok, exitCode: ok ? 0 : 1, output, fullSuite: isFullSuiteCommand(command, "node --test"), sourceState };
};
const ws = (changes: WorkspaceEvidence["changes"], testRuns: WorkspaceTestRun[] = []): WorkspaceEvidence =>
  ({ available: true, provenance: "runtime-snapshot", baselineFiles: 4, changes, testCommand: "node --test", testRuns });
const srcChange = (after: string) => ({ path: "src/parse.js", status: "modified" as const, kind: "source" as const, after });
function input(goals: string[], over: Partial<PappyInput>): PappyInput {
  return { task: TASK, goals, outputText: "", filesChanged: [], toolEvents: [], metadata: { stoppedBecause: "done" }, constraints: {}, ...over };
}
const codes = (r: ReturnType<typeof evaluateWithPappy>) => r.issues.map((i) => i.code);
const status = (r: ReturnType<typeof evaluateWithPappy>, ref: string) => r.receipt_ledger.find((e) => e.ref === ref)?.status;

/** Reproduce on the buggy source, edit, re-run the full suite on the final source. */
const genuine = (goals: string[]) => input(goals, {
  toolEvents: [read("src/parse.js", SRC_BASE), cmd("node --test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), cmd("node --test", "fixed_nodetest.out")],
  filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
  outputText: "Root cause: parse('') threw a RangeError because parseInt('') is NaN. Changed parse in src/parse.js to return 0 for empty or whitespace-only input. node --test: 5 passed, 0 failed.",
  workspace: ws([srcChange(SRC_FIXED)], [hostRun("node --test", "base_nodetest.out", "baseline"), hostRun("node --test", "fixed_nodetest.out", "final")]),
});

describe("genuine bug fix: host evidence is accepted (the rehearsal false rejection)", () => {
  it("criteria = the user's goal: PASS, verified, eligible; the criterion is decided by the reproduction, not by words in parse.js", () => {
    const r = evaluateWithPappy(genuine([TASK]));
    expect(r.verdict).toBe("PASS");
    expect(r.verification).toMatchObject({ status: "verified", taskKind: "bugfix", testEvidence: true });
    expect(r.trainingEligibility).toBe("eligible");
    const ac1 = r.receipt_ledger[0]!;
    expect(ac1.status).toBe("PROVED");
    expect(ac1.strength).toBe("independent");
    expect(ac1.evidence.join(" ")).toMatch(/named file\(s\) changed on disk: src\/parse\.js[\s\S]*behavioural receipt: reproduced then resolved/);
  });

  it("criteria = Brain's live done criteria: both PROVED by host evidence; PASS, verified, eligible", () => {
    const r = evaluateWithPappy(genuine(LIVE));
    expect(status(r, "AC1")).toBe("PROVED");
    expect(status(r, "AC2")).toBe("PROVED");
    expect(r.receipt_ledger[1]!.evidence.join(" ")).toMatch(/host-recorded test run on the final source: reproduced then resolved/);
    expect(r.verdict).toBe("PASS");
    expect(r.verification?.status).toBe("verified");
    expect(r.trainingEligibility).toBe("eligible");
  });

  it("a regression test added and run by the final suite speaks for a defect criterion without a separate reproduction run", () => {
    const testsAfter = `${TEST_BASE}\ntest("returns 0 for a tab-only string", () => { assert.equal(parse("\\t"), 0); });\n`;
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [write("src/parse.js", SRC_FIXED), write("test/parse.test.js", testsAfter), cmd("node --test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }, { path: "test/parse.test.js", changeType: "M", diff: testsAfter }],
      outputText: "Fixed parse in src/parse.js for empty input and added a regression test. node --test: all tests pass.",
      workspace: ws([srcChange(SRC_FIXED), { path: "test/parse.test.js", status: "modified", kind: "test", before: TEST_BASE, after: testsAfter }], [hostRun("node --test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, "AC1")).toBe("PROVED");
    expect(r.receipt_ledger[0]!.evidence.join(" ")).toMatch(/behavioural receipt: tests added in test\/parse\.test\.js/);
  });
});

describe("adversarial: what must still be refused", () => {
  it("no source edit despite a success claim → contradicted FAIL; nothing proved", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [read("src/parse.js", SRC_BASE), cmd("node --test", "base_nodetest.out")],
      outputText: "Fixed parse in src/parse.js. node --test: 5 passed, 0 failed.",
      workspace: ws([], [hostRun("node --test", "base_nodetest.out", "baseline")]),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).toBe("contradicted");
    expect(codes(r)).toContain("FIX_SOURCE_CHANGE_MISSING");
    expect(status(r, "AC1")).not.toBe("PROVED");
    expect(status(r, "AC2")).not.toBe("PROVED");
    expect(r.trainingEligibility).not.toBe("eligible");
  });

  it("tests passed before a later, untested modification → not verified; neither criterion proved", () => {
    const later = `${SRC_FIXED}\n// tidy-up after the test run\n`;
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [cmd("node --test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), cmd("node --test", "fixed_nodetest.out"), write("src/parse.js", later)],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: later }],
      outputText: "Fixed parse in src/parse.js. node --test: 5 passed.",
      workspace: ws([srcChange(later)], [hostRun("node --test", "base_nodetest.out", "baseline"), hostRun("node --test", "fixed_nodetest.out", "intermediate")]),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).not.toBe("verified");
    expect(codes(r)).toContain("FIX_TESTS_NOT_RERUN");
    expect(status(r, "AC1")).not.toBe("PROVED");
    expect(status(r, "AC2")).not.toBe("PROVED");
  });

  it("a passing subset unrelated to the bug, after a source change → not verified", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [write("src/parse.js", SRC_FIXED), cmd("node --test --test-name-pattern=\"plain integer\"", "base_subset.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed parse in src/parse.js. Tests pass: 1 passed, 0 failed.",
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("node --test --test-name-pattern=\"plain integer\"", "base_subset.out", "final")]),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(codes(r)).toContain("FIX_TEST_SUBSET_ONLY");
    expect(status(r, "AC2")).not.toBe("PROVED");
  });

  it("a passing full suite with no reproduction does not prove a criterion about the failing test", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [write("src/parse.js", SRC_FIXED), cmd("node --test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed parse in src/parse.js. node --test: 5 passed.",
      workspace: ws([srcChange(SRC_FIXED)], [hostRun("node --test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, "AC1")).toBe("PARTIAL");
    expect(r.receipt_ledger[0]!.evidence.join(" ")).toMatch(/no reproduction resolved on the final source and no regression test ran/);
    expect(status(r, "AC2")).toBe("PROVED"); // the suite did run and pass on the final source
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).toBe("unverified");
  });

  it("the final suite still fails (a partial fix), honestly reported or claimed as success → contradicted FAIL", () => {
    for (const claim of ["Changed parse in src/parse.js; node --test: 3 passed, 2 failed.", "Fixed parse in src/parse.js. node --test: 5 passed, 0 failed."]) {
      const partial = SRC_BASE.replace("  const trimmed = String(text).trim();", "  const trimmed = String(text).trim();\n  // attempted fix");
      const r = evaluateWithPappy(input(LIVE, {
        toolEvents: [cmd("node --test", "base_nodetest.out"), write("src/parse.js", partial), cmd("node --test", "base_nodetest.out")],
        filesChanged: [{ path: "src/parse.js", changeType: "M", diff: partial }],
        outputText: claim,
        workspace: ws([srcChange(partial)], [hostRun("node --test", "base_nodetest.out", "baseline"), hostRun("node --test", "base_nodetest.out", "final")]),
      }));
      expect(r.verdict, claim).toBe("FAIL");
      expect(r.verification?.status, claim).toBe("contradicted");
      expect(codes(r), claim).toContain("FIX_TESTS_FAILING");
      expect(status(r, "AC1"), claim).not.toBe("PROVED");
      expect(status(r, "AC2"), claim).not.toBe("PROVED");
      expect(r.trainingEligibility === "eligible", claim).toBe(false);
    }
  });

  it("failing tests deleted to make the suite pass → FAIL; the shrunk suite proves nothing", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [cmd("node --test", "base_nodetest.out"), write("test/parse.test.js", TEST_WEAKENED), write("src/parse.js", SRC_FIXED), cmd("node --test", "weakened_nodetest.out")],
      filesChanged: [{ path: "test/parse.test.js", changeType: "M", diff: TEST_WEAKENED }, { path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed. node --test: 3 passed, 0 failed.",
      workspace: ws(
        [{ path: "test/parse.test.js", status: "modified", kind: "test", before: TEST_BASE, after: TEST_WEAKENED }, srcChange(SRC_FIXED)],
        [hostRun("node --test", "base_nodetest.out", "baseline"), hostRun("node --test", "weakened_nodetest.out", "final")],
      ),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).not.toBe("verified");
    expect(codes(r).some((c) => /TEST_COUNT_DROPPED|TESTS_MODIFIED|TEST_FILES_MODIFIED|TEST_WEAKENED/.test(c))).toBe(true);
    expect(status(r, "AC2")).not.toBe("PROVED");
    expect(r.trainingEligibility).not.toBe("eligible");
  });

  it("a source change with no test run (no behavioural evidence) → not verified; the criterion stays PARTIAL", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [write("src/parse.js", SRC_FIXED)],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed parse in src/parse.js so empty input returns 0. All tests pass.",
      workspace: ws([srcChange(SRC_FIXED)], []),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).toBe("unverified");
    expect(status(r, "AC1")).toBe("PARTIAL");
    expect(status(r, "AC2")).not.toBe("PROVED");
  });

  it("a successful command that is not the test suite does not satisfy the objective", () => {
    const ok: ToolEvent = { tool: "run_command", ok: true, summary: "run_command: ok", raw: { command: "node -e \"console.log(require('./src/parse').parse(''))\"", _outputForProof: "0", _exitCodeForProof: 0 } };
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [write("src/parse.js", SRC_FIXED), ok],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed parse in src/parse.js; parse('') now prints 0.",
      workspace: ws([srcChange(SRC_FIXED)], []),
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).not.toBe("verified");
    expect(status(r, "AC2")).not.toBe("PROVED");
  });

  it("conflicting writes by two workers with no run on the final source → not verified, never eligible", () => {
    const r = evaluateWithPappy(input(LIVE, {
      toolEvents: [cmd("node --test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED)],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }],
      outputText: "Fixed parse in src/parse.js.",
      workspace: { ...ws([{ ...srcChange(SRC_FIXED), writers: ["debugger", "engineer"] }], [hostRun("node --test", "base_nodetest.out", "baseline")]), contested: [{ path: "src/parse.js", writers: ["debugger", "engineer"] }] } as WorkspaceEvidence,
    }));
    expect(r.verdict).toBe("FAIL");
    expect(r.verification?.status).not.toBe("verified");
    expect(r.trainingEligibility).not.toBe("eligible");
  });
});

describe("scope: what the correction does not touch", () => {
  it("a documentation file named by a criterion keeps the E3 content rule (no proof from a code change elsewhere)", () => {
    const readmeAfter = "# parse\n\nparse('') returns 0.\n";
    const goals = ["Fix the failing test in src/parse.js", "README.md documents that parse returns 0 for empty input"];
    const r = evaluateWithPappy(input(goals, {
      task: `${TASK} Document the behaviour in README.md.`,
      toolEvents: [cmd("node --test", "base_nodetest.out"), write("src/parse.js", SRC_FIXED), write("README.md", readmeAfter), cmd("node --test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: SRC_FIXED }, { path: "README.md", changeType: "M", diff: readmeAfter }],
      outputText: "Fixed parse and documented it in README.md. node --test: 5 passed.",
      workspace: ws([srcChange(SRC_FIXED), { path: "README.md", status: "modified", kind: "docs", after: readmeAfter }], [hostRun("node --test", "base_nodetest.out", "baseline"), hostRun("node --test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, "AC1")).toBe("PROVED");
    const readme = r.receipt_ledger.find((e) => e.ref === "AC2")!;
    expect(readme.status).not.toBe("PROVED");
    expect(readme.evidence.join(" ")).not.toMatch(/a code change; its behaviour/);
  });

  it("a feature criterion naming the source file needs feature-specific evidence, not just a passing suite", () => {
    const featureSrc = SRC_FIXED.replace("function parse(text) {", "function parse(text, options = {}) {");
    const goals = ["src/parse.js accepts a strict option that rejects leading zeros"];
    const r = evaluateWithPappy(input(goals, {
      task: "Add a strict option to parse in src/parse.js that rejects leading zeros, and run the tests.",
      toolEvents: [write("src/parse.js", featureSrc), cmd("node --test", "fixed_nodetest.out")],
      filesChanged: [{ path: "src/parse.js", changeType: "M", diff: featureSrc }],
      outputText: "Added a strict option to parse in src/parse.js. node --test: 5 passed.",
      workspace: ws([srcChange(featureSrc)], [hostRun("node --test", "fixed_nodetest.out", "final")]),
    }));
    expect(r.verification?.taskKind).toBe("feature");
    expect(status(r, "AC1")).not.toBe("PROVED");
    expect(r.verification?.status).not.toBe("verified");
  });

  it("a test-run criterion in a task that changes no code is unchanged (no verifier, fails closed)", () => {
    const r = evaluateWithPappy(input(["Tests are run and all pass"], {
      task: "Run the tests and report the results.",
      toolEvents: [cmd("node --test", "fixed_nodetest.out")],
      outputText: "node --test: 5 passed, 0 failed.",
      workspace: ws([], [hostRun("node --test", "fixed_nodetest.out", "final")]),
    }));
    expect(status(r, "AC1")).not.toBe("PROVED");
  });
});
