import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportTrainingData } from "./exportTrainingData.js";
import type { OrcaStore, RunRecord, ThoughtRecord, ToolEvent } from "../persistence/types.js";

const fakeAwsAccessKey = ["AKIA", "1234567890", "ABCDEF"].join("");
const fakeEnvSecretAssignment = ["API_KEY", "=", "supersecret", "value12345"].join("");

class MemoryStore implements OrcaStore {
  constructor(
    private readonly runs: RunRecord[],
    private readonly eventsByRun: Record<string, ToolEvent[]> = {},
  ) {}

  saveRun(): void {}
  getRecentRuns(): RunRecord[] {
    return this.runs;
  }
  getRun(id: string): RunRecord | null {
    return this.runs.find((run) => run.id === id) ?? null;
  }
  getRunThoughts(): ThoughtRecord[] {
    return [];
  }
  getRunToolEvents(runId: string): ToolEvent[] {
    return this.eventsByRun[runId] ?? [];
  }
  deleteRun(): void {}
  searchRuns(): RunRecord[] {
    return [];
  }
  getStats() {
    return {
      totalRuns: this.runs.length,
      passRate: 1,
      avgIterations: 1,
      totalCostUsd: 0,
    };
  }
  close(): void {}
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    createdAt: "2026-06-26T12:00:00.000Z",
    intent: "Implement a safe feature",
    role: "engineer",
    status: "SUCCESS",
    verdict: "PASS",
    iterationCount: 1,
    repairPasses: 0,
    outputText: "Implemented the feature with validation and tests. The output is long enough for export.",
    // Verified against host evidence and eligible, so the filters under test are the ones that decide.
    summary: "verdict=PASS no_issues training_eligibility=eligible evidence=verified test_evidence=true review_independence=independent review_fallback=false",
    ...overrides,
  };
}

describe("exportTrainingData training-safety filtering", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function outputPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "orca-export-test-"));
    tempDirs.push(dir);
    return join(dir, "training.jsonl");
  }

  it("does not export PASS runs with embedded AWS keys in output", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({
        outputText:
          `Implemented credential loading but accidentally included ${fakeAwsAccessKey} in the example output for verification.`,
      }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });

    expect(summary.exported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.skipReasons["unsafe_artifact:aws_access_key"]).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("does not export WARN runs with .env-style secrets in tool evidence", async () => {
    const out = outputPath();
    const store = new MemoryStore(
      [
        makeRun({
          id: "run-warn",
          verdict: "WARN",
          outputText:
            "Completed with a warning after recording the environment sample. The response is long enough for export.",
        }),
      ],
      {
        "run-warn": [
          {
            runId: "run-warn",
            tool: "read_file",
            ok: true,
            summary: `Read .env example: ${fakeEnvSecretAssignment}`,
          },
        ],
      },
    );

    const summary = await exportTrainingData(store, { outputPath: out, verdict: "WARN" });

    expect(summary.exported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.skipReasons["unsafe_artifact:env_secret_assignment"]).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("does not export a PASS run that Pappy marked accepted-but-not-trainable", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({
        id: "self-reviewed-run",
        summary: "verdict=PASS no_issues training_eligibility=accepted_but_not_trainable review_independence=self_review review_fallback=true",
      }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });

    expect(summary.exported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.skipReasons["pappy_training_eligibility:accepted_but_not_trainable"]).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("does not export a run whose verifier independence is unresolved", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({
        id: "unknown-review-run",
        summary: "verdict=PASS no_issues training_eligibility=needs_human_review review_independence=unknown review_fallback=true",
      }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });

    expect(summary.exported).toBe(0);
    expect(summary.skipReasons["pappy_training_eligibility:needs_human_review"]).toBe(1);
  });

  it("exports safe PASS runs that Pappy verified against host evidence", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({
        id: "safe-run",
        summary: "verdict=PASS no_issues training_eligibility=eligible evidence=verified test_evidence=true review_independence=independent review_fallback=false",
      }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });
    const lines = readFileSync(out, "utf8").trim().split("\n");

    expect(summary.exported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)["metadata"]["taskId"]).toBe("safe-run");
  });

  it("does not trust an eligibility tag that no evidence backs", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      // The eligibility word alone, as an older PappyPort wrote it: no evidence tag.
      makeRun({ id: "untagged-evidence", summary: "verdict=PASS no_issues training_eligibility=eligible review_independence=independent review_fallback=false" }),
      // Says eligible, but the runtime captured no workspace evidence.
      makeRun({ id: "no-evidence", summary: "verdict=PASS no_issues training_eligibility=eligible evidence=not_applicable test_evidence=false review_independence=independent review_fallback=false" }),
      makeRun({ id: "evidence-unavailable", summary: "verdict=PASS no_issues training_eligibility=eligible evidence=unavailable test_evidence=false review_independence=independent review_fallback=false" }),
      makeRun({ id: "evidence-insufficient", summary: "verdict=PASS no_issues training_eligibility=eligible evidence=unverified test_evidence=false review_independence=independent review_fallback=false" }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });

    expect(summary.exported).toBe(0);
    expect(summary.skipReasons["pappy_evidence:evidence_tag_missing"]).toBe(1);
    expect(summary.skipReasons["pappy_evidence:not_applicable"]).toBe(1);
    expect(summary.skipReasons["pappy_evidence:unavailable"]).toBe(1);
    expect(summary.skipReasons["pappy_evidence:unverified"]).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("never exports a run with no recorded eligibility decision (legacy rows, runs that skipped Pappy)", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({ id: "legacy-row", summary: undefined }),
      makeRun({ id: "pappy-skipped", summary: "ok" }),
      makeRun({ id: "old-format", summary: "verdict=PASS no_issues" }),
    ]);

    const summary = await exportTrainingData(store, { outputPath: out });

    expect(summary.exported).toBe(0);
    expect(summary.skipReasons["pappy_training_eligibility:missing"]).toBe(3);
    expect(readFileSync(out, "utf8")).toBe("");
  });

  it("keeps rejected and review-pending runs out, and the Brain record with them", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({ id: "fabricated", brainDecision: JSON.stringify({ routing: "direct", role: "engineer", reason: "code change" }), summary: "verdict=FAIL 2xHIGH training_eligibility=rejected evidence=contradicted test_evidence=false review_independence=independent review_fallback=false", verdict: "FAIL" }),
      makeRun({ id: "manipulated", brainDecision: JSON.stringify({ routing: "direct", role: "engineer", reason: "code change" }), summary: "verdict=PASS 1xLOW training_eligibility=rejected evidence=verified test_evidence=true review_independence=independent review_fallback=false" }),
      makeRun({ id: "review", brainDecision: JSON.stringify({ routing: "direct", role: "engineer", reason: "code change" }), summary: "verdict=WARN 1xMEDIUM training_eligibility=needs_human_review evidence=verified test_evidence=true review_independence=independent review_fallback=false", verdict: "WARN" }),
    ]);

    const passSummary = await exportTrainingData(store, { outputPath: out });
    const warnSummary = await exportTrainingData(store, { outputPath: out, verdict: "WARN" });
    const failSummary = await exportTrainingData(store, { outputPath: out, verdict: "FAIL" });

    expect(passSummary.exported + warnSummary.exported + failSummary.exported).toBe(0);
    expect(passSummary.skipReasons["pappy_training_eligibility:rejected"]).toBe(1);
    expect(warnSummary.skipReasons["pappy_training_eligibility:needs_human_review"]).toBe(1);
    expect(failSummary.skipReasons["pappy_training_eligibility:rejected"]).toBe(1);
  });

  it("an honest, evidence-confirmed failure is eligible but stays out of the default PASS export; it is exported only when FAIL runs are requested", async () => {
    const out = outputPath();
    const store = new MemoryStore([
      makeRun({
        id: "honest-failure",
        verdict: "FAIL",
        status: "FAIL",
        outputText: "I ran the test suite: 1 of 8 tests fails. I could not find a safe change and did not modify any files.",
        summary: "verdict=FAIL 1xHIGH training_eligibility=eligible evidence=contradicted test_evidence=false review_independence=independent review_fallback=false",
      }),
    ]);

    const byDefault = await exportTrainingData(store, { outputPath: out });
    expect(byDefault.exported).toBe(0);
    expect(byDefault.skipReasons["wrong_verdict"]).toBe(1);

    const failures = await exportTrainingData(store, { outputPath: out, verdict: "FAIL" });
    expect(failures.exported).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8").trim())["metadata"]["verdict"]).toBe("FAIL");
  });
});
