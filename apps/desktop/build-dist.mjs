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
import { existsSync, copyFileSync, readFileSync } from "node:fs";
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
// Resolve the local bin — try several locations so this works on both
// Windows (electron-builder.cmd) and Linux/macOS (pnpm store).

import { readdirSync } from "node:fs";
import process from "node:process";

const workspaceRoot = resolve(__dirname, "..", "..");

function findEbInPnpmStore(root) {
  const pnpmStore = resolve(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmStore)) return null;
  try {
    const dirs = readdirSync(pnpmStore).filter((d) => d.startsWith("electron-builder@"));
    for (const dir of dirs) {
      const cli = resolve(pnpmStore, dir, "node_modules", "electron-builder", "cli.js");
      if (existsSync(cli)) return cli;
    }
  } catch {
    // ignore
  }
  return null;
}

let eb;
const ebCmd = resolve(__dirname, "node_modules", ".bin", "electron-builder.cmd");
const ebBin = resolve(__dirname, "node_modules", ".bin", "electron-builder");
const ebCli = findEbInPnpmStore(workspaceRoot) ?? findEbInPnpmStore(__dirname);

if (existsSync(ebCmd)) {
  eb = `"${ebCmd}"`;
} else if (existsSync(ebBin)) {
  eb = `"${ebBin}"`;
} else if (ebCli) {
  eb = `node "${ebCli}"`;
} else {
  eb = "electron-builder"; // last resort: must be on PATH
}

run(`${eb} --win --x64`);

// ── 3. Leave the provenance record beside the artifacts ───────────────────
// build-info.json already ships inside the asar, but reading it there means
// unpacking. A copy in release/ lets whoever produced the build identify these
// binaries at a glance — which is the check that was missing when the shipped
// EXE drifted three months behind main.
const infoSrc = resolve(__dirname, "dist-main", "build-info.json");
const infoDst = resolve(__dirname, "release", "build-info.json");
let info = null;
if (existsSync(infoSrc)) {
  copyFileSync(infoSrc, infoDst);
  info = JSON.parse(readFileSync(infoSrc, "utf8"));
}

console.log("\n✓  Build complete.");
console.log("   Installer : release/Orca Setup *.exe");
console.log("   Portable  : release/Orca *.exe");
if (info) {
  console.log(`   Built from: ${info.version} @ ${info.commitShort} (${info.ref})`);
  if (info.dirty) {
    console.log("   ⚠  WORKING TREE WAS DIRTY — this artifact is not reproducible from that commit.");
  }
}
