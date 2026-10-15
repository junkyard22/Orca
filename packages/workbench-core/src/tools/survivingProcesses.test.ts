/**
 * A parent's exit is not its children's: a command whose shell exits while a
 * detached grandchild keeps running must report that grandchild, so the task
 * lifecycle can keep the workspace protected until it is verified gone.
 * Real, disposable node processes; nothing is written.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandTool } from "./runCommandTool.js";
import { createSandboxPolicy } from "./sandbox.js";
import { findSurvivingDescendants, probeProcess, processExists } from "./processIdentity.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scanAvailable = process.env["ORCA_PROCESS_SCAN"] !== "off";

type Pending = Promise<{ status: "done" | "unknown"; resources: Array<{ pid: number; identity?: string; label: string; reason: string }> }>;

describe("surviving descendants", () => {
  it.skipIf(!scanAvailable)("a grandchild that outlives the command's shell is reported as an unsettled process on the result; it is gone once it exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-grandchild-"));
    // The child spawns a detached grandchild (sleeps 20 s, touches nothing) and exits at once.
    writeFileSync(join(dir, "spawn.js"), `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: "ignore", windowsHide: true });
      g.unref(); console.log("grandchild " + g.pid);
    `);
    const result = await runCommandTool.execute(
      { command: `node spawn.js`, timeout: 10_000 },
      { workspaceRoot: dir, runId: "r", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true },
    );
    expect(result.ok).toBe(true);
    const gpid = Number(result.output.match(/grandchild (\d+)/)![1]);
    expect(processExists(gpid)).toBe("alive");
    try {
      const pending = (result as unknown as { pendingResources?: Pending }).pendingResources;
      expect(pending).toBeDefined();
      expect(Object.keys(result)).not.toContain("pendingResources"); // never leaks into the agent's view of the result
      const scan = await pending!;
      expect(scan.status).toBe("done");
      expect(scan.resources.map((r) => r.pid)).toContain(gpid);
      const survivor = scan.resources.find((r) => r.pid === gpid)!;
      // Through a shell the chain is shell → node → grandchild; node is gone, so on
      // Windows the grandchild's ancestry cannot be proved (reported, ownership
      // unknown), on POSIX it is a group member (a confirmed descendant).
      expect(survivor.label).toMatch(/\(descendant of: node spawn\.js\)|\((?:ownership unknown:|suspected: names the workspace;) created while node spawn\.js ran\)/);
      expect(survivor.reason).toMatch(/still running after the command's shell exited|cannot be ruled out|ancestry cannot be established/);
      expect(await probeProcess({ pid: gpid, identity: survivor.identity })).toBe("alive");
      process.kill(gpid);
      await sleep(300);
      expect(await probeProcess({ pid: gpid, identity: survivor.identity })).toBe("gone");
    } finally {
      try { process.kill(gpid); } catch { /* already gone */ }
    }
  });

  it("a command that leaves nothing behind reports an empty scan, and an unknown scan is reported as unknown, never as none", async () => {
    const result = await runCommandTool.execute(
      { command: `node -e "console.log(1)"` },
      { workspaceRoot: process.cwd(), runId: "r", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true },
    );
    const scan = await (result as unknown as { pendingResources: Pending }).pendingResources;
    if (scanAvailable) expect(scan).toEqual({ status: "done", resources: [] });
    else expect(scan.status).toBe("unknown");
    expect(await findSurvivingDescendants(0, new Date().toISOString())).toBeNull();
  });
});

describe("scan coalescing", () => {
  it.skipIf(!scanAvailable)("scans requested within the window share one enumeration; each still sees its own command's descendants", async () => {
    const { survivorScanStatistics } = await import("./processIdentity.js");
    const before = survivorScanStatistics();
    const results = await Promise.all(Array.from({ length: 5 }, () => runCommandTool.execute(
      { command: `node -e "console.log(1)"` },
      { workspaceRoot: process.cwd(), runId: "r", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true },
    )));
    const scans = await Promise.all(results.map((r) => (r as unknown as { pendingResources: Pending }).pendingResources));
    const after = survivorScanStatistics();
    expect(scans.every((s) => s.status === "done" && s.resources.length === 0)).toBe(true);
    expect(after.requests - before.requests).toBe(5);
    expect(after.enumerations - before.enumerations).toBeLessThan(5);
    expect(after.enumerations - before.enumerations).toBeGreaterThanOrEqual(1);
  });
});
