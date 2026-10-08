/**
 * Summit Demo Mode — main-process helpers.
 *
 * RECONSTRUCTED from the shipped Orca 1.6.0 Summit build (app.asar,
 * dist-main/main.js, section "src/demoMode.ts"; built from d54b5da on
 * feature/summit-demo-mode, whose source was not recoverable). Logic, names
 * and messages follow the compiled output; types and comments are restored.
 *
 * Demo Mode keeps the demo project in <userData>/orca-demo/workspace and
 * backup videos in <userData>/orca-demo/recordings. Offline Demo (the
 * default every launch) must never enter a provider path.
 */
import { cp, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { OrcaSettings } from "./settings";

const DEMO_DIR_NAME = "orca-demo";
const DEMO_WORKSPACE_NAME = "workspace";
const DEMO_RECORDINGS_NAME = "recordings";
const DEMO_MARKER_FILE = ".orca-demo-workspace";
const BASELINE_REQUIRED_FILE = "package.json";
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".m4v"]);

export const OFFLINE_DEMO_REFUSAL =
  "Offline Demo uses prepared scenarios. Switch to Live AI to run a custom request.";

export type DemoExecutionMode = "offline" | "live";

export function isOfflineDemo(settings: Pick<OrcaSettings, "demoMode"> | null | undefined, mode: DemoExecutionMode): boolean {
  return !!settings?.demoMode && mode !== "live";
}

/** Offline Demo must never reach a provider; throws if it would. */
export function assertProviderPathAllowed(
  settings: Pick<OrcaSettings, "demoMode"> | null | undefined,
  mode: DemoExecutionMode,
  path: string,
): void {
  if (isOfflineDemo(settings, mode)) {
    throw new Error(`Offline Demo is active: refusing to enter provider path "${path}".`);
  }
}

export function parseDemoExecutionMode(value: unknown): DemoExecutionMode | null {
  return value === "offline" || value === "live" ? value : null;
}

export function demoPaths(userDataDir: string): { root: string; workspace: string; recordings: string } {
  const root = resolve(userDataDir, DEMO_DIR_NAME);
  return {
    root,
    workspace: join(root, DEMO_WORKSPACE_NAME),
    recordings: join(root, DEMO_RECORDINGS_NAME),
  };
}

/** In Demo Mode, Orca always works in the isolated demo workspace. */
export function effectiveSettings(saved: OrcaSettings, userDataDir: string): OrcaSettings {
  if (!saved.demoMode) return saved;
  return { ...saved, workspaceRoot: demoPaths(userDataDir).workspace };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Refuses to touch anything that is not the marked demo workspace under userData. */
export async function assertSafeDemoWorkspace(target: string, userDataDir: string): Promise<void> {
  const paths = demoPaths(userDataDir);
  const resolved = resolve(target);
  if (resolved !== paths.workspace || !isInside(resolve(userDataDir), resolved)) {
    throw new Error("Refusing to reset: target is not the Orca demo workspace.");
  }
  if (existsSync(paths.root)) {
    const rootStat = await lstat(paths.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Refusing to reset: demo folder is not a plain directory.");
    }
  }
  if (!existsSync(resolved)) return;
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Refusing to reset: demo workspace is not a plain directory.");
  }
  const entries = await readdir(resolved);
  if (entries.length > 0 && !entries.includes(DEMO_MARKER_FILE)) {
    throw new Error("Refusing to reset: demo workspace marker is missing.");
  }
}

/** Deletes the demo workspace and restores it from the packaged baseline. */
export async function resetDemoWorkspace(
  baselineDir: string,
  userDataDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace } = demoPaths(userDataDir);
  try {
    if (!existsSync(join(baselineDir, BASELINE_REQUIRED_FILE))) {
      throw new Error("Demo baseline project is missing from this build.");
    }
    await assertSafeDemoWorkspace(workspace, userDataDir);
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await mkdir(workspace, { recursive: true });
    await cp(baselineDir, workspace, { recursive: true });
    await writeFile(
      join(workspace, DEMO_MARKER_FILE),
      "Created by Orca Demo Mode. Reset Demo deletes and restores this folder.\n",
      "utf-8",
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Creates the demo workspace on first use; an existing marked workspace is kept. */
export async function ensureDemoWorkspace(
  baselineDir: string,
  userDataDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspace } = demoPaths(userDataDir);
  if (existsSync(join(workspace, DEMO_MARKER_FILE))) return { ok: true };
  return resetDemoWorkspace(baselineDir, userDataDir);
}

/** The first video (alphabetically) in the recordings folder, for the Recorded Demo button. */
export async function findDemoRecording(
  userDataDir: string,
): Promise<{ found: true; file: string } | { found: false; folder: string }> {
  const { recordings } = demoPaths(userDataDir);
  await mkdir(recordings, { recursive: true });
  const names = (await readdir(recordings))
    .filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return names.length > 0
    ? { found: true, file: join(recordings, names[0]!) }
    : { found: false, folder: recordings };
}
