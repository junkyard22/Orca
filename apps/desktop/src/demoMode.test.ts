import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFLINE_DEMO_REFUSAL,
  assertProviderPathAllowed,
  assertSafeDemoWorkspace,
  demoPaths,
  effectiveSettings,
  ensureDemoWorkspace,
  findDemoRecording,
  isOfflineDemo,
  parseDemoExecutionMode,
  resetDemoWorkspace,
} from "./demoMode";
import type { OrcaSettings } from "./settings";

const BASELINE = join(__dirname, "..", "demo", "summit-app");
const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "orca-demo-mode-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const settings = (over: Partial<OrcaSettings> = {}) =>
  ({ providers: [], roles: {}, budgetUsd: 0, maxRepairPasses: 2, verbose: false, workspaceRoot: "C:/projects/real", ...over }) as OrcaSettings;

describe("offline vs live", () => {
  it("Offline Demo is the demoMode default and blocks every provider path", () => {
    expect(isOfflineDemo(settings({ demoMode: true }), "offline")).toBe(true);
    expect(() => assertProviderPathAllowed(settings({ demoMode: true }), "offline", "initOrca"))
      .toThrow('Offline Demo is active: refusing to enter provider path "initOrca".');
  });

  it("Live AI and non-demo settings may reach providers", () => {
    expect(() => assertProviderPathAllowed(settings({ demoMode: true }), "live", "send-message")).not.toThrow();
    expect(() => assertProviderPathAllowed(settings(), "offline", "send-message")).not.toThrow();
  });

  it("accepts only the two execution modes", () => {
    expect(parseDemoExecutionMode("offline")).toBe("offline");
    expect(parseDemoExecutionMode("live")).toBe("live");
    expect(parseDemoExecutionMode("LIVE")).toBeNull();
    expect(parseDemoExecutionMode(undefined)).toBeNull();
  });

  it("uses the shipped refusal text", () => {
    expect(OFFLINE_DEMO_REFUSAL).toBe("Offline Demo uses prepared scenarios. Switch to Live AI to run a custom request.");
  });
});

describe("workspace isolation", () => {
  it("Demo Mode always works in <userData>/orca-demo/workspace; the saved workspace is untouched", () => {
    const userData = tempDir();
    const saved = settings({ demoMode: true });
    const effective = effectiveSettings(saved, userData);
    expect(effective.workspaceRoot).toBe(demoPaths(userData).workspace);
    expect(saved.workspaceRoot).toBe("C:/projects/real");
    expect(effectiveSettings(settings(), userData).workspaceRoot).toBe("C:/projects/real");
  });

  it("creates the demo workspace from the packaged baseline, with the marker", async () => {
    const userData = tempDir();
    expect(await ensureDemoWorkspace(BASELINE, userData)).toEqual({ ok: true });
    const ws = demoPaths(userData).workspace;
    expect(readdirSync(ws).sort()).toEqual([".orca-demo-workspace", "ISSUE.md", "README.md", "package.json", "src", "test"]);
    expect(readFileSync(join(ws, "src", "bookings.js"), "utf8")).toBe(readFileSync(join(BASELINE, "src", "bookings.js"), "utf8"));
  });

  it("Reset Demo restores the baseline after edits", async () => {
    const userData = tempDir();
    await ensureDemoWorkspace(BASELINE, userData);
    const file = join(demoPaths(userData).workspace, "src", "bookings.js");
    writeFileSync(file, "edited");
    writeFileSync(join(demoPaths(userData).workspace, "extra.txt"), "x");
    expect(await resetDemoWorkspace(BASELINE, userData)).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe(readFileSync(join(BASELINE, "src", "bookings.js"), "utf8"));
    expect(existsSync(join(demoPaths(userData).workspace, "extra.txt"))).toBe(false);
  });

  it("ensure keeps an existing marked workspace (does not reset mid-demo)", async () => {
    const userData = tempDir();
    await ensureDemoWorkspace(BASELINE, userData);
    const file = join(demoPaths(userData).workspace, "src", "bookings.js");
    writeFileSync(file, "in progress");
    await ensureDemoWorkspace(BASELINE, userData);
    expect(readFileSync(file, "utf8")).toBe("in progress");
  });

  it("refuses to reset an unmarked non-empty folder", async () => {
    const userData = tempDir();
    mkdirSync(demoPaths(userData).workspace, { recursive: true });
    writeFileSync(join(demoPaths(userData).workspace, "precious.txt"), "keep me");
    const r = await resetDemoWorkspace(BASELINE, userData);
    expect(r).toEqual({ ok: false, error: "Refusing to reset: demo workspace marker is missing." });
    expect(readFileSync(join(demoPaths(userData).workspace, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("refuses any target other than the demo workspace", async () => {
    const userData = tempDir();
    await expect(assertSafeDemoWorkspace(join(userData, "elsewhere"), userData))
      .rejects.toThrow("Refusing to reset: target is not the Orca demo workspace.");
  });

  it("refuses a symlinked demo folder", async () => {
    const userData = tempDir();
    const outside = tempDir();
    try {
      symlinkSync(outside, demoPaths(userData).root, "junction");
    } catch {
      return; // symlinks unavailable on this machine
    }
    const r = await resetDemoWorkspace(BASELINE, userData);
    expect(r.ok).toBe(false);
  });

  it("reports a missing baseline instead of deleting anything", async () => {
    const userData = tempDir();
    expect(await resetDemoWorkspace(join(userData, "no-baseline"), userData))
      .toEqual({ ok: false, error: "Demo baseline project is missing from this build." });
  });
});

describe("recorded demo", () => {
  it("plays the first video alphabetically, ignoring other files", async () => {
    const userData = tempDir();
    const { recordings } = demoPaths(userData);
    mkdirSync(recordings, { recursive: true });
    for (const f of ["notes.txt", "b-run.MP4", "a-run.webm"]) writeFileSync(join(recordings, f), "");
    expect(await findDemoRecording(userData)).toEqual({ found: true, file: join(recordings, "a-run.webm") });
  });

  it("creates the folder and reports where to put a video when none exists", async () => {
    const userData = tempDir();
    expect(await findDemoRecording(userData)).toEqual({ found: false, folder: demoPaths(userData).recordings });
    expect(existsSync(demoPaths(userData).recordings)).toBe(true);
  });
});
