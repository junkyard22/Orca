/**
 * run_command after Stop: the kill is requested, and only the child's exit
 * confirms it. When the exit never comes, the tool does not pretend the
 * process is gone — the rejection names the process so the lifecycle can
 * keep the workspace protected until it is verified gone.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ command: string; child: FakeChild }> = [];
let exitsOnKill = true;

class FakeChild extends EventEmitter {
  pid = 54321;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {
    if (exitsOnKill) { this.exitCode = 1; setTimeout(() => this.emit("close", 1), 5); }
    return true;
  }
}

vi.mock("child_process", () => ({
  spawn: (command: string, args: string[]) => {
    if (command === "taskkill") {
      // The killer process itself: report an error so the tool falls back to child.kill().
      const killer = new EventEmitter();
      setTimeout(() => killer.emit("error", new Error("taskkill unavailable")), 1);
      return killer;
    }
    const child = new FakeChild();
    spawnCalls.push({ command, child });
    return child;
  },
}));

vi.mock("./processIdentity.js", () => ({ captureProcessIdentity: async () => "2026-10-12T14:00:00.0000000+00:00" }));

const { runCommandTool } = await import("./runCommandTool.js");
const { createSandboxPolicy } = await import("./sandbox.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = (signal: AbortSignal) => ({ workspaceRoot: process.cwd(), runId: "r", abortSignal: signal, sandbox: createSandboxPolicy({ extraAllowedCommands: ["pnpm"] }), requestApproval: async () => true });

afterEach(() => { spawnCalls.length = 0; exitsOnKill = true; });

describe("run_command cancellation", () => {
  it("a kill confirmed by the child's exit is a plain AbortError with nothing left behind", async () => {
    const controller = new AbortController();
    const p = runCommandTool.execute({ command: "pnpm test" }, ctx(controller.signal));
    await sleep(5);
    controller.abort(new Error("Stopped."));
    const error = await p.then(() => null, (e: Error) => e);
    expect(error).toMatchObject({ name: "AbortError", message: "Stopped." });
    expect((error as Error & { unsettledResource?: unknown }).unsettledResource).toBeUndefined();
  });

  it("a kill that is never confirmed rejects after the grace period with the process named: pid, command, start time and identity", async () => {
    exitsOnKill = false;
    const controller = new AbortController();
    const p = runCommandTool.execute({ command: "pnpm test -- --watch" }, ctx(controller.signal));
    await sleep(5);
    const started = Date.now();
    controller.abort(new Error("Stopped."));
    const error = await p.then(() => null, (e: Error) => e) as Error & { unsettledResource?: Record<string, unknown> };
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(error.name).toBe("AbortError");
    expect(error.unsettledResource).toMatchObject({
      kind: "process",
      pid: 54321,
      label: "pnpm test -- --watch",
      identity: "2026-10-12T14:00:00.0000000+00:00",
      reason: expect.stringMatching(/had not exited after 750 ms/),
    });
    expect(typeof error.unsettledResource!["startedAt"]).toBe("string");
    // A close that arrives later changes nothing: the promise already settled.
    spawnCalls[0]!.child.emit("close", 0);
    await sleep(5);
  });
});
