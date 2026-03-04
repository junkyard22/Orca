/**
 * build-dist.mjs — full production build for Orca desktop
 *
 * Steps:
 *   1. esbuild: bundle src/main.ts + src/preload.ts → dist-main/ (CJS, with all
 *      workspace packages inlined — no runtime node_modules needed)
 *   2. electron-builder: pack dist-main/ + renderer/ into release/
 *      - release/Orca Setup x.x.x.exe  (NSIS installer)
 *      - release/Orca x.x.x.exe        (portable single-file EXE)
 *
 * Usage:
 *   cd apps/desktop
 *   node build-dist.mjs
 *
 *   Or from the workspace root:
 *   pnpm --filter @clawde/desktop dist
 */

import { execSync }     from "node:child_process";
import { existsSync }   from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function run(cmd) {
  console.log("\n> " + cmd);
  execSync(cmd, { stdio: "inherit", cwd: __dirname });
}

// ── 1. Bundle main process and preload ────────────────────────────────────

run("node build-main.mjs");

// ── 2. Package with electron-builder ─────────────────────────────────────
// Resolve the local bin to avoid needing electron-builder on PATH.

const ebBin = resolve(__dirname, "node_modules", ".bin", "electron-builder.cmd");
const eb    = existsSync(ebBin) ? `"${ebBin}"` : "electron-builder";

run(`${eb} --win --x64`);

console.log("\n✓  Build complete.");
console.log("   Installer : release/Orca Setup *.exe");
console.log("   Portable  : release/Orca *.exe");
