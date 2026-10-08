import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPappyPort } from "./adapters/pappyPort.js";
import { createOrcaRuntime } from "./runtime.js";
import type { PappyResult } from "@clawde/pappy-core";
import type { MaestroPort, OrcaTaskSpec } from "./types.js";
import { captureWorkspaceSnapshot, createWorkspaceEvidenceCollector, diffWorkspaceSnapshots } from "./workspaceSnapshot.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "pappy-core", "src", "checks", "__fixtures__", "find-fix");
const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A copy of the Summit demo app (real sources) in a temp workspace. */
function demoWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-snapshot-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "room-booking", type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "ISSUE.md"), fx("ISSUE.md"));
  writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt"));
  writeFileSync(join(root, "test", "bookings.test.js"), fx("bookings.test.base.txt"));
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "ignored");
  return root;
}

describe("workspace snapshots", () => {
  it("captures text files, skips dependency folders, and reads the test command", async () => {
    const snap = await captureWorkspaceSnapshot(demoWorkspace());
    expect(snap.available).toBe(true);
    expect([...snap.files.keys()].sort()).toEqual(["ISSUE.md", "package.json", "src/bookings.js", "test/bookings.test.js"]);
    expect(snap.testCommand).toBe("node --test");
  });

  it("reports modified, added and deleted files — and nothing for identical rewrites", async () => {
    const root = demoWorkspace();
    const before = await captureWorkspaceSnapshot(root);
    writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt")); // identical rewrite
    writeFileSync(join(root, "test", "bookings.test.js"), fx("bookings.test.tamper.txt"));
    writeFileSync(join(root, "NOTES.md"), "new");
    rmSync(join(root, "ISSUE.md"));
    const diff = diffWorkspaceSnapshots(before, await captureWorkspaceSnapshot(root));
    expect(diff.changes.map((c) => `${c.status}:${c.path}`)).toEqual(["deleted:ISSUE.md", "added:NOTES.md", "modified:test/bookings.test.js"]);
    expect(diff.changes.find((c) => c.path === "test/bookings.test.js")?.before).toBe(fx("bookings.test.base.txt"));
  });

  it("is unavailable (not silently partial) when the workspace exceeds the limits", async () => {
    const snap = await captureWorkspaceSnapshot(demoWorkspace(), { maxFiles: 2, maxFileBytes: 1_000_000, maxTotalBytes: 1_000_000 });
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/more than 2 files/);
  });

  it("compares each collection with the task-start baseline", async () => {
    const root = demoWorkspace();
    const collector = createWorkspaceEvidenceCollector(root);
    await collector.ready;
    writeFileSync(join(root, "src", "bookings.js"), fx("bookings.fixed.txt"));
    expect((await collector.collect()).changes.map((c) => c.path)).toEqual(["src/bookings.js"]);
    writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt"));
    expect((await collector.collect()).changes).toEqual([]);
  });
});

describe("runtime → Pappy with workspace evidence (end to end, real Pappy)", () => {
  const TASK =
    "Users reported a bug in this meeting-room booking app (see ISSUE.md). Investigate the repository, identify the root cause, " +
    "and implement the smallest correct fix in the source code. Then run the project's test suite and verify that the reported " +
    "problem is actually resolved. Do not change unrelated behavior or modify the existing tests.";
  const spec = (): OrcaTaskSpec => ({ originalUserMessage: TASK, intent: TASK, goals: [TASK] } as OrcaTaskSpec);
  const testRun = (fixture: string) => {
    const output = fx(fixture);
    const ok = !output.startsWith("[Exit code");
    return { tool: "run_command", ok, summary: ok ? "run_command: ok" : "run_command: failed", raw: { command: "npm test", _outputForProof: output } };
  };

  /** Runs the real runtime + real Pappy; returns Pappy's verdict on the run. */
  async function run(root: string, worker: () => { toolEvents: unknown[]; filesChanged?: unknown[]; outputText: string }) {
    const maestro: MaestroPort = {
      run: async () => {
        const r = worker();
        return { summary: "debugger agent", doneCriteria: [TASK], ...r } as never;
      },
    };
    const real = createPappyPort();
    const verdicts: PappyResult[] = [];
    const pappy = { evaluate: (input: Parameters<typeof real.evaluate>[0]) => { const r = real.evaluate(input); verdicts.push(r); return r; } };
    const runtime = createOrcaRuntime({ maestro, pappy, llm: { complete: async () => ({ text: "" }) } as never, workspaceRoot: root, maxRepairPasses: 0 });
    const result = await runtime.executeTask(spec());
    return { result, qc: verdicts[verdicts.length - 1]! };
  }

  it("verifies a real source fix with a passing full suite", async () => {
    const root = demoWorkspace();
    const { result, qc } = await run(root, () => {
      writeFileSync(join(root, "src", "bookings.js"), fx("bookings.fixed.txt"));
      return {
        toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "src/bookings.js", content: fx("bookings.fixed.txt"), _contentForDiff: fx("bookings.fixed.txt") } }, testRun("fixed_npmtest.out")],
        outputText: "Root cause: overlaps() used <= so touching meetings conflicted. Changed to < in src/bookings.js. npm test: 8 passed, 0 failed.",
      };
    });
    expect(qc.verdict).toBe("PASS");
    expect(result.status).toBe("SUCCESS");
  });

  it("rejects an unchanged rewrite even though the agent reported writing the file", async () => {
    const root = demoWorkspace();
    const { result, qc } = await run(root, () => {
      writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt"));
      return {
        toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "src/bookings.js", content: fx("bookings.base.txt"), _contentForDiff: fx("bookings.base.txt") } }, testRun("base_npmtest.out")],
        outputText: "Fixed the overlap logic in src/bookings.js.",
      };
    });
    expect(qc.verdict).toBe("FAIL");
    expect(result.status).toBe("FAIL");
    expect(qc.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["FIX_SOURCE_CHANGE_MISSING", "FIX_TESTS_FAILING"]));
  });

  it("detects a deleted test even when the agent never reported touching the test file", async () => {
    const root = demoWorkspace();
    const { result, qc } = await run(root, () => {
      writeFileSync(join(root, "test", "bookings.test.js"), fx("bookings.test.tamper.txt")); // e.g. via a shell command
      return { toolEvents: [testRun("tamper_npmtest.out")], outputText: "Fixed. npm test: 7 passed, 0 failed." };
    });
    expect(qc.verdict).toBe("FAIL");
    expect(result.status).toBe("FAIL");
    expect(qc.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["TEST_FILES_MODIFIED_WEAKENED", "TEST_EDIT_PROHIBITED"]));
  });
});
