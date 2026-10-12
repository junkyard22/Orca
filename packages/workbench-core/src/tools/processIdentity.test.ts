/**
 * Process identity against real, disposable child processes: a pid alone is
 * not an identity, and "gone" is only said when it is true.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { captureProcessIdentity, probeProcess, processExists } from "./processIdentity.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function disposableChild() {
  // A node process that sleeps; it never touches the filesystem.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
  return child;
}

describe("process identity", () => {
  it("captures a creation time for a live process and reports it alive; after it exits, gone", async () => {
    const child = disposableChild();
    try {
      const pid = child.pid!;
      expect(processExists(pid)).toBe("alive");
      const identity = await captureProcessIdentity(pid);
      // Best effort: on a host where the probe command is unavailable, identity may be undefined.
      if (identity !== undefined) expect(identity.length).toBeGreaterThan(5);
      expect(await probeProcess({ pid, identity })).toBe("alive");
      child.kill();
      await new Promise((r) => child.once("exit", r));
      await sleep(50);
      expect(processExists(pid)).toBe("gone");
      expect(await probeProcess({ pid, identity })).toBe("gone");
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("a pid that is alive but carries a different creation time is a different process: gone, not alive", async () => {
    const child = disposableChild();
    try {
      const pid = child.pid!;
      const identity = await captureProcessIdentity(pid);
      if (identity === undefined) return; // probe unavailable here; the existence check alone is tested above
      expect(await probeProcess({ pid, identity: "1999-01-01T00:00:00.0000000+00:00" })).toBe("gone");
      expect(await probeProcess({ pid, identity })).toBe("alive");
    } finally {
      child.kill();
    }
  });

  it("an invalid pid is never alive, and a missing identity falls back to existence", async () => {
    expect(await captureProcessIdentity(0)).toBeUndefined();
    expect(await captureProcessIdentity(-5)).toBeUndefined();
    expect(await probeProcess({ pid: 2147483646 })).not.toBe("alive");
  });
});
