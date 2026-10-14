#!/usr/bin/env node
/**
 * Stage the workspace-override inspection (checklist row 13b) for a human.
 *
 *   node scripts/desktop-validation/stage-override.mjs --profile <dir>
 *
 * Starts one harmless sleeper process (node, --minutes, default 180; touches nothing)
 * and records it in the profile's workspace-protection.json as a process
 * a previous task could not confirm stopped. On the next launch of the app
 * with that profile, the protection banner appears and the presenter can
 * open the native override dialog, inspect it, and press Cancel.
 *
 * It does not override anything itself. The sleeper is the "uncontrolled
 * writer" stand-in; end it from Task Manager (or let it expire) to see the
 * protection lift by verification instead.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const profile = resolve(opt("--profile", ""));
// How long the harmless sleeper lives; long enough for an unhurried inspection.
const minutes = Number(opt("--minutes", "180"));
if (!profile) { console.error("usage: stage-override.mjs --profile <dir>"); process.exit(2); }
const userData = join(profile, "userData");
const workspace = join(profile, "workspace");
mkdirSync(userData, { recursive: true }); mkdirSync(workspace, { recursive: true });

const wb = await import(pathToFileURL(resolve("packages/workbench-core/dist/index.js")).href);
const sleeper = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${minutes} * 60 * 1000)`], { detached: true, stdio: "ignore", windowsHide: true });
sleeper.unref();
const identity = await wb.captureProcessIdentity(sleeper.pid);

const file = join(userData, "workspace-protection.json");
const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, protections: [], overrides: [], generations: {} };
existing.protections = (existing.protections ?? []).filter((p) => p.taskId !== "staged-inspection");
existing.protections.push({
  root: workspace,
  taskId: "staged-inspection",
  since: new Date().toISOString(),
  reason: "was interrupted with work still running (staged for the override-dialog inspection)",
  operations: [],
  resources: [{ kind: "process", pid: sleeper.pid, label: `node sleeper (harmless stand-in for an uncontrolled writer)`, startedAt: new Date().toISOString(), ...(identity ? { identity } : {}), reason: "its termination was requested on Stop but the process had not exited after 750 ms" }],
  notes: [],
  generation: existing.generations?.[workspace.toLowerCase()] ?? 0,
});
writeFileSync(file, JSON.stringify(existing));
console.log(`staged: sleeper pid ${sleeper.pid} (identity ${identity ?? "unavailable"}) recorded as an unconfirmed process for ${workspace}\nprotection file: ${file}\nEnd the sleeper from Task Manager to watch the protection lift by verification; do not override while it runs.`);
