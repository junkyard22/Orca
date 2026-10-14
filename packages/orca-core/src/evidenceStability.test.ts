/**
 * Evidence stability — what the host records about a workspace that keeps
 * changing: a test run is tied to the source it ran on, every changed path
 * names who wrote it, and two workers writing one file in the same pass is
 * reported as contested rather than silently merged.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceEvidenceCollector } from "./workspaceEvidence.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-evidence-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "src", "a.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "src", "b.js"), "module.exports = 2;\n");
  writeFileSync(join(root, "src", "a.test.js"), "require('node:test')('a', () => {});\n");
  return root;
}

const call = (role: string, tool: string, input: Record<string, unknown>) => ({ role, tool, input });
const testRun = (ok: boolean) => ({ tool: "run_command", input: { command: "npm test" }, result: { ok, output: ok ? "# pass 2\n# fail 0" : "# pass 1\n# fail 1" } });

describe("evidence stability", () => {
  it("a passing test run followed by another source change proves an intermediate state, not the final one", async () => {
    const root = project();
    const collector = createWorkspaceEvidenceCollector(root);
    collector.observeTrace("maestro.run.start", {});
    writeFileSync(join(root, "src", "a.js"), "module.exports = 10;\n");
    collector.observeTrace("agent.tool.call", call("engineer", "write_file", { path: "src/a.js" }));
    collector.observeTrace("agent.tool.result", testRun(true));           // tests pass on a.js = 10
    writeFileSync(join(root, "src", "a.js"), "module.exports = 11;\n");   // then the source changes again
    collector.observeTrace("agent.tool.call", call("engineer", "write_file", { path: "src/a.js" }));
    const evidence = await collector.collect();
    expect(evidence.testRuns?.map((r) => r.sourceState)).toEqual(["intermediate"]);
    expect(evidence.changes.map((c) => [c.path, c.writers])).toEqual([["src/a.js", ["engineer"]]]);
    expect(evidence.contested).toBeUndefined();
  });

  it("a test run on the final source is 'final'; one before any change is 'baseline'", async () => {
    const root = project();
    const collector = createWorkspaceEvidenceCollector(root);
    collector.observeTrace("agent.tool.result", testRun(false));          // reproduction on the baseline
    writeFileSync(join(root, "src", "a.js"), "module.exports = 10;\n");
    collector.observeTrace("agent.tool.result", testRun(true));           // on the final source
    const evidence = await collector.collect();
    expect(evidence.testRuns?.map((r) => r.sourceState)).toEqual(["baseline", "final"]);
  });

  it("two workers writing different files are attributed separately; two workers writing the same file in one pass are contested", async () => {
    const root = project();
    const collector = createWorkspaceEvidenceCollector(root);
    collector.observeTrace("maestro.run.start", {});
    writeFileSync(join(root, "src", "a.js"), "module.exports = 10;\n");
    writeFileSync(join(root, "src", "b.js"), "module.exports = 20;\n");
    collector.observeTrace("agent.tool.call", call("engineer", "write_file", { path: "src/a.js" }));
    collector.observeTrace("agent.tool.call", call("debugger", "write_file", { path: join(root, "src", "b.js") })); // absolute path, same root
    collector.observeTrace("agent.tool.call", call("debugger", "mcp:desktop_commander:edit_block", { file_path: "src/a.js" })); // a connector editor
    const evidence = await collector.collect();
    expect(evidence.changes.map((c) => [c.path, c.writers])).toEqual([["src/a.js", ["engineer", "debugger"]], ["src/b.js", ["debugger"]]]);
    expect(evidence.contested).toEqual([{ path: "src/a.js", writers: ["engineer", "debugger"] }]);
  });

  it("the same file written by different workers in different passes (a repair after a rejection) is sequential, not contested", async () => {
    const root = project();
    const collector = createWorkspaceEvidenceCollector(root);
    collector.observeTrace("maestro.run.start", {});
    writeFileSync(join(root, "src", "a.js"), "module.exports = 10;\n");
    collector.observeTrace("agent.tool.call", call("engineer", "write_file", { path: "src/a.js" }));
    collector.observeTrace("repair.start", { pass: 1 });
    writeFileSync(join(root, "src", "a.js"), "module.exports = 11;\n");
    collector.observeTrace("agent.tool.call", call("debugger", "write_file", { path: "src/a.js" }));
    const evidence = await collector.collect();
    expect(evidence.changes[0]).toMatchObject({ path: "src/a.js", writers: ["engineer", "debugger"] });
    expect(evidence.contested).toBeUndefined();
  });

  it("reads and command runs are not writes; a write without a path is ignored", async () => {
    const root = project();
    const collector = createWorkspaceEvidenceCollector(root);
    writeFileSync(join(root, "src", "a.js"), "module.exports = 10;\n");
    collector.observeTrace("agent.tool.call", call("reader", "read_file", { path: "src/a.js" }));
    collector.observeTrace("agent.tool.call", call("engineer", "run_command", { command: "sed -i s/1/10/ src/a.js" }));
    collector.observeTrace("agent.tool.call", call("engineer", "write_file", {}));
    const evidence = await collector.collect();
    expect(evidence.changes[0]?.writers).toBeUndefined();
  });
});
