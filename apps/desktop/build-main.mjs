/**
 * build-main.mjs — bundle Electron main + preload with esbuild.
 * Points directly at workspace TypeScript source via alias map,
 * so no `pnpm build` of packages is required first.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES  = resolve(__dirname, "..", "..", "packages");

mkdirSync("dist-main", { recursive: true });

const shared = {
  bundle:   true,
  platform: "node",
  format:   "cjs",
  target:   "node20",
  external: ["electron"],   // never bundle Electron itself
  // Use banner to define a cached electron reference that works at runtime
  banner: {
    js: `const electron = require("electron");`
  },
  alias: {
    "@clawde/miranda-core":    resolve(PACKAGES, "miranda-core",    "src", "index.ts"),
    "@clawde/pappy-core":      resolve(PACKAGES, "pappy-core",      "src", "index.ts"),
    "@clawde/orca-core":       resolve(PACKAGES, "orca-core",       "src", "index.ts"),
    "@clawde/benson-core":     resolve(PACKAGES, "benson-core",     "src", "index.ts"),
    "@clawde/dewey-core":      resolve(PACKAGES, "dewey-core",      "src", "index.ts"),
    "@clawde/secretary-core":  resolve(PACKAGES, "secretary-core",  "src", "index.ts"),
    "maestro-core":            resolve(PACKAGES, "maestro-core",    "src", "index.ts"),
  },
  logLevel: "warning",
  logOverride: { "empty-import-meta": "silent" },
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"],    outfile: "dist-main/main.js"    }),
  build({ ...shared, entryPoints: ["src/preload.ts"], outfile: "dist-main/preload.js" }),
]);

// Copy sql-wasm.wasm (sql.js loads it at runtime from the same directory as main.js)
const wasmSrc = resolve(__dirname, "..", "..", "node_modules", ".pnpm", "sql.js@1.14.1", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
if (existsSync(wasmSrc)) {
  copyFileSync(wasmSrc, resolve(__dirname, "dist-main", "sql-wasm.wasm"));
}

console.log("✓  dist-main/main.js + preload.js");
