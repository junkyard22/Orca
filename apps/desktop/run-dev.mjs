/**
 * run-dev.mjs — spawn Electron with ELECTRON_RUN_AS_NODE cleared.
 *
 * Claude Code (and some other tools) set ELECTRON_RUN_AS_NODE=1 in the
 * environment, which makes Electron behave as a plain Node.js runtime so
 * tools can use the binary for scripting. Running `electron .` while that
 * env var is set means require("electron") returns the npm package path
 * string instead of the real Electron API, crashing the main process.
 *
 * This launcher explicitly removes ELECTRON_RUN_AS_NODE so the app always
 * starts in proper Electron mode regardless of the parent shell environment.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// Resolve the electron binary path via the electron npm package
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ["."], {
  cwd:   __dirname,
  env,
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 0));
