/**
 * Offline Demo regression tests (Summit 1.6.0 behaviour).
 *
 * The shipped renderer/offline-demo.js and renderer/demo-mode.js are the
 * original files (byte-identical to the 1.6.0 build). These tests pin their
 * behaviour so later changes cannot silently break the booth's Offline Demo.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { OFFLINE_DEMO_REFUSAL } from "./demoMode";

const requireCjs = createRequire(import.meta.url);
const OfflineDemo = requireCjs("../renderer/offline-demo.js");
const DemoMode = requireCjs("../renderer/demo-mode.js");

const DEMO_APP = join(__dirname, "..", "demo", "summit-app");
const demoSource = readFileSync(join(DEMO_APP, "src", "bookings.js"), "utf8");
const demoTests = readFileSync(join(DEMO_APP, "test", "bookings.test.js"), "utf8");

type Step = { delayMs?: number; event?: { type: string }; card?: unknown; finish?: { answer: string; summary: { verdict: string } } };

/** Plays a scenario through the real runner with a synchronous timer queue. */
function play(steps: Step[]) {
  const queue: Array<() => void> = [];
  const events: Array<{ type: string }> = [];
  const cards: unknown[] = [];
  let finish: Step["finish"] | undefined;
  const runner = OfflineDemo.createOfflineRunner({
    onEvent: (e: { type: string }) => events.push(e),
    onCard: (c: unknown) => cards.push(c),
    onFinish: (f: Step["finish"]) => { finish = f; },
    setTimeout: (fn: () => void) => { queue.push(fn); return queue.length; },
    clearTimeout: () => {},
  });
  runner.start(steps);
  while (queue.length > 0) queue.shift()!();
  return { events, cards, finish, runner };
}

describe("Offline Demo scenario stays in sync with the bundled demo project", () => {
  it("lists exactly the demo project's tests, in order", () => {
    const names = [...demoTests.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
    expect(OfflineDemo.DEMO_TEST_NAMES).toEqual(names);
  });

  it("shows the real buggy line and its fix", () => {
    expect(demoSource).toContain(OfflineDemo.BUGGY_LINE);
    expect(demoSource).not.toContain(OfflineDemo.FIXED_LINE);
  });

  it("refuses free-form requests with the same text the main process uses", () => {
    expect(OfflineDemo.FREEFORM_REFUSAL).toBe(OFFLINE_DEMO_REFUSAL);
  });
});

describe("Offline Demo playback", () => {
  it.each([false, true])("is deterministic (withRepair=%s)", (withRepair) => {
    const a = OfflineDemo.buildFindAndFixScenario({ withRepair });
    const b = OfflineDemo.buildFindAndFixScenario({ withRepair });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each([false, true])("plays to 'Verified by Pappy' through the real Demo Mode tracker (withRepair=%s)", (withRepair) => {
    const steps = OfflineDemo.buildFindAndFixScenario({ withRepair });
    const { events, finish } = play(steps);
    const tracker = DemoMode.createDemoStageTracker();
    for (const e of events) tracker.consume(e);
    const state = tracker.getState();
    expect(DemoMode.isVerified(state)).toBe(true);
    expect(DemoMode.stripSteps(state, "verified").map((s: { status: string }) => s.status)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(finish?.summary.verdict).toBe("PASS");
    expect(finish?.answer).toContain(OfflineDemo.FIXED_LINE);
    if (withRepair) expect(events.some((e) => e.type === "repair:start")).toBe(true);
  });

  it("stop() drops every remaining step", () => {
    const steps = OfflineDemo.buildFindAndFixScenario({ withRepair: false });
    const queue: Array<() => void> = [];
    const events: unknown[] = [];
    const runner = OfflineDemo.createOfflineRunner({
      onEvent: (e: unknown) => events.push(e),
      setTimeout: (fn: () => void) => { queue.push(fn); return queue.length; },
      clearTimeout: () => {},
    });
    runner.start(steps);
    queue.shift()!();
    runner.stop();
    while (queue.length > 0) queue.shift()!();
    expect(events).toHaveLength(1);
    expect(runner.isRunning()).toBe(false);
  });

  it("never touches IPC, network or storage (runner only receives display callbacks)", () => {
    // Code only: the header comment itself mentions window.orca, fetch and storage.
    const src = readFileSync(join(__dirname, "..", "renderer", "offline-demo.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/window\.orca|fetch\(|localStorage|XMLHttpRequest|WebSocket/);
  });
});

describe("the bundled demo project really behaves as the scenario claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-offline-demo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runTests = (): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("fails only the ISSUE.md test before the fix, and passes all after it", () => {
    cpSync(DEMO_APP, dir, { recursive: true });
    const before = runTests();
    expect(before.code).not.toBe(0);
    expect(before.out).toMatch(/# fail 1/);
    expect(before.out).toContain(OfflineDemo.DEMO_TEST_NAMES[6]);

    writeFileSync(join(dir, "src", "bookings.js"), demoSource.replace(OfflineDemo.BUGGY_LINE, OfflineDemo.FIXED_LINE));
    const after = runTests();
    expect(after.code).toBe(0);
    expect(after.out).toMatch(new RegExp(`# pass ${OfflineDemo.DEMO_TEST_NAMES.length}`));
  }, 60_000);
});
