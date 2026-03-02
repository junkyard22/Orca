/**
 * build-exe.mjs — build orca.exe via Node.js Single Executable Application.
 *
 * Steps:
 *   1. esbuild  — bundles src/index.ts + all workspace packages from source
 *                 into a single CJS file.  No pre-built dist/ needed.
 *   2. sea-config.json — tells Node.js where to find the bundle and the blob.
 *   3. node --experimental-sea-config — produces the binary blob.
 *   4. Copy node.exe → orca.exe
 *   5. postject   — injects the blob into the copy of node.exe.
 *
 * Usage:
 *   pnpm -C apps/runner build:exe
 *
 * Then run:
 *   .\apps\runner\orca.exe "Create a README for Orca"
 *   (place a .env with OPENROUTER_API_KEY next to the exe, or set it in your shell)
 */

import { build } from "esbuild";
import { copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ──────────────────────────────────────────────────────────────────

const DIST      = resolve(__dirname, "dist-exe");
const BUNDLE    = resolve(DIST, "bundle.cjs");
const SEA_CFG   = resolve(DIST, "sea-config.json");
const SEA_BLOB  = resolve(DIST, "sea.blob");
const EXE       = resolve(__dirname, "orca.exe");
const POSTJECT  = resolve(__dirname, "node_modules", ".bin", "postject");

// Map workspace package names directly to their TypeScript source so esbuild
// bundles everything in one pass — no need to run `pnpm build` first.
const PACKAGES  = resolve(__dirname, "..", "..", "packages");
const workspaceSrc = {
  "@clawde/miranda-core": resolve(PACKAGES, "miranda-core", "src", "index.ts"),
  "@clawde/pappy-core":   resolve(PACKAGES, "pappy-core",   "src", "index.ts"),
  "@clawde/orca-core":    resolve(PACKAGES, "orca-core",    "src", "index.ts"),
  "@clawde/benson-core":  resolve(PACKAGES, "benson-core",  "src", "index.ts"),
  "maestro-core":         resolve(PACKAGES, "maestro-core", "src", "index.ts"),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function step(label) {
  console.log(`\n\x1b[36m→\x1b[0m ${label}`);
}

function shell(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

// ── Build ──────────────────────────────────────────────────────────────────

step("Creating output directory...");
mkdirSync(DIST, { recursive: true });

// 1. Bundle
step("Bundling with esbuild (TypeScript → CJS)...");
await build({
  entryPoints:  ["src/index.ts"],
  bundle:       true,
  platform:     "node",
  format:       "cjs",       // SEA requires CommonJS
  target:       "node20",
  outfile:      BUNDLE,
  alias:        workspaceSrc,
  // Nothing is external — bundle everything (node built-ins are auto-excluded
  // by esbuild's --platform=node).
  logLevel:     "info",
});

// 2. SEA config
step("Writing sea-config.json...");
writeFileSync(
  SEA_CFG,
  JSON.stringify(
    {
      main:                         BUNDLE,
      output:                       SEA_BLOB,
      disableExperimentalSEAWarning: true,
      useCodeCache:                 true,
    },
    null,
    2,
  ),
);

// 3. Generate blob
step("Generating SEA blob (node --experimental-sea-config)...");
shell(`node --experimental-sea-config "${SEA_CFG}"`);

// 4. Copy node.exe → orca.exe
step(`Copying ${process.execPath} → orca.exe...`);
copyFileSync(process.execPath, EXE);

// 5. Inject blob
step("Injecting blob with postject...");
shell(
  `"${POSTJECT}" "${EXE}" NODE_SEA_BLOB "${SEA_BLOB}" ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
);

// ── Done ───────────────────────────────────────────────────────────────────

console.log("\n\x1b[32m✓  Built: apps/runner/orca.exe\x1b[0m");
console.log("");
console.log("  Place a .env file next to orca.exe (or export the var in your shell):");
console.log("    OPENROUTER_API_KEY=sk-or-v1-...");
console.log("");
console.log('  Run it:');
console.log('    .\\apps\\runner\\orca.exe "Create a README for Orca"');
console.log('    echo "Your prompt" | .\\apps\\runner\\orca.exe');
