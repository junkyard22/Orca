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

  it("exports safe PASS runs", async () => {
    const out = outputPath();
    const store = new MemoryStore([makeRun({ id: "safe-run" })]);

    const summary = await exportTrainingData(store, { outputPath: out });
    const lines = readFileSync(out, "utf8").trim().split("\n");

    expect(summary.exported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)["metadata"]["taskId"]).toBe("safe-run");
  });
});
