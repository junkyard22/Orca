import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // demo/summit-app is the packaged meeting-room demo project. Its
    // node:test suite fails on purpose (that is the bug the demo fixes), so it
    // is exercised by src/offlineDemo.test.ts in a temp copy, never collected here.
    exclude: [...configDefaults.exclude, "demo/**"],
  },
});
