#!/usr/bin/env node
/**
 * Launch the SOURCE build of the desktop app in an isolated profile for the
 * manual checklist. Nothing of the real user's data is read or written:
 *
 *   - a scratch --user-data-dir (settings, runs DB, budget journal, workspace protection)
 *   - scratch USERPROFILE / HOME (Dewey and run analysis write to ~/.orca)
 *   - a scratch workspace folder with one file
 *   - every role pointed at the mock provider (scripts/desktop-validation/mock-provider.mjs)
 *   - ELECTRON_RUN_AS_NODE removed (otherwise Electron starts as plain Node)
 *
 * Prerequisites (run from the repo root):
 *   pnpm --filter @clawde/desktop build          # node build-main.mjs — the normal dev bundle, not a package
 *   node scripts/desktop-validation/mock-provider.mjs 3939
 *   node scripts/desktop-validation/launch-isolated.mjs [--budget 0.05] [--profile <dir>]
 *
 * This does not build or package an executable.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const budget = Number(opt("--budget", "0.05"));
const port = opt("--port", "3939");
const profile = resolve(opt("--profile", join(tmpdir(), `orca-validation-${Date.now().toString(36)}`)));
// Optional Chrome DevTools port so an observer can read the renderer and take screenshots.
// Observation only: native dialogs are never driven through it.
const devtoolsPort = opt("--devtools-port", "");
// --billing metered --price <usdPer1M> makes the mock a paid provider with a custom price, so budget refusals can be seen.
const billing = opt("--billing", "local");
const price = Number(opt("--price", "0"));
const userData = join(profile, "userData");
const home = join(profile, "home");
const workspace = join(profile, "workspace");
for (const d of [userData, home, workspace]) mkdirSync(d, { recursive: true });
if (!existsSync(join(workspace, "README.md"))) writeFileSync(join(workspace, "README.md"), "# validation workspace\n\nDisposable. Created by launch-isolated.mjs.\n");

const providerId = "prov_mock";
const role = { providerId, model: "mock-model" };
const settings = {
  providers: [{ id: providerId, name: "Mock (local, no network)", type: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "plain:mock", billing }],
  roles: { brain: role, strong_model: role, cheap_model: role, utility: role, reviewer: role, narrator: role, debugger: role, reader: role },
  budgetUsd: budget,
  budgetSource: "user",
  ...(price > 0 ? { pricing: [{ model: "mock-model", inputPer1M: price, outputPer1M: price }] } : {}),
  workspaceRoot: workspace,
  mcpServers: [],
  maxRepairPasses: 1,
};
writeFileSync(join(userData, "orca-settings.json"), JSON.stringify(settings, null, 2));

const require = createRequire(import.meta.url);
const desktopDir = resolve(new URL("../../apps/desktop/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const electronPath = require(join(desktopDir, "node_modules", "electron"));
const env = { ...process.env, USERPROFILE: home, HOME: home };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`profile:   ${profile}\nuserData:  ${userData}\nworkspace: ${workspace}\nprovider:  http://127.0.0.1:${port}/v1 (budget $${budget})`);
const child = spawn(electronPath, [".", `--user-data-dir=${userData}`, ...(devtoolsPort ? [`--remote-debugging-port=${devtoolsPort}`] : [])], { cwd: desktopDir, env, stdio: "inherit" });
child.on("close", (code) => { console.log(`app exited with ${code}; profile kept at ${profile}`); process.exit(code ?? 0); });
