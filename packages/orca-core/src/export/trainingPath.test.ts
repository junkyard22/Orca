/**
 * The Moonshiner training path, end to end, for an honestly reported failure
 * that the evidence contradicts: the real Pappy port decides eligibility and
 * tags the summary; the real export decides what leaves the store and how it
 * is labelled. A contradicted run must never enter the positive (PASS)
 * export, and when FAIL runs are requested on purpose it must be labelled as
 * a negative example — score 0, outcome honest_failure — with no PASS-tagged
 * Brain record beside it.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PappyInput } from "@clawde/pappy-core";
import { createPappyPort } from "../adapters/pappyPort.js";
import { exportTrainingData } from "./exportTrainingData.js";
import type { OrcaStore, RunRecord } from "../persistence/types.js";

const TASK = "Fix the bug in src/parse.js: parse('') throws instead of returning 0. Run the tests.";
const FAIL_OUT = "[Exit code 1]\nnot ok 1 - parse handles empty input\n# tests 1\n# pass 0\n# fail 1";

/** A worker that tried, could not fix anything, changed no file, and said so plainly. */
const honestFailure: PappyInput = {
  task: TASK,
  goals: ["`parse` must return 0 for empty input instead of throwing"],
  outputText: "I ran npm test: 1 failed (parse handles empty input). I could not find a safe change for parse, so no files were modified and the failure remains.",
  filesChanged: [],
  toolEvents: [{ tool: "run_command", ok: false, summary: "run_command: failed - Command failed with exit code 1", raw: { command: "npm test", _outputForProof: FAIL_OUT, _exitCodeForProof: 1 } }],
  metadata: { stoppedBecause: "done" },
  constraints: {},
  workspace: { available: true, provenance: "runtime-snapshot", baselineFiles: 3, changes: [], testCommand: "node --test", testRuns: [{ tool: "run_command", command: "npm test", ok: false, exitCode: 1, output: FAIL_OUT, fullSuite: true, sourceState: "baseline" }] },
};

function storeWith(runs: RunRecord[]): OrcaStore {
  return {
    saveRun() {}, getRecentRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null,
    getRunThoughts: () => [], getRunToolEvents: () => [], deleteRun() {}, searchRuns: () => [],
    getStats: () => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 }), close() {},
  } as unknown as OrcaStore;
}

describe("training path for an honest, contradicted failure", () => {
  it("Pappy: FAIL verdict, contradicted evidence, eligible (honest); the export keeps it out of the positive set and labels it negative when asked for", async () => {
    const result = createPappyPort().evaluate(honestFailure);
    expect(result.verdict).toBe("FAIL");
    expect(result.verification?.status).toBe("contradicted");
    expect(result.trainingEligibility).toBe("eligible");
    expect(result.internalSummary).toMatch(/training_eligibility=eligible/);
    expect(result.internalSummary).toMatch(/evidence=contradicted/);

    const run = {
      id: "honest-1", createdAt: "2026-10-13T00:00:00.000Z", intent: TASK, status: "FAIL", verdict: result.verdict, role: "debugger",
      outputText: honestFailure.outputText, summary: result.internalSummary, iterations: 2, repairPasses: 0, brainDecision: JSON.stringify({ routing: "direct", role: "debugger", done_criteria: ["parse('') returns 0"] }),
    } as unknown as RunRecord;
    const store = storeWith([run]);
    const dir = mkdtempSync(join(tmpdir(), "orca-training-path-"));
    try {
      // Default export = positive examples only: the honest failure is excluded for its verdict, not by accident of a tag.
      const positive = await exportTrainingData(store, { outputPath: join(dir, "pass.jsonl") } as never);
      expect(positive.exported).toBe(0);
      expect(positive.skipReasons?.["wrong_verdict"] ?? (positive as { skipped?: number }).skipped).toBeTruthy();

      // Explicit FAIL export = negative examples: labelled as such, score 0, no PASS-tagged Brain record.
      const negative = await exportTrainingData(store, { outputPath: join(dir, "fail.jsonl"), verdict: "FAIL" } as never);
      expect(negative.exported).toBe(1);
      const records = readFileSync(join(dir, "fail.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ role: "debugger", score: 0, metadata: { verdict: "FAIL", outcome: "honest_failure" } });
      expect(records.some((r) => r.role === "brain")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a contradicted run can never be PASS: every contradicted downgrade travels with a HIGH or CRITICAL issue", () => {
    // The same input with a success claim: contradicted + claims → rejected, verdict FAIL.
    const claiming = createPappyPort().evaluate({ ...honestFailure, outputText: "Fixed parse so it returns 0 for empty input. All tests pass." });
    expect(claiming.verdict).toBe("FAIL");
    expect(claiming.verification?.status).toBe("contradicted");
    expect(claiming.trainingEligibility).toBe("rejected");
    expect(claiming.issues.some((i) => i.severity === "HIGH" || i.severity === "CRITICAL")).toBe(true);
  });
});
