import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest config for @clawde/runner.
 *
 * Aliases workspace packages to their TypeScript source so pipeline tests
 * always run against current code — no stale-dist build required.
 * Only packages actively edited for trust/output guarantees are aliased;
 * other workspace packages continue to use their compiled dist.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@clawde/benson-core",
        replacement: resolve(__dirname, "../../packages/benson-core/src/index.ts"),
      },
      {
        find: "@clawde/orca-core",
        replacement: resolve(__dirname, "../../packages/orca-core/src/index.ts"),
      },
      {
        find: "maestro-core",
        replacement: resolve(__dirname, "../../packages/maestro-core/src/index.ts"),
      },
      {
        find: "@clawde/miranda-core",
        replacement: resolve(__dirname, "../../packages/miranda-core/src/index.ts"),
      },
      {
        find: "@clawde/pappy-core",
        replacement: resolve(__dirname, "../../packages/pappy-core/src/index.ts"),
      },
      {
        find: "@clawde/dewey-core",
        replacement: resolve(__dirname, "../../packages/dewey-core/src/index.ts"),
      },
      {
        find: "@clawde/tool-bootstrap",
        replacement: resolve(__dirname, "../../packages/tool-bootstrap/src/index.ts"),
      },
      {
        find: "@yakstacks/workbench-core",
        replacement: resolve(__dirname, "../../packages/workbench-core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
