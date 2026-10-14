/**
 * Persisted form of a stopped run, and what every consumer makes of it.
 *
 * Invariant (1.7.0): a run the user stopped, or that the app lost, is stored
 * as `status: "FAIL"` with `stoppedBecause: "cancelled" | "interrupted"` and,
 * unless Pappy had already judged it, no verdict. `status` alone never says
 * "failed"; the pair does. Consumers must read the pair:
 *   - the Moonshiner export never emits a stopped run, as a positive or a
 *     negative example, whatever verdict is requested;
 *   - a completed FAIL (stoppedBecause done/error/...) is still a negative
 *     example on explicit request;
 *   - the pass-rate statistic counts verdicts, so a stopped run with no
 *     verdict lowers it like any unjudged run (documented, not changed).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTrainingData } from "./exportTrainingData.js";
import { SqliteStore } from "../persistence/sqliteStore.js";
import type { OrcaStore, RunRecord } from "../persistence/types.js";

const ELIGIBLE = "training_eligibility=eligible evidence=verified";

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: over.id ?? "r", createdAt: "2026-10-13T00:00:00.000Z", intent: "Fix the bug", role: "debugger",
    status: "FAIL", iterationCount: 2, repairPasses: 0, outputText: "I ran the tests, changed src/parse.js, and ran them again; the result is recorded in the tool receipts below.", summary: ELIGIBLE,
    brainDecision: JSON.stringify({ routing: "direct", role: "debugger" }),
    ...over,
  } as RunRecord;
}

function storeWith(runs: RunRecord[]): OrcaStore {
  return {
    saveRun() {}, getRecentRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null,
    getRunThoughts: () => [], getRunToolEvents: () => [], deleteRun() {}, searchRuns: () => [],
    getStats: () => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 }), close() {},
  } as unknown as OrcaStore;
}

async function exportCounts(runs: RunRecord[], verdict?: "PASS" | "WARN" | "FAIL") {
  const dir = mkdtempSync(join(tmpdir(), "orca-stopped-export-"));
  try {
    const out = join(dir, "out.jsonl");
    const summary = await exportTrainingData(storeWith(runs), { outputPath: out, ...(verdict ? { verdict } : {}) } as never);
    let lines: string[] = [];
    try { lines = readFileSync(out, "utf8").trim().split("\n").filter(Boolean); } catch { lines = []; }
    return { exported: summary.exported, skipReasons: summary.skipReasons ?? {}, ids: lines.map((l) => JSON.parse(l).id ?? JSON.parse(l).runId ?? null) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stopped runs in the training export", () => {
  it("a cancelled run with no verdict is skipped as stopped, not as a wrong verdict", async () => {
    const r = await exportCounts([run({ id: "c1", stoppedBecause: "cancelled" })]);
    expect(r.exported).toBe(0);
    expect(r.skipReasons).toEqual({ "stopped_before_completion:cancelled": 1 });
  });

  it("a cancelled run that Pappy had already judged PASS is still not a positive example", async () => {
    const r = await exportCounts([run({ id: "c2", stoppedBecause: "cancelled", status: "FAIL", verdict: "PASS", confidence: 0.9 })]);
    expect(r.exported).toBe(0);
    expect(r.skipReasons["stopped_before_completion:cancelled"]).toBe(1);
  });

  it("a cancelled run with a FAIL verdict is not a negative example either, even on an explicit FAIL export", async () => {
    const r = await exportCounts([run({ id: "c3", stoppedBecause: "cancelled", verdict: "FAIL" })], "FAIL");
    expect(r.exported).toBe(0);
    expect(r.skipReasons["stopped_before_completion:cancelled"]).toBe(1);
  });

  it("an interrupted run (process died) is skipped the same way", async () => {
    const r = await exportCounts([run({ id: "i1", stoppedBecause: "interrupted", verdict: "PASS" })]);
    expect(r.exported).toBe(0);
    expect(r.skipReasons).toEqual({ "stopped_before_completion:interrupted": 1 });
  });

  it("a completed FAIL (stoppedBecause done) remains an explicit negative example; a completed PASS remains positive", async () => {
    const done = [
      run({ id: "f1", stoppedBecause: "done", verdict: "FAIL" }),
      run({ id: "p1", stoppedBecause: "done", status: "SUCCESS", verdict: "PASS", confidence: 0.95 }),
      run({ id: "c4", stoppedBecause: "cancelled", verdict: "PASS", confidence: 0.95 }),
    ];
    const positive = await exportCounts(done);
    expect(positive.exported).toBe(2); // the PASS worker record plus its Brain routing record
    expect(positive.skipReasons).toEqual({ "stopped_before_completion:cancelled": 1, wrong_verdict: 1 });
    const negative = await exportCounts(done, "FAIL");
    expect(negative.exported).toBe(1);
    expect(negative.skipReasons).toEqual({ "stopped_before_completion:cancelled": 1, wrong_verdict: 1 });
  });
});

describe("persisted form of a stopped run (SqliteStore)", () => {
  it("round-trips status FAIL + stoppedBecause cancelled/interrupted with no verdict, and the pass rate counts verdicts only", async () => {
    const store = new SqliteStore(":memory:");
    await new Promise((r) => setTimeout(r, 150));
    try {
      await store.saveRun(run({ id: "c", stoppedBecause: "cancelled" }), [], [], []);
      await store.saveRun(run({ id: "i", stoppedBecause: "interrupted" }), [], [], []);
      await store.saveRun(run({ id: "p", stoppedBecause: "done", status: "SUCCESS", verdict: "PASS" }), [], [], []);
      await store.saveRun(run({ id: "f", stoppedBecause: "done", verdict: "FAIL" }), [], [], []);
      const c = (await store.getRun("c"))!;
      const i = (await store.getRun("i"))!;
      const f = (await store.getRun("f"))!;
      expect(c).toMatchObject({ status: "FAIL", stoppedBecause: "cancelled" });
      expect(c.verdict ?? undefined).toBeUndefined();
      expect(i).toMatchObject({ status: "FAIL", stoppedBecause: "interrupted" });
      expect(f).toMatchObject({ status: "FAIL", stoppedBecause: "done", verdict: "FAIL" });
      // status alone cannot tell c, i and f apart; stoppedBecause can.
      expect(new Set([c.status, i.status, f.status]).size).toBe(1);
      expect(new Set([c.stoppedBecause, i.stoppedBecause, f.stoppedBecause]).size).toBe(3);
      const stats = await store.getStats();
      expect(stats.totalRuns).toBe(4);
      expect(stats.passRate).toBeCloseTo(0.25); // one PASS verdict of four runs; stopped runs are unjudged, not failed
    } finally {
      store.close();
    }
  });
});
