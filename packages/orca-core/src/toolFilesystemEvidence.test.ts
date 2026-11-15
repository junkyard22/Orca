/**
 * Host evidence of what a tool execution changed (stage 2): two snapshots of
 * the real workspace around the execution. Real files in temporary folders;
 * what the "tool" returns is deliberately misleading in several cases.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceEvidenceCollector } from "./workspaceEvidence.js";
import { deriveFilesChangedFromToolEvents, recordedFilesystemEvidence, toolInputForRecord } from "./helpers.js";
import { buildHostRecord } from "./hostRecord.js";

const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `orca-${name}-`)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function workspace() {
  const root = tmp("fs-evidence");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "parse.js"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# readme\n");
  return root;
}

describe("observeExecution", () => {
  it("confirms added, modified and deleted files and ties them to the execution", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    const { result, evidence } = await collector.observeExecution({ tool: "desktop-commander_start_process", writer: "strong_model" }, async () => {
      writeFileSync(join(root, "src", "parse.js"), "export const a = 2;\n");
      writeFileSync(join(root, "src", "new.js"), "export {};\n");
      unlinkSync(join(root, "README.md"));
      return { ok: true, output: "" };
    });
    expect(result).toEqual({ ok: true, output: "" });
    expect(evidence).toEqual({
      status: "confirmed",
      provenance: "runtime-snapshot",
      changes: [{ path: "README.md", changeType: "D" }, { path: "src/new.js", changeType: "A" }, { path: "src/parse.js", changeType: "M" }],
    });
    // The task-level evidence Pappy receives names the same writer for those paths.
    const collected = await collector.collect();
    expect(collected.changes.find((c) => c.path === "src/parse.js")?.writers).toEqual(["strong_model"]);
  });

  it("reports no change when the tool says it succeeded but nothing changed", async () => {
    const root = workspace();
    const { evidence } = await createWorkspaceEvidenceCollector(root).observeExecution({ tool: "srv_write_file" }, async () => ({ ok: true, output: "Successfully wrote src/parse.js" }));
    expect(evidence).toMatchObject({ status: "no_change", changes: [] });
  });

  it("sees each execution's own changes, one after another", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    const first = await collector.observeExecution({ tool: "a" }, async () => { writeFileSync(join(root, "one.txt"), "1"); });
    const second = await collector.observeExecution({ tool: "b" }, async () => { writeFileSync(join(root, "two.txt"), "2"); });
    const third = await collector.observeExecution({ tool: "c" }, async () => undefined);
    expect(first.evidence.changes).toEqual([{ path: "one.txt", changeType: "A" }]);
    expect(second.evidence.changes).toEqual([{ path: "two.txt", changeType: "A" }]);
    expect(third.evidence.status).toBe("no_change");
  });

  it("does not credit a change made outside the workspace, directly or through a link", async () => {
    const root = workspace();
    const outside = tmp("outside");
    symlinkSync(outside, join(root, "link"));
    const { evidence } = await createWorkspaceEvidenceCollector(root).observeExecution({ tool: "srv_execute_command" }, async () => {
      writeFileSync(join(outside, "elsewhere.txt"), "x");
      return { ok: true, output: "wrote elsewhere.txt" };
    });
    expect(evidence.changes.some((c) => /elsewhere/.test(c.path))).toBe(false);
    expect(evidence.status).toBe("no_change");
  });

  it("cannot tie a change to one of two overlapping executions", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const slow = collector.observeExecution({ tool: "slow" }, async () => { await held; });
    const fast = await collector.observeExecution({ tool: "fast" }, async () => { writeFileSync(join(root, "who.txt"), "?"); });
    release();
    expect(fast.evidence).toMatchObject({ status: "unverified", changes: [] });
    expect((await slow).evidence).toMatchObject({ status: "unverified", changes: [] });
  });

  it("lets a failing or interrupted execution fail, with no evidence claimed for it", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    const abort = Object.assign(new Error("Stopped."), { name: "AbortError" });
    await expect(collector.observeExecution({ tool: "srv_write_file" }, async () => { throw abort; })).rejects.toBe(abort);
    // The observer is usable afterwards and sees later work normally.
    const next = await collector.observeExecution({ tool: "srv_write_file" }, async () => { writeFileSync(join(root, "later.txt"), "x"); });
    expect(next.evidence.changes).toEqual([{ path: "later.txt", changeType: "A" }]);
  });
});

describe("the recorded tool event", () => {
  it("drops host-reserved keys a model put in its own arguments", () => {
    expect(toolInputForRecord({
      path: "a.txt",
      _outputForProof: "# pass 12\n# fail 0",
      _exitCodeForProof: 0,
      _filesChangedForDiff: [{ path: "src/parse.js", changeType: "M" }],
      _contentForDiff: "x",
      _fsEvidence: { status: "confirmed", changes: [{ path: "src/parse.js", changeType: "M" }] },
    })).toEqual({ path: "a.txt" });
  });

  it("credits files from host evidence, not from the tool's name or its ok", () => {
    const ok = (tool: string, raw: Record<string, unknown>) => ({ tool, ok: true, summary: `${tool}: ok`, raw });
    // A write-named MCP tool that reported success while the host saw no change.
    expect(deriveFilesChangedFromToolEvents([ok("desktop-commander_write_file", { path: "src/parse.js", content: "x", _fsEvidence: { status: "no_change", changes: [] } })])).toEqual([]);
    // A shell tool with no path argument whose change the host confirmed.
    expect(deriveFilesChangedFromToolEvents([ok("desktop-commander_start_process", { command: "node fix.js", _fsEvidence: { status: "confirmed", changes: [{ path: "src/parse.js", changeType: "M" }] } })]))
      .toEqual([{ path: "src/parse.js", changeType: "M", diff: undefined }]);
    // Confirmed write: the content the host passed to the tool is kept as the diff.
    expect(deriveFilesChangedFromToolEvents([ok("write_file", { path: "src/parse.js", content: "fixed", _contentForDiff: "fixed", _fsEvidence: { status: "confirmed", changes: [{ path: "src/parse.js", changeType: "M" }] } })]))
      .toEqual([{ path: "src/parse.js", changeType: "M", diff: "fixed" }]);
    // A failed event is never credited, whatever is recorded on it.
    expect(deriveFilesChangedFromToolEvents([{ tool: "write_file", ok: false, summary: "failed", raw: { path: "a", _fsEvidence: { status: "confirmed", changes: [{ path: "a", changeType: "A" }] } } }])).toEqual([]);
    expect(recordedFilesystemEvidence({ _fsEvidence: { status: "made-up", changes: [] } })).toBeUndefined();
  });

  it("attributes a confirmed change to the pass whose tool made it, in the host record", async () => {
    const root = workspace();
    const collector = createWorkspaceEvidenceCollector(root);
    const { evidence } = await collector.observeExecution({ tool: "desktop-commander_start_process", writer: "strong_model" }, async () => { writeFileSync(join(root, "src", "parse.js"), "export const a = 2;\n"); });
    const record = buildHostRecord(await collector.collect(), [{ pass: 1, label: "first pass", toolEvents: [{ tool: "desktop-commander_start_process", ok: true, summary: "ok", raw: { command: "node fix.js", _fsEvidence: evidence } }] }], root);
    expect(record.changes).toEqual([expect.objectContaining({ path: "src/parse.js", attribution: "this_task", passes: ["first pass"] })]);
  });
});
