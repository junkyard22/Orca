/**
 * The host record and the provenance check (1.7.0, after live rehearsal A6:
 * the repair worker reported that "the fix was already in place — someone had
 * corrected parse.js in a prior session", when the task's own first pass had
 * made the change).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEvidence } from "@clawde/pappy-core";
import { buildHostRecord, checkProvenance, correctProvenance, parseTestCounts, type PassLogEntry } from "./hostRecord.js";
import { createOrcaRuntime } from "./runtime.js";
import { createPappyPort } from "./adapters/pappyPort.js";
import type { MaestroPort, OrcaRunCtx, OrcaTaskSpec, PappyPort } from "./types.js";

const FAILING = "[Exit code 1]\nℹ tests 13\nℹ pass 11\nℹ fail 2\n";
const PASSING = "ℹ tests 13\nℹ pass 13\nℹ fail 0\n";
const evidence = (over: Partial<WorkspaceEvidence> = {}): WorkspaceEvidence => ({
  available: true, provenance: "runtime-snapshot",
  changes: [{ path: "src/parse.js", status: "modified", kind: "source", writers: ["debugger"] }],
  testRuns: [
    { tool: "run_command", command: "npm test", ok: false, exitCode: 1, output: FAILING, fullSuite: true, sourceState: "baseline" },
  ],
  ...over,
});
const write = (path: string) => ({ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path } });
const firstPassWrote: PassLogEntry[] = [{ pass: 1, label: "first pass", role: "debugger", toolEvents: [write("src/parse.js")] }];
const thenRepair: PassLogEntry[] = [...firstPassWrote, { pass: 2, label: "repair pass 1", role: "debugger", toolEvents: [{ tool: "run_command", ok: true, summary: "ok", raw: { command: "npm test 2>&1" } }] }];

describe("host record", () => {
  it("attributes a change to the pass that wrote it, lists test runs by source state, and says when the current source is untested", () => {
    const record = buildHostRecord(evidence(), firstPassWrote);
    expect(record.changes).toEqual([expect.objectContaining({ path: "src/parse.js", attribution: "this_task", passes: ["first pass"] })]);
    expect(record.text).toMatch(/src\/parse\.js \(modified\) — changed by this task in the first pass \(debugger\)/);
    expect(record.text).toMatch(/`npm test` on the task-start source: failed \(11 passed, 2 failed\)/);
    expect(record.text).toMatch(/No test has run on the current source/);
    expect(record.finalSourceTested).toBe(false);
  });

  it("a file already modified before the task is part of the baseline, not a change of this task", () => {
    const record = buildHostRecord(evidence({ changes: [] }), []);
    expect(record.text).toMatch(/No file in the workspace has changed since the task started/);
  });

  it("an external change during the task (no recorded write) is origin unknown — never attributed", () => {
    const record = buildHostRecord(evidence({ changes: [{ path: "src/other.js", status: "modified", kind: "source" }] }), firstPassWrote);
    expect(record.changes[0]).toMatchObject({ attribution: "unknown", passes: [] });
    expect(record.text).toMatch(/src\/other\.js \(modified\) — changed during the task, but no write by this task was recorded for it: its origin is unknown/);
  });

  it("a contested write is not attributed to either worker", () => {
    const record = buildHostRecord(evidence({ contested: [{ path: "src/parse.js", writers: ["a", "b"] }] }), firstPassWrote);
    expect(record.changes[0]?.attribution).toBe("contested");
  });

  it("no evidence: says it cannot tell, claims nothing", () => {
    const record = buildHostRecord(undefined, firstPassWrote);
    expect(record.available).toBe(false);
    expect(checkProvenance("Someone else fixed it.", record).contradictions).toEqual([]);
  });

  it("reads common test summaries", () => {
    expect(parseTestCounts(PASSING)).toEqual({ passed: 13, failed: 0 });
    expect(parseTestCounts("# tests 2\n# pass 1\n# fail 1\n")).toEqual({ passed: 1, failed: 1 });
    expect(parseTestCounts("Tests:       2 failed, 11 passed, 13 total")).toEqual({ passed: 11, failed: 2 });
  });
});

describe("provenance check", () => {
  const verified = buildHostRecord(evidence({ testRuns: [...evidence().testRuns!, { tool: "run_command", command: "npm test 2>&1", ok: true, exitCode: 0, output: PASSING, fullSuite: true, sourceState: "final" }] }), thenRepair);

  it("A6: 'already in place — someone corrected it in a prior session' contradicts the record and is corrected from it", () => {
    const text = "All 13 tests pass. Turns out the fix was already in place — someone had corrected parse.js in a prior session, so nothing needed changing.";
    const { text: corrected, check } = correctProvenance(text, verified);
    expect(check.contradictions).toHaveLength(1);
    expect(corrected).toMatch(/Correction from Orca's records: src\/parse\.js was changed by this task in the first pass; `npm test 2>&1` ran on the final source: passed \(13 passed, 0 failed\)\./);
    expect(correctProvenance(corrected, verified).text).toBe(corrected); // appended once
  });

  it("a repair pass that claims an earlier pass's edit as its own is corrected", () => {
    const check = checkProvenance("I modified src/parse.js to return 0 for empty input and ran the tests: 13 passed.", verified);
    expect(check.contradictions[0]).toMatch(/credits the repair pass 1 with the change, but the host recorded it in the first pass/);
  });

  it("an accurate account is left alone", () => {
    expect(checkProvenance("The first pass changed src/parse.js; I re-ran npm test on the current source: 13 passed, 0 failed.", verified).contradictions).toEqual([]);
    const single = buildHostRecord(evidence(), firstPassWrote);
    expect(checkProvenance("I changed src/parse.js to return 0 for empty input.", single).contradictions).toEqual([]);
  });

  it("a failed task with no source change cannot claim one", () => {
    const none = buildHostRecord(evidence({ changes: [] }), [{ pass: 1, label: "first pass", toolEvents: [] }]);
    expect(checkProvenance("I fixed src/parse.js.", none).contradictions[0]).toMatch(/the host recorded no change/);
  });

  it("a change of unknown origin is not credited to anyone, and the correction says so", () => {
    const unknown = buildHostRecord(evidence({ changes: [{ path: "src/other.js", status: "modified", kind: "source" }] }), [{ pass: 1, label: "first pass", toolEvents: [] }]);
    const { text, check } = correctProvenance("Someone else had changed src/other.js in a previous session.", unknown);
    expect(check.contradictions[0]).toMatch(/cannot establish who changed src\/other\.js/);
    expect(text).toMatch(/src\/other\.js also changed, but Orca cannot say who changed it/);
  });
});

describe("provenance statements are checked against the record, sentence by sentence (A7 false positive)", () => {
  // A7: the first pass wrote src/parse.js; the repair pass only re-ran the tests.
  const a7 = buildHostRecord(evidence({ testRuns: [...evidence().testRuns!, { tool: "run_command", command: "npm test", ok: true, exitCode: 0, output: PASSING, fullSuite: true, sourceState: "final" }] }), thenRepair);
  const clean = (t: string) => checkProvenance(t, a7).contradictions;

  it("accurate references to an earlier pass of this task are not contradictions", () => {
    expect(clean("I fixed it in the first pass.")).toEqual([]);
    expect(clean("The fix was already applied earlier in this task.")).toEqual([]);
    expect(clean("The previous worker pass made this change.")).toEqual([]);
    // A7's repair worker, verbatim.
    expect(clean("ROOT CAUSE: The previously fixed src/parse.js already contains the correct implementation. AFFECTED LOCATION: src/parse.js (modified in prior pass). FIX: Already applied in the first pass of this task; no additional code changes were needed.")).toEqual([]);
  });

  it("claims of an origin outside the task, or of unknown origin, are contradicted by the record", () => {
    expect(clean("The file was fixed before this session.")[0]).toMatch(/came from outside this task/);
    expect(clean("Somebody else fixed the file.")[0]).toMatch(/came from outside this task/);
    expect(clean("The origin of this change is unknown.")[0]).toMatch(/origin is unknown, but the host recorded this task writing src\/parse\.js/);
    expect(clean("The fix was already in place, so nothing needed changing.")[0]).toMatch(/already present before the task/);
  });

  it("an in-task claim that names the wrong pass is contradicted", () => {
    const repairWrote = buildHostRecord(evidence(), [{ pass: 1, label: "first pass", toolEvents: [] }, { pass: 2, label: "repair pass 1", toolEvents: [write("src/parse.js")] }]);
    expect(checkProvenance("I fixed it in the first pass.", repairWrote).contradictions[0]).toMatch(/credits the first pass with the change, but the host recorded it in the repair pass 1/);
  });

  it("quoted text is not read as a claim", () => {
    expect(clean('The request said "the fix was already in place in a prior session"; that is not what happened here.')).toEqual([]);
    expect(clean("The worker printed `already fixed` in the log.")).toEqual([]);
  });

  it("with no record of who changed the file, a named author is not accepted and none is invented", () => {
    const unknown = buildHostRecord(evidence({ changes: [{ path: "src/other.js", status: "modified", kind: "source" }] }), [{ pass: 1, label: "first pass", toolEvents: [] }]);
    expect(checkProvenance("Somebody else fixed src/other.js.", unknown).contradictions[0]).toMatch(/cannot establish who changed src\/other\.js/);
    expect(checkProvenance("The origin of the change to src/other.js is unknown.", unknown).contradictions).toEqual([]);
  });
});

describe("repair pass gets the host record; the final explanation is checked", () => {
  const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });

  it("A6 in miniature: pass 1 fixes but does not re-test → the repair worker is told what pass 1 did and that only verification is outstanding; its false 'prior session' claim is corrected in the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-hostrecord-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
    writeFileSync(join(root, "a.js"), "module.exports = 1;\n");
    writeFileSync(join(root, "a.test.js"), "require('node:test')('a', () => {});\n");
    const specs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: async (task, ctx: OrcaRunCtx) => {
        specs.push(task);
        if (task.intent !== "repair") {
          ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
          ctx.recordTrace?.("tool.result", { tool: "run_command", ok: false, output: FAILING });
          ctx.recordTrace?.("tool.call", { tool: "write_file", input: { path: "a.js", content: "module.exports = 2;\n" } });
          writeFileSync(join(root, "a.js"), "module.exports = 2;\n");
          ctx.recordTrace?.("tool.result", { tool: "write_file", ok: true, output: "Wrote" });
          return { outputText: "Changed a.js to export 2.", toolEvents: [
            { tool: "run_command", ok: false, summary: "run_command: failed - [Exit code 1]", raw: { command: "npm test", _outputForProof: FAILING } },
            { tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "a.js", content: "module.exports = 2;\n" } },
          ] };
        }
        ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test 2>&1" } });
        ctx.recordTrace?.("tool.result", { tool: "run_command", ok: true, output: PASSING });
        return { outputText: "All tests pass. The fix was already in place — someone had corrected a.js in a prior session, so nothing needed changing.", toolEvents: [
          { tool: "run_command", ok: true, summary: "run_command: ok", raw: { command: "npm test 2>&1", _outputForProof: PASSING } },
        ] };
      },
    };
    const real = createPappyPort();
    const pappy: PappyPort = { evaluate: (input) => real.evaluate(input) };
    const spec = { originalUserMessage: "Fix the failing test in a.js and run the tests.", intent: "fix", goals: ["The failing test in a.js is fixed", "Tests are run and all pass"], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
    const result = await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, workspaceRoot: root, maxRepairPasses: 1 }).executeTask(spec);

    const repair = specs[1]!;
    expect(repair.originalUserMessage).toMatch(/a\.js \(modified\) — changed by this task in the first pass/);
    expect(repair.originalUserMessage).toMatch(/No test has run on the current source/);
    expect(repair.originalUserMessage).toMatch(/Outstanding: verification only/);
    expect(repair.originalUserMessage).toMatch(/do not describe it as pre-existing or as someone else's work/);
    expect((repair.context as { repair: { hostRecord: { sourceChangeRequired: boolean } } }).repair.hostRecord.sourceChangeRequired).toBe(false);

    expect(result.provenance?.contradictions).toHaveLength(1);
    expect(result.userFacingText).toMatch(/Correction from Orca's records: a\.js was changed by this task in the first pass; `npm test 2>&1` ran on the final source: passed/);
    expect(result.hostRecord?.changes[0]).toMatchObject({ path: "a.js", attribution: "this_task", passes: ["first pass"] });
  });
});
