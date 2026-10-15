/**
 * Who started a process that outlived a command? The survivor scan must not
 * make an unrelated process the command's merely because it was created while
 * the command ran — and must keep reporting what it cannot rule out.
 *
 * Found in the 1.7.0 A5 live rehearsal: an operator's Git Bash monitoring loop
 * (`sleep 2`) was reported as "sleep.exe (orphan of: npm test)". Git Bash
 * starts every external program under a parent that has already exited, so a
 * single process snapshot cannot tell it from a detached grandchild of the
 * command. The parser now says only what it can establish.
 *
 * The first block is deterministic (synthetic Win32_Process / ps rows). The
 * last test runs Orca's real run_command next to a real Git Bash sleep loop
 * (Windows with Git for Windows only).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePosixSurvivors, parseWindowsSurvivors, type WindowsRow } from "./processIdentity.js";
import { describeSurvivor, runCommandTool } from "./runCommandTool.js";
import { createSandboxPolicy } from "./sandbox.js";

const SELF = 1000;
const ROOT = 5000; // the command's shell (cmd.exe), already exited when the scan runs
const SPAWNED = "2026-10-15T13:04:37.000Z";
const at = (offsetMs: number) => new Date(Date.parse(SPAWNED) + offsetMs).toISOString();
const row = (pid: number, ppid: number, name: string, createdOffsetMs: number, extra: Partial<WindowsRow> = {}): WindowsRow =>
  ({ ProcessId: pid, ParentProcessId: ppid, Name: name, c: at(createdOffsetMs), s: 1, ...extra });
const base = [row(SELF, 4, "Orca.exe", -3_600_000)];
const alive = () => "alive" as const;
const WS = "C:\\Users\\u\\AppData\\Local\\Temp\\rehearsal\\project-A5";

describe("survivor attribution (Windows rows)", () => {
  it("an unrelated Git Bash sleep.exe created during the command is not called the command's: ownership unknown, still reported", () => {
    // bash (alive, pid 7000) forked a helper (pid 7100, exited) that started sleep.exe.
    const rows = [...base, row(7000, 6000, "bash.exe", -60_000), row(7200, 7100, "sleep.exe", 300, { cl: "\"C:\\Program Files\\Git\\usr\\bin\\sleep.exe\" 2" })];
    const found = parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive, { workspaceRoot: WS });
    expect(found).toEqual([expect.objectContaining({ pid: 7200, relation: "orphan", ownership: "unknown" })]);
    const { label } = describeSurvivor("sleep.exe", "unknown", "npm test");
    expect(label).toBe("sleep.exe (ownership unknown: created while npm test ran)");
    expect(label).not.toMatch(/of: npm test/);
  });

  it("an unrelated application that starts a process under a live parent during the command is not reported", () => {
    const rows = [...base, row(8000, 6000, "explorer.exe", -3_600_000), row(8100, 8000, "notepad.exe", 200)];
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive)).toEqual([]);
  });

  it("a process created before the command was spawned is not its descendant (precise creation times; 250 ms allowance)", () => {
    const rows = [...base, row(7300, 7299, "sleep.exe", -1_500), row(7400, 7399, "sleep.exe", -100)];
    const found = parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive);
    // 1.5 s before: excluded (was inside the old 2 s allowance); 100 ms before: kept, cannot be ruled out.
    expect(found.map((f) => f.pid)).toEqual([7400]);
  });

  it("a process in another Windows session is not reported", () => {
    const rows = [...base, row(7500, 7499, "svc-helper.exe", 500, { s: 0 })];
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive)).toEqual([]);
  });

  it("a genuine child of the command still running after its shell exited is a confirmed descendant", () => {
    const rows = [...base, row(5100, ROOT, "node.exe", 50, { cl: "node server.js" })];
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive)).toEqual([expect.objectContaining({ pid: 5100, relation: "descendant", ownership: "confirmed" })]);
  });

  it("a detached grandchild that outlives its parent: confirmed while the chain is recorded, suspected when it names the workspace, unknown otherwise — always reported", () => {
    // root → node (alive) → grandchild: walkable.
    const chain = [...base, row(5100, ROOT, "node.exe", 50), row(5200, 5100, "node.exe", 80)];
    expect(parseWindowsSurvivors(chain, ROOT, SPAWNED, SELF, alive).map((f) => [f.pid, f.ownership])).toEqual([[5100, "confirmed"], [5200, "confirmed"]]);
    // root → node (exited) → grandchild: not walkable.
    const naming = [...base, row(5200, 5100, "node.exe", 80, { cl: `node ${WS}\\watch.js` })];
    expect(parseWindowsSurvivors(naming, ROOT, SPAWNED, SELF, alive, { workspaceRoot: WS })).toEqual([expect.objectContaining({ pid: 5200, ownership: "suspected" })]);
    const silent = [...base, row(5200, 5100, "node.exe", 80, { cl: "node -e setTimeout(()=>{},20000)" })];
    expect(parseWindowsSurvivors(silent, ROOT, SPAWNED, SELF, alive, { workspaceRoot: WS })).toEqual([expect.objectContaining({ pid: 5200, ownership: "unknown" })]);
  });

  it("a reused pid: a process numbered like the command's parent chain but created before the command is not walked into", () => {
    // pid 5100 now belongs to an old process whose ParentProcessId happens to equal the root pid.
    const rows = [...base, row(5100, ROOT, "old.exe", -86_400_000)];
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive)).toEqual([]);
  });

  it("incomplete information is not read as safety: no creation time or no session still reports a dead-parent process", () => {
    const rows: WindowsRow[] = [...base, { ProcessId: 7600, ParentProcessId: 7599, Name: "x.exe", c: "" }, { ProcessId: 7700, ParentProcessId: 7699, Name: "y.exe", c: at(400) }];
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF, alive).map((f) => [f.pid, f.ownership])).toEqual([[7600, "unknown"], [7700, "unknown"]]);
  });

  it("a process that exited before inspection is not reported; the scanner itself never is", () => {
    const rows = [...base, row(7800, 7799, "sleep.exe", 300), row(SELF + 1, 7799, "powershell.exe", 300)];
    const gone = (pid: number) => (pid === 7800 ? "gone" as const : "alive" as const);
    expect(parseWindowsSurvivors(rows, ROOT, SPAWNED, SELF + 1, gone)).toEqual([]);
  });
});

describe("survivor attribution (POSIX ps output)", () => {
  it("process-group members are confirmed; a reparented process created during the command is ownership unknown", () => {
    const fmt = (pid: number, ppid: number, pgid: number, name: string, offsetMs: number) => `${pid} ${ppid} ${pgid} ${name} ${new Date(Date.parse(SPAWNED) + offsetMs).toString().slice(0, 24)}`;
    const ps = [fmt(SELF, 1, SELF, "node", -3_600_000), fmt(5100, ROOT, ROOT, "node", 1000), fmt(5300, 1, 5300, "sleep", 1000)].join("\n");
    const found = parsePosixSurvivors(ps, ROOT, SPAWNED, SELF, alive);
    expect(found.map((f) => [f.pid, f.relation, f.ownership])).toEqual([[5100, "descendant", "confirmed"], [5300, "orphan", "unknown"]]);
  });
});

const gitBash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
// Opt-in: a live sleep loop is exactly the kind of unrelated activity that
// other test files' real scans would (correctly) report, so it must not run in
// parallel with them. Run with ORCA_REAL_PROCESS_TESTS=1, on its own.
const realGitBash = process.env["ORCA_REAL_PROCESS_TESTS"] === "1" && process.platform === "win32" && existsSync(gitBash) && process.env["ORCA_PROCESS_SCAN"] !== "off";

describe("real processes", () => {
  it.skipIf(!realGitBash)("Orca runs a test command while an unrelated Git Bash loop launches sleep.exe: anything caught is labelled ownership unknown, never the command's descendant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-unrelated-"));
    writeFileSync(join(dir, "t.js"), "setTimeout(() => console.log('ok'), 400);");
    const loop = spawn(gitBash, ["-c", "while true; do sleep 1; done"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const labels: string[] = [];
      for (let i = 0; i < 4; i++) {
        const result = await runCommandTool.execute(
          { command: "node t.js", timeout: 10_000 },
          { workspaceRoot: dir, runId: "r", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true },
        );
        const scan = await (result as unknown as { pendingResources: Promise<{ status: string; resources: Array<{ label: string; ownership?: string }> }> }).pendingResources;
        for (const r of scan.resources) {
          labels.push(r.label);
          expect(r.ownership).not.toBe("confirmed");
        }
      }
      for (const l of labels.filter((x) => /sleep\.exe/i.test(x))) expect(l).toMatch(/^sleep\.exe \(ownership unknown: created while node t\.js ran\)$/);
    } finally {
      try { execFileSync("taskkill", ["/F", "/T", "/PID", String(loop.pid)], { stdio: "ignore" }); } catch { /* already gone */ }
    }
  }, 60_000);
});
