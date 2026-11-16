import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeliveryEnvelope } from "./delivery.js";
import { buildTaskContract } from "./taskContract.js";
import type { TaskIntentKind } from "./taskContract.js";
import type { PappyResult } from "@clawde/pappy-core";
import { fileURLToPath } from "node:url";
import type { OrcaToolEvent } from "./types.js";
import { TaskLifecycle } from "./lifecycle.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const contract = (kind: TaskIntentKind = "conversation", request = "Explain the result") => buildTaskContract({
  task: { originalUserMessage: request, intent: "label", goals: [request] }, proposal: { kind }, ceiling: [], workspace: "ok",
});
const qc = (verdict: PappyResult["verdict"], evidence: "verified" | "unverified" = "unverified"): PappyResult => ({
  verdict, verification: { status: evidence, taskKind: "other", reasons: ["host evidence status"], testEvidence: false },
  issues: verdict === "FAIL" ? [{ issueId: "issue", code: "PROOF_MISSING", severity: "HIGH", category: "Proof", description: "The required proof is missing.",
    expected_receipt: "proof", evidence: "", fix_hint: "Supply proof", message: "The required proof is missing." }] : [],
  confidence: 0, trainingEligibility: "needs_human_review", summary: "QC", acceptance_criteria: [], claims: [], receipt_ledger: [],
  repair_task: null, internalSummary: "QC",
});

describe("delivery envelopes", () => {
  describe("PR108 host-recorded workspace reads", () => {
    let root: string;
    let outside: string;
    beforeEach(() => {
      root = mkdtempSync(join(realpathSync.native(tmpdir()), "orca-delivery-"));
      outside = mkdtempSync(join(tmpdir(), "orca-delivery-outside-"));
      mkdirSync(join(root, "src"));
      for (const file of ["a.ts", "b.ts"]) writeFileSync(join(root, "src", file), "export const value = 1;\n");
      writeFileSync(join(outside, "secret.ts"), "outside");
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const inspection = (names = "src/a.ts") => buildTaskContract({
      task: { originalUserMessage: `Explain ${names}`, intent: "inspect", goals: [] },
      proposal: { kind: "inspect", needs: ["filesystem-read", "shell"] }, ceiling: ["filesystem-read", "shell"], workspace: "ok", workspaceRoot: root,
    });
    const shell = (command: string, cwd = root): OrcaToolEvent => ({ tool: "run_command", ok: true, summary: "host recorded completion",
      raw: { command, cwd, _exitCodeForProof: 0, _execAuthority: { filesystemScope: "host", confinement: "none", approval: "confined_read" } } });
    const envelope = (events: OrcaToolEvent[], names = "src/a.ts") => buildDeliveryEnvelope({ contract: inspection(names),
      result: { status: "SUCCESS", userFacingText: "Explanation" }, qcResult: qc("PASS"), workspaceAuthority: { root, status: "ok", message: "" }, toolEvents: events });

    it.each(["cat src/a.ts", "head -n 2 src/a.ts", "tail -c 5 src/a.ts", ...(process.platform === "win32" ? ["type src\\a.ts"] : [])])(
      "recognizes named-file reading in a successfully executed confined command: %s", (command) => {
        const e = envelope([shell(command)]);
        expect(e.outcome).toBe("inspected");
        expect(e.status.join(" ")).toContain("src/a.ts");
        expect(e.status.join(" ")).not.toMatch(/verified/i);
      });
    it("resolves command operands from the recorded cwd and combines reads across passes", () => {
      const first = shell("cat a.ts", join(root, "src"));
      const second = shell("cat b.ts", "src");
      expect(envelope([first], "src/a.ts and src/b.ts").outcome).toBe("completed_unverified");
      const e = buildDeliveryEnvelope({ contract: inspection("src/a.ts and src/b.ts"), result: { status: "SUCCESS" }, qcResult: qc("PASS"),
        workspaceAuthority: { root, status: "ok", message: "" }, priorToolEvents: [first], toolEvents: [second] });
      expect(e.outcome).toBe("inspected");
      expect(e.status.join(" ")).toContain("src/b.ts");
    });

    it("does not infer shell execution from command text, stdout, approval alone or a failed/missing exit receipt", () => {
      const valid = shell("cat src/a.ts");
      const raw = valid.raw as Record<string, unknown>;
      for (const event of [
        { ...valid, ok: false },
        { ...valid, raw: { command: "cat src/a.ts", _outputForProof: "file contents" } },
        { ...valid, raw: { ...raw, _execAuthority: undefined } },
        { ...valid, raw: { ...raw, _exitCodeForProof: undefined } },
        { ...valid, raw: { ...raw, _exitCodeForProof: 1 } },
        { ...valid, raw: { ...raw, _execAuthority: { approval: "user_approved" } } },
        { ...valid, raw: { ...raw, _execAuthority: { approval: "host_policy" } } },
      ]) expect(envelope([event]).outcome).toBe("completed_unverified");
      expect(buildDeliveryEnvelope({ contract: inspection(), result: { status: "SUCCESS" }, qcResult: qc("PASS"), toolEvents: [valid] }).outcome)
        .toBe("completed_unverified"); // Recorded cwd cannot establish workspace authority.
    });

    it.each(["echo src/a.ts", "ls src/a.ts", "stat src/a.ts", "cat src/b.ts", "cat src/*.ts", "cat src/a.ts; echo done", "cat src/a.ts\ncat src/b.ts", 'cat "src/a.ts"', "head -n 0 src/a.ts"])(
      "does not invent a named-file read from an ambiguous, non-reading or unrelated command: %s", (command) => {
        const event = shell(command);
        (event.raw as Record<string, unknown>).paths = ["src/a.ts"];
        (event.raw as Record<string, unknown>)._outputForProof = "I read src/a.ts";
        expect(envelope([event]).outcome).toBe("completed_unverified");
      });

    it("requires the actual content-reader path, not a listing, metadata, extra argument or claimed output", () => {
      for (const event of [
        { tool: "list_directory", raw: { path: "src/a.ts" } },
        { tool: "get_file_info", raw: { path: "src/a.ts" } },
        { tool: "read_file", raw: { path: "src/b.ts", cwd: "src/a.ts" } },
        { tool: "read_file", raw: { path: "src/b.ts", _fsEvidence: { changes: [{ path: "src/a.ts" }] } } },
        { tool: "read_file", raw: { path: "src/b.ts", _outputForProof: "src/a.ts" } },
      ]) expect(envelope([{ ...event, ok: true, summary: "host recorded completion" }]).outcome).toBe("completed_unverified");
      expect(envelope([{ tool: "desktop-commander_read_file", ok: true, summary: "host recorded completion", raw: { path: "src/a.ts" } }]).outcome).toBe("inspected");
      const noRoot = buildDeliveryEnvelope({ contract: inspection(), result: { status: "SUCCESS" }, qcResult: qc("PASS"),
        toolEvents: [{ tool: "read_file", ok: true, summary: "read", raw: { path: "src/a.ts" } }] });
      expect(noRoot.outcome).toBe("completed_unverified");
    });

    it("keeps a remote connector's file read separate even when its relative filename matches a local file", () => {
      expect(envelope([{ tool: "github-mcp_read_file", ok: true, summary: "fetched remote contents", raw: { path: "src/a.ts" } }]).outcome)
        .toBe("completed_unverified");
      expect(envelope([{ tool: "read_multiple_files", ok: true, summary: "read", raw: { paths: ["src/a.ts", "src/b.ts"] } }], "src/a.ts and src/b.ts").outcome)
        .toBe("inspected");
    });

    it("matches native/Windows path spellings and in-workspace junction aliases, rejecting escaping paths and cwd", () => {
      symlinkSync(join(root, "src"), join(root, "inside"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      const file = join(root, "src", "a.ts");
      const names = [file, file.replace(/\\/g, "/"), join(root, "inside", "a.ts")];
      if (process.platform === "win32") names.push(file.toUpperCase());
      for (const name of names) {
        expect(envelope([{ tool: "read_file", ok: true, summary: "read", raw: { path: name } }]).outcome).toBe("inspected");
        expect(envelope([shell(`cat ${name}`)]).outcome).toBe("inspected");
      }
      for (const event of [shell("cat secret.ts", outside), shell("cat secret.ts", join(root, "escape")), shell(`cat ${join(outside, "secret.ts")}`),
        { tool: "read_file", ok: true, summary: "read", raw: { path: join(root, "escape", "secret.ts") } }]) {
        expect(envelope([event], "the parser").outcome).toBe("completed_unverified");
      }
    });
  });
  it("PR108: unrelated connector reads cannot satisfy a workspace inspection, including mixed external/workspace evidence", () => {
    for (const needs of [["filesystem-read"], ["filesystem-read", "github-read"]] as const) {
      const c = buildTaskContract({ task: { originalUserMessage: "Inspect the parser", intent: "inspect", goals: [] },
        proposal: { kind: "inspect", needs: [...needs] }, ceiling: [...needs], workspace: "ok" });
      const e = buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS" }, qcResult: qc("PASS"),
        toolEvents: [{ tool: "github-mcp_get_issue", ok: true, summary: "Fetched issue", raw: { path: "parser.ts" } }] });
      expect(e.outcome).toBe("completed_unverified");
      expect(e.narration).toBe("none");
      expect(c.evidence).toEqual({ workspace: true, external: needs.length > 1 });
    }
    const external = buildTaskContract({ task: { originalUserMessage: "Inspect the remote issue", intent: "inspect", goals: [] },
      proposal: { kind: "inspect", needs: ["github-read"] }, ceiling: ["github-read"], workspace: "not_configured" });
    expect(external.evidence).toEqual({ workspace: false, external: true });
    expect(buildDeliveryEnvelope({ contract: external, result: { status: "SUCCESS" }, qcResult: qc("PASS"),
      toolEvents: [{ tool: "github-mcp_get_issue", ok: true, summary: "Fetched issue" }] }).outcome).toBe("completed_unverified");
  });
  it("reports required capabilities withheld by settings or prohibitions as blocked, preserving body and guidance", () => {
    for (const prohibits of [[], ["filesystem-write"]] as const) {
      const c = buildTaskContract({ task: { originalUserMessage: "Fix the parser", intent: "fix", goals: [] },
        proposal: { kind: "modify", needs: ["filesystem-write"], prohibits: [...prohibits] }, ceiling: [], workspace: "ok" });
      const e = buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS", userFacingText: "partial response" }, qcResult: qc("PASS") });
      expect(e.outcome).toBe("blocked");
      expect(e.body).toBe("partial response");
      expect(e.status.length).toBeGreaterThan(0);
      expect(e.needsUser).toContain("filesystem-write");
      expect(e.narration).toBe("none");
    }
  });

  it.each(["not_configured", "missing", "not_a_directory", "filesystem_root"] as const)("blocks required workspace when authority is %s; conversation needs no workspace", (status) => {
    const c = buildTaskContract({ task: { originalUserMessage: "Inspect parser", intent: "inspect", goals: [] },
      proposal: { kind: "inspect", needs: ["filesystem-read"] }, ceiling: ["filesystem-read"], workspace: status });
    const e = buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS" }, workspaceAuthority: { status, message: "Choose a workspace." } });
    expect(e.outcome).toBe("blocked");
    expect(e.needsUser).toBe("Choose a workspace.");
    expect(e.status.length).toBeGreaterThan(0);
    expect(buildDeliveryEnvelope({ contract: contract(), result: { status: "SUCCESS" }, qcResult: qc("PASS"),
      workspaceAuthority: { status, message: "Choose a workspace." } }).outcome).toBe("answered");
    expect(buildDeliveryEnvelope({ contract: c, result: { status: "FAIL" }, qcResult: qc("FAIL") }).outcome).toBe("failed");
  });

  it.each(["cancelled", "interrupted"])("maps %s lifecycle to stopped while retaining body, failure issues and evidence status", (state) => {
    const life = new TaskLifecycle({ taskId: "delivery" });
    if (state === "cancelled") life.cancel("user stopped");
    else life.interrupt("interrupted");
    const verdict = qc("FAIL");
    const e = buildDeliveryEnvelope({ contract: contract(), result: { status: "FAIL", userFacingText: "partial" }, qcResult: verdict, lifecycle: life.snapshot() });
    expect(e.outcome).toBe("stopped");
    expect(e.body).toBe("partial");
    expect(e.verification).toEqual(verdict.verification);
    expect(e.issues?.[0]?.description).toBe(verdict.issues[0]!.description);
    expect(e.narration).toBe("none");
  });

  it("T10/T11 pure part: lists refusals and blocked/unavailable tools on a passing task without hiding its body", () => {
    const e = buildDeliveryEnvelope({ contract: contract(), result: { status: "SUCCESS", userFacingText: "answer", followUpQuestion: "Enable the connector?" }, qcResult: qc("PASS"),
      refusals: [
        { tool: "run_command", operation: "npm test", outcome: "denied", at: "now", repeats: 1 },
        { tool: "run_command", operation: "npm run build", outcome: "timed_out", at: "now", repeats: 0 },
      ], toolEvents: [
        { tool: "missing_connector", ok: false, summary: "Unknown tool: missing_connector" },
        { tool: "write_file", ok: false, summary: "Miranda blocked: no writes" },
        { tool: "read_file", ok: true, summary: "done" },
      ] });
    expect(e.body).toBe("answer");
    expect(e.notDone?.join(" ")).toMatch(/npm test.*denied/i);
    expect(e.notDone?.join(" ")).toMatch(/npm run build.*timed out/i);
    expect(e.notDone?.join(" ")).toContain("missing_connector");
    expect(e.notDone?.join(" ")).toContain("Miranda blocked: no writes");
    expect(e.notDone?.join(" ")).not.toContain("read_file");
  });

  it("does not present a WARN runtime status or incomplete Pappy receipts as verified success", () => {
    const verdict = qc("PASS", "verified");
    expect(buildDeliveryEnvelope({ contract: contract("modify"), result: { status: "WARN" }, qcResult: verdict }).outcome).toBe("completed_unverified");
    verdict.receipt_ledger = [{ ref: "required", status: "MISSING", required_receipt: { type: "other", details: "required evidence" }, evidence: [] }];
    expect(buildDeliveryEnvelope({ contract: contract("modify"), result: { status: "SUCCESS" }, qcResult: verdict }).outcome).toBe("completed_unverified");
  });
  it.each(["PASS", "WARN"] as const)("inspected with %s names host-recorded reads and never calls the explanation verified", (verdict) => {
    const c = buildTaskContract({ task: { originalUserMessage: "Explain package.json", intent: "label", goals: [] },
      proposal: { kind: "inspect", needs: ["filesystem-read"] }, ceiling: ["filesystem-read"], workspace: "ok",
      workspaceRoot: fileURLToPath(new URL("../", import.meta.url)) });
    const event: OrcaToolEvent = { tool: "read_file", ok: true, summary: "read completed", raw: { path: "package.json" } };
    const envelope = buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS", userFacingText: "contents explained" },
      qcResult: qc(verdict, "verified"), priorToolEvents: [event], workspaceAuthority: { status: "ok", root: fileURLToPath(new URL("../", import.meta.url)), message: "" } });
    expect(envelope.outcome).toBe("inspected");
    expect(envelope.status.join(" ")).toContain("package.json");
    expect(envelope.status.join(" ")).toMatch(/not independently checked/);
    expect(envelope.status.join(" ")).not.toMatch(/verified/i);
    expect(envelope.narration).toBe("none");
    for (const events of [[], [{ ...event, ok: false }], [{ ...event, tool: "write_file" }], [{ ...event, raw: { path: "other.json" } }]]) {
      expect(buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS", userFacingText: "I inspected package.json" },
        qcResult: qc(verdict), toolEvents: events, workspaceAuthority: { status: "ok", root: fileURLToPath(new URL("../", import.meta.url)), message: "" } }).outcome).toBe("completed_unverified");
    }
  });

  it("a bare tool ok or claimed read in output never establishes inspection", () => {
    const c = contract("inspect");
    for (const tool of ["write_file", "run_command", "unknown_tool"]) {
      expect(buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS", userFacingText: "I read package.json" }, qcResult: qc("PASS"),
        toolEvents: [{ tool, ok: true, summary: "I read package.json", raw: { _outputForProof: "read package.json" } }] }).outcome).toBe("completed_unverified");
    }
  });
  it.each([
    ["conversation", "PASS", "verified", "answered"],
    ["conversation", "WARN", "verified", "answered"],
    ["conversation", undefined, "verified", "completed_unverified"],
    ["inspect", "PASS", "unverified", "completed_unverified"],
    ["modify", "PASS", "verified", "verified"],
    ["execute", "PASS", "verified", "verified"],
    ["modify", "WARN", "verified", "completed_unverified"],
    ["execute", "WARN", "verified", "completed_unverified"],
    ["modify", "PASS", "unverified", "completed_unverified"],
    ["modify", undefined, "verified", "completed_unverified"],
    ["conversation", "FAIL", "verified", "failed"],
    ["inspect", "FAIL", "verified", "failed"],
    ["modify", "FAIL", "verified", "failed"],
    ["execute", "FAIL", "verified", "failed"],
  ] as const)("section 5.8: %s / %s / %s => %s", (kind, verdict, evidence, outcome) => {
    const envelope = buildDeliveryEnvelope({ contract: contract(kind), result: { status: verdict === "FAIL" ? "FAIL" : "SUCCESS", userFacingText: "body" },
      ...(verdict ? { qcResult: qc(verdict, evidence) } : {}) });
    expect(envelope.outcome).toBe(outcome);
    expect(envelope.body).toBe("body");
    expect(envelope.status.length).toBeGreaterThan(0);
    expect(envelope.narration).toBe(outcome === "verified" ? "lead_in" : "none");
    if (verdict === "WARN" || !verdict) expect(envelope.status.join(" ")).toMatch(/not verified/i);
  });

  it.each([undefined, "PASS", "WARN", "FAIL"] as const)("T13: no contract with verdict %s never invents verified success", (verdict) => {
    const envelope = buildDeliveryEnvelope({ result: { status: "SUCCESS", userFacingText: "audit result" },
      ...(verdict ? { qcResult: qc(verdict, "verified") } : {}) });
    expect(envelope.outcome).toBe(verdict === "FAIL" ? "failed" : "completed_unverified");
    expect(envelope.narration).toBe("none");
  });

  it("does not override runtime failure, or promote disputed kinds even with verified PASS evidence", () => {
    expect(buildDeliveryEnvelope({ contract: contract(), result: { status: "FAIL" }, qcResult: qc("PASS", "verified") }).outcome).toBe("failed");
    const disputed = contract("inspect", "Fix the off-by-one bug in the parser");
    const envelope = buildDeliveryEnvelope({ contract: disputed, result: { status: "SUCCESS" }, qcResult: qc("PASS", "verified") });
    expect(envelope.outcome).toBe("completed_unverified");
    expect(envelope.status).toContain("Orca treated this as a question and changed nothing.");
    expect(envelope.narration).toBe("none");
  });

  it("preserves WARN issues and missing-verdict body; never hides a long response", () => {
    const verdict = qc("WARN", "verified");
    verdict.issues = qc("FAIL").issues.map((i) => ({ ...i, severity: "MEDIUM" }));
    const body = "x".repeat(20_000);
    const envelope = buildDeliveryEnvelope({ contract: contract("modify"), result: { status: "WARN", userFacingText: body }, qcResult: verdict });
    expect(envelope.body).toBe(body);
    expect(envelope.outcome).toBe("completed_unverified");
    expect(envelope.issues).toEqual([{ code: "PROOF_MISSING", description: "The required proof is missing." }]);
    expect(envelope.verification).toEqual(verdict.verification);
    expect(envelope.status.join(" ")).toMatch(/not verified/i);
    expect(buildDeliveryEnvelope({ result: { status: "SUCCESS", userFacingText: body } }).body).toBe(body);
  });
  it("approved section 5.8 correction: conversation FAIL remains failed with the exact body, verification status and every Pappy issue", () => {
    const result = { status: "FAIL" as const, userFacingText: "  The original response\n" };
    const verdict = qc("FAIL");
    const envelope = buildDeliveryEnvelope({ contract: contract(), result, qcResult: verdict });
    expect(envelope.outcome).toBe("failed");
    expect(envelope.body).toBe(result.userFacingText);
    expect(envelope.verification).toEqual(verdict.verification);
    expect(envelope.issues).toEqual(verdict.issues.map(({ code, description }) => ({ code, description })));
    expect(envelope.status.length).toBeGreaterThan(0);
    expect(envelope.status.join(" ")).toMatch(/failed|not verified/i);
    expect(envelope.narration).toBe("none");
  });
});
