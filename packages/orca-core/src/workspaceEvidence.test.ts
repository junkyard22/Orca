import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrcaRuntime } from "./runtime.js";
import type { MaestroPort, PappyPort, OrcaTaskSpec, OrcaRunCtx } from "./types.js";
import {
  DEFAULT_EVIDENCE_LIMITS,
  captureWorkspaceInventory,
  createWorkspaceEvidenceCollector,
  diffWorkspaceInventories,
} from "./workspaceEvidence.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const PASSING = "TAP version 13\nok 1 - a\nok 2 - b\n# tests 2\n# pass 2\n# fail 0\n";
const FAILING = "[Exit code 1]\nTAP version 13\nnot ok 1 - a\nok 2 - b\n# tests 2\n# pass 1\n# fail 1\n";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-evidence-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(root, "test", "a.test.js"), "import test from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\n");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "ignored");
  return root;
}

describe("workspace inventory", () => {
  it("hashes every file outside skipped directories, keeps test/config contents, reads the test command", async () => {
    const root = workspace();
    const inv = await captureWorkspaceInventory(root);
    expect([...inv.files.keys()].sort()).toEqual(["package.json", "src/a.js", "test/a.test.js"]);
    expect(inv.files.get("test/a.test.js")?.content).toContain("test('a'");
    expect(inv.files.get("package.json")?.kind).toBe("config");
    expect(inv.files.get("src/a.js")?.content).toBeUndefined();
    expect(inv.testCommand).toBe("node --test");
    expect(inv.partial).toBe(false);
  });

  it("reuses hashes for files whose size and mtime did not change", async () => {
    const root = workspace();
    const first = await captureWorkspaceInventory(root);
    const second = await captureWorkspaceInventory(root, DEFAULT_EVIDENCE_LIMITS, first);
    expect(second.files.get("src/a.js")).toBe(first.files.get("src/a.js"));
  });

  it("marks the inventory partial above the file limit instead of pretending it is complete", async () => {
    const root = workspace();
    const inv = await captureWorkspaceInventory(root, { ...DEFAULT_EVIDENCE_LIMITS, maxFiles: 2 });
    expect(inv.partial).toBe(true);
    expect(inv.reason).toMatch(/more than 2 files/);
  });

  it("reports an unreadable root as unavailable", async () => {
    const collector = createWorkspaceEvidenceCollector(join(tmpdir(), "orca-does-not-exist-" + Date.now()));
    const evidence = await collector.collect();
    expect(evidence.available).toBe(false);
    expect(evidence.reason).toMatch(/cannot read workspace/);
  });
});

describe("workspace diff", () => {
  it("sees modifications, additions and deletions with before/after content for test files, and ignores identical rewrites", async () => {
    const root = workspace();
    const before = await captureWorkspaceInventory(root);
    writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n"); // identical rewrite
    writeFileSync(join(root, "src", "b.js"), "export const b = 2;\n");
    writeFileSync(join(root, "test", "a.test.js"), "import test from 'node:test';\ntest('a', () => {});\n");
    unlinkSync(join(root, "package.json"));
    const after = await captureWorkspaceInventory(root, DEFAULT_EVIDENCE_LIMITS, before);
    const changes = await diffWorkspaceInventories(root, before, after);
    expect(changes.map((c) => `${c.status}:${c.path}`)).toEqual(["deleted:package.json", "added:src/b.js", "modified:test/a.test.js"]);
    const test = changes.find((c) => c.path === "test/a.test.js")!;
    expect(test.before).toContain("test('b'");
    expect(test.after).not.toContain("test('b'");
    expect(changes.find((c) => c.path === "src/b.js")?.after).toBe("export const b = 2;\n");
  });

  it("detects a changed file even when its mtime is set back (hash wins over the stat shortcut only when stat differs)", async () => {
    const root = workspace();
    const before = await captureWorkspaceInventory(root);
    writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n"); // same length
    const after = await captureWorkspaceInventory(root, DEFAULT_EVIDENCE_LIMITS, before);
    const changes = await diffWorkspaceInventories(root, before, after);
    expect(changes.map((c) => c.path)).toContain("src/a.js");
  });
});

describe("evidence collector with test-run bracketing", () => {
  it("records a reproduction on the baseline source and a verification on the final source", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    await collector.ready;
    // Worker runs the suite before touching source: baseline fingerprint.
    collector.observeTrace("tool.call", { tool: "run_command", input: { command: "npm test" } });
    collector.observeTrace("tool.result", { tool: "run_command", ok: false, output: FAILING });
    // Fix the source, then run the suite again: final fingerprint.
    writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
    utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 5000));
    collector.observeTrace("agent.tool.call", { tool: "run_command", input: { command: "npm test" } });
    collector.observeTrace("agent.tool.result", { tool: "run_command", input: { command: "npm test" }, result: { ok: true, output: PASSING, exitCode: 0 } });
    const evidence = await collector.collect();
    expect(evidence.available).toBe(true);
    expect(evidence.changes.map((c) => `${c.status}:${c.path}`)).toEqual(["modified:src/a.js"]);
    expect(evidence.testRuns?.map((r) => [r.sourceState, r.ok, r.fullSuite, r.exitCode])).toEqual([["baseline", false, true, undefined], ["final", true, true, 0]]);
    expect(evidence.testCommand).toBe("node --test");
    expect(typeof evidence.captureMs).toBe("number");
  });

  it("marks a run that happened between two edits as intermediate, and ignores non-test commands", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    await collector.ready;
    collector.observeTrace("tool.call", { tool: "run_command", input: { command: "ls" } });
    collector.observeTrace("tool.result", { tool: "run_command", ok: true, output: "src" });
    writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
    utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 5000));
    collector.observeTrace("tool.call", { tool: "run_command", input: { command: "npm test" } });
    collector.observeTrace("tool.result", { tool: "run_command", ok: true, output: PASSING });
    writeFileSync(join(root, "src", "a.js"), "export const a = 3;\n");
    utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 10000));
    const evidence = await collector.collect();
    expect(evidence.testRuns?.map((r) => r.sourceState)).toEqual(["intermediate"]);
  });
});

describe("runtime wiring", () => {
  const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
  const pappyResult = { verdict: "PASS" as const, trainingEligibility: "eligible" as const, confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [], issues: [], repair_task: null, internalSummary: "" };

  it("hands Pappy runtime workspace evidence and prior receipts, baselined before the worker runs", async () => {
    const root = workspace();
    const seen: unknown[] = [];
    const pappy: PappyPort = { evaluate: vi.fn((input) => { seen.push(input); return pappyResult; }) };
    const maestro: MaestroPort = {
      run: async (_task, ctx: OrcaRunCtx) => {
        // Worker edits a file and runs the suite; the runtime sees both.
        writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
        utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 5000));
        ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
        ctx.recordTrace?.("tool.result", { tool: "run_command", ok: true, output: PASSING });
        return { outputText: "done", toolEvents: [{ tool: "run_command", ok: true, summary: "run_command: ok", raw: { command: "npm test", _outputForProof: PASSING } }] };
      },
    };
    const spec = { originalUserMessage: "Fix the bug in src/a.js", intent: "fix", goals: ["a must be 2"], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
    await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, workspaceRoot: root }).executeTask(spec);
    expect(seen).toHaveLength(1);
    const input = seen[0] as { workspace?: { available: boolean; changes: Array<{ path: string }>; testRuns?: Array<{ sourceState: string }> }; priorToolEvents?: unknown[] };
    expect(input.workspace?.available).toBe(true);
    expect(input.workspace?.changes.map((c) => c.path)).toEqual(["src/a.js"]);
    expect(input.workspace?.testRuns?.map((r) => r.sourceState)).toEqual(["final"]);
    expect(input.priorToolEvents).toBeUndefined(); // first pass has no earlier receipts
  });

  it("supplies no workspace evidence when the runtime has no workspace root", async () => {
    const seen: unknown[] = [];
    const pappy: PappyPort = { evaluate: vi.fn((input) => { seen.push(input); return pappyResult; }) };
    const maestro: MaestroPort = { run: async () => ({ outputText: "done" }) };
    const spec = { originalUserMessage: "Explain x", intent: "explain", goals: [], permissions: { fileRead: true, fileWrite: false, shellExec: false } } as unknown as OrcaTaskSpec;
    await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never }).executeTask(spec);
    expect((seen[0] as { workspace?: unknown }).workspace).toBeUndefined();
  });
});

describe("phase 2.5: evidence capture across worker passes and failed commands", () => {
  const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
  const failResult = {
    verdict: "FAIL" as const, trainingEligibility: "needs_human_review" as const, confidence: 0.5, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [],
    issues: [{ issueId: "x", severity: "HIGH" as const, code: "FIX_TESTS_FAILING", category: "Proof" as const, description: "failing", expected_receipt: "", evidence: "", fix_hint: "fix it", message: "failing" }],
    repair_task: { title: "repair", steps: ["fix it"], required_proofs: ["passing suite"] }, repairTask: "repair: fix it", internalSummary: "verdict=FAIL",
  };
  const passResult = { ...failResult, verdict: "PASS" as const, issues: [], repair_task: null, repairTask: undefined, internalSummary: "verdict=PASS" };

  it("a repair pass sees the first pass's receipts, both passes' changes, and the failed run's output and exit code", async () => {
    const root = workspace();
    const seen: Array<{ workspace?: { changes: Array<{ path: string; status: string }>; testRuns?: Array<{ sourceState: string; ok: boolean; exitCode?: number; output: string }> }; priorToolEvents?: Array<{ tool: string; ok: boolean }>; toolEvents?: Array<{ tool: string }> }> = [];
    let pass = 0;
    const pappy: PappyPort = { evaluate: vi.fn((input) => { seen.push(input as never); return pass === 1 ? failResult : passResult; }) };
    const maestro: MaestroPort = {
      run: async (_task, ctx: OrcaRunCtx) => {
        pass++;
        if (pass === 1) {
          // First attempt: a new file, then the suite fails.
          writeFileSync(join(root, "src", "b.js"), "export const b = 1;\n");
          ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
          ctx.recordTrace?.("tool.result", { tool: "run_command", ok: false, output: FAILING, exitCode: 1 });
          return { outputText: "tried", toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "src/b.js" } }, { tool: "run_command", ok: false, summary: "run_command: failed - Command failed with exit code 1", raw: { command: "npm test", _outputForProof: FAILING, _exitCodeForProof: 1 } }] };
        }
        // Repair: the real fix, then the suite passes.
        writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
        utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 5000));
        ctx.recordTrace?.("tool.call", { tool: "run_command", input: { command: "npm test" } });
        ctx.recordTrace?.("tool.result", { tool: "run_command", ok: true, output: PASSING, exitCode: 0 });
        return { outputText: "fixed", toolEvents: [{ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path: "src/a.js" } }, { tool: "run_command", ok: true, summary: "run_command: ok", raw: { command: "npm test", _outputForProof: PASSING, _exitCodeForProof: 0 } }] };
      },
    };
    const spec = { originalUserMessage: "Fix the bug in src/a.js", intent: "fix", goals: ["a must be 2"], permissions: { fileRead: true, fileWrite: true, shellExec: true } } as unknown as OrcaTaskSpec;
    const result = await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, workspaceRoot: root, maxRepairPasses: 1 } as never).executeTask(spec);
    expect(result.status).toBe("SUCCESS");
    expect(seen).toHaveLength(2);

    const first = seen[0]!;
    expect(first.workspace?.changes.map((c) => `${c.status}:${c.path}`)).toEqual(["added:src/b.js"]);
    expect(first.workspace?.testRuns?.map((r) => [r.ok, r.exitCode, r.sourceState])).toEqual([[false, 1, "final"]]);
    expect(first.workspace?.testRuns?.[0]?.output).toContain("not ok 1 - a");

    const second = seen[1]!;
    // Receipts of the first pass are carried over, oldest first; the second pass's own events are separate.
    expect(second.priorToolEvents?.map((e) => `${e.tool}:${e.ok}`)).toEqual(["write_file:true", "run_command:false"]);
    expect(second.toolEvents?.map((e) => e.tool)).toEqual(["write_file", "run_command"]);
    // The inventory is diffed against the task-start baseline, so both passes' changes are visible.
    expect(second.workspace?.changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual(["added:src/b.js", "modified:src/a.js"]);
    // Both runs are recorded; the failed one keeps its exit code, the final one ran on the final source.
    expect(second.workspace?.testRuns?.map((r) => [r.ok, r.exitCode, r.sourceState])).toEqual([[false, 1, "intermediate"], [true, 0, "final"]]);
  });

  it("captures a test run that happens after the last source change as final, and one before a later edit as intermediate", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    await collector.ready;
    writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
    utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 5000));
    collector.observeTrace("tool.call", { tool: "run_command", input: { command: "npm test" } });
    collector.observeTrace("tool.result", { tool: "run_command", ok: true, output: PASSING, exitCode: 0 });
    writeFileSync(join(root, "src", "a.js"), "export const a = 3;\n");
    utimesSync(join(root, "src", "a.js"), new Date(), new Date(Date.now() + 10000));
    collector.observeTrace("tool.call", { tool: "run_command", input: { command: "npm test" } });
    collector.observeTrace("tool.result", { tool: "run_command", ok: false, output: FAILING, exitCode: 1 });
    const evidence = await collector.collect();
    expect(evidence.testRuns?.map((r) => [r.sourceState, r.ok, r.exitCode])).toEqual([["intermediate", true, 0], ["final", false, 1]]);
  });

  it("sees renames as a deletion plus an addition, and pre-existing uncommitted edits as the baseline rather than as the task's change", async () => {
    const root = workspace();
    // The user had already edited a file before the task started.
    writeFileSync(join(root, "src", "a.js"), "export const a = 'user edit';\n");
    const before = await captureWorkspaceInventory(root);
    const { renameSync } = await import("node:fs");
    renameSync(join(root, "src", "a.js"), join(root, "src", "renamed.js"));
    const after = await captureWorkspaceInventory(root, DEFAULT_EVIDENCE_LIMITS, before);
    const changes = await diffWorkspaceInventories(root, before, after);
    expect(changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual(["added:src/renamed.js", "deleted:src/a.js"]);
    // The untouched test file is not reported even though it differs from nothing but itself.
    expect(changes.some((c) => c.path === "test/a.test.js")).toBe(false);
  });
});
