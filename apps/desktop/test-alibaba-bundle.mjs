/**
 * Builds and runs the Alibaba test via esbuild + Electron.
 * Step 1: esbuild bundles openaiCompat.ts into a temp CJS file.
 * Step 2: Electron loads the bundle and fires the request with the real decrypted key.
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES  = resolve(__dirname, "..", "..", "packages");
const OUT       = resolve(__dirname, "dist-main", "test-alibaba-tmp.cjs");

// Bundle openaiCompat + its dependencies into a CJS file
await build({
  bundle:       true,
  platform:     "node",
  format:       "cjs",
  target:       "node20",
  external:     ["electron"],
  entryPoints:  [resolve(PACKAGES, "miranda-core", "src", "llm", "openaiCompat.ts")],
  outfile:      OUT,
  logLevel:     "warning",
});

console.log("✓ Bundled to", OUT);
