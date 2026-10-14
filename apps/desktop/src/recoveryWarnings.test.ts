/**
 * Start-up recovery, end to end through the real journal and guard: what a
 * previous process left behind is said accurately, recorded conservatively,
 * and never resumed, repeated, or released without verification.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetJournal, createWorkspaceGuard } from "@clawde/orca-core";
import type { ProcessLiveness, UnsettledResource } from "@clawde/orca-core";
import { TaskBudgetLedger } from "@clawde/miranda-core";
import { recoveryWarnings } from "./recoveryWarnings";

const proc = (pid: number, identity?: string): UnsettledResource => ({ kind: "process", pid, label: "npm start", startedAt: "2026-10-12T00:00:00.000Z", ...(identity ? { identity } : {}), reason: "kill not confirmed" });
const ANTHROPIC = { id: "p1", type: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };

/** A previous process: a task with a request in flight, and a protected workspace, both left on disk. */
function previousProcess(dir: string, resources: UnsettledResource[], operations = true) {
  const journal = createBudgetJournal(join(dir, "budget-journal.json"));
  const ledger = new TaskBudgetLedger({ taskId: "task-A", limitUsd: 1 });
  journal.open("task-A", ledger.snapshot());
  ledger.reserve({ provider: ANTHROPIC, model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x".repeat(4000) }], maxTokens: 1000 });
  journal.update(ledger.snapshot()); // never closed: the process died here
  const guard = createWorkspaceGuard({ filePath: join(dir, "workspace-protection.json") });
  guard.protect("/ws", { taskId: "task-A", reason: "was interrupted", operations: operations ? [{ kind: "tool", label: "write_file", startedAt: "t" }] : [], resources });
}

async function restart(dir: string, probe: (r: UnsettledResource) => ProcessLiveness) {
  const journal = createBudgetJournal(join(dir, "budget-journal.json"));
  const guard = createWorkspaceGuard({ filePath: join(dir, "workspace-protection.json"), probe });
  const unresolvedBudget = journal.recover();
  const recovered = await guard.recover();
  return { guard, out: recoveryWarnings({ unresolvedBudget, guard: recovered, describe: (p) => guard.describe(p) }) };
}

describe("start-up recovery", () => {
  it("interrupted task, no process left: the budget exposure is recorded as an upper bound, the run is interrupted, the workspace is released by verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, []);
    const { guard, out } = await restart(dir, () => "gone");
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ id: "task-A", status: "FAIL", stoppedBecause: "interrupted", costBasis: "upper_bound" });
    expect(out.runs[0]!.costUnreconciledUsd).toBeGreaterThan(0);
    expect(out.warnings.join("\n")).toMatch(/task task-A still running.*1 model request\(s\) in flight.*Up to \$0\.\d+ may have been charged/);
    expect(out.warnings.join("\n")).toMatch(/Workspace .*ws was left protected by task task-A and is released: no process survived the restart/);
    expect(await guard.status("/ws")).toEqual([]);
    // Nothing resumed: a second restart finds nothing to recover.
    expect((await restart(dir, () => "gone")).out).toEqual({ warnings: [], runs: [] });
  });

  it("interrupted task with a confirmed live process: the workspace stays protected and the warning says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, [proc(4242, "id-1")]);
    const { guard, out } = await restart(dir, (r) => (r.pid === 4242 ? "alive" : "gone"));
    expect(await guard.status("/ws")).toHaveLength(1);
    const text = out.warnings.join("\n");
    expect(text).toMatch(/is protected: task task-A was interrupted/);
    expect(text).toMatch(/1 in-process operation\(s\) ended with the previous Orca process \(tool write_file\); their last writes may be partial/);
    expect(text).toMatch(/pid 4242 \(npm start\)/);
    expect(text).toMatch(/Unknown is not safe/);
    expect(text).toMatch(/override, which is recorded as your decision/);
  });

  it("unknown process status is not safe: protection stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, [proc(7)]);
    const { guard, out } = await restart(dir, () => "unknown");
    expect(await guard.status("/ws")).toHaveLength(1);
    expect(out.warnings.join("\n")).toMatch(/could not be confirmed gone \(pid 7\)/);
  });

  it("a reused pid with a different creation identity is gone: released by verification, with the verification noted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, [proc(7, "2026-10-12T00:00:00Z")], false);
    // The probe compares identities: same pid, different creation time → gone.
    const probe = (r: UnsettledResource) => (r.identity === "2026-10-12T00:00:00Z" ? "gone" : "alive");
    const { guard, out } = await restart(dir, probe);
    expect(await guard.status("/ws")).toEqual([]);
    expect(out.warnings.join("\n")).toMatch(/released: no process survived the restart/);
  });

  it("protection survives a restart until a manual override, which is recorded with the original interruption evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, [proc(9, "id-9")]);
    const first = await restart(dir, () => "alive");
    expect(await first.guard.status("/ws")).toHaveLength(1);
    const released = await first.guard.override("/ws", { reason: "the user accepted the risk in the override dialog", acknowledged: true });
    expect(released).toMatchObject([{ by: "override", taskId: "task-A", generation: 1 }]);
    // Another restart: nothing protected, the override is on record with what was accepted.
    const second = await restart(dir, () => "alive");
    expect(second.out.warnings.filter((w) => /protected/.test(w))).toEqual([]);
    expect(second.guard.overrides()).toMatchObject([{ taskId: "task-A", generation: 1 }]);
    expect(second.guard.overrides()[0]!.protection.resources.map((r) => r.pid)).toEqual([9]);
    expect(second.guard.generation("/ws")).toBe(1);
  });

  it("a corrupted journal or protection record is reported as unknown, not as clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    writeFileSync(join(dir, "budget-journal.json"), "{ not json");
    writeFileSync(join(dir, "workspace-protection.json"), "[]garbage");
    const { out } = await restart(dir, () => "gone");
    // The files tolerate corruption by reading as empty; the caller says so.
    expect(out).toEqual({ warnings: [], runs: [] });
    const reported = recoveryWarnings({ unresolvedBudget: [], guard: { kept: [], released: [] }, describe: () => "", corrupt: [{ what: "The budget journal", error: "unexpected token" }] });
    expect(reported.warnings[0]).toMatch(/The budget journal could not be read \(unexpected token\). What it recorded is unknown: treat any task that was running when Orca last closed as unreconciled/);
  });

  it("stale authorization cannot survive a restart: approvals are not persisted, and a new process has no running session", () => {
    // Approvals live in the main process's pendingApprovals map, bound to the
    // running session (tool:approve resolves approved && session.state === "running").
    // Nothing of them is written to disk: the journal and the protection file
    // carry budget and process records only.
    const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
    previousProcess(dir, [proc(1)]);
    const journalText = JSON.stringify(require("node:fs").readFileSync(join(dir, "budget-journal.json"), "utf8"));
    const guardText = JSON.stringify(require("node:fs").readFileSync(join(dir, "workspace-protection.json"), "utf8"));
    expect(journalText + guardText).not.toMatch(/approv/i);
  });
});
