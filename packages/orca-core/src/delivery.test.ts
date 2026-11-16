import { describe, expect, it } from "vitest";
import { buildDeliveryEnvelope } from "./delivery.js";
import { buildTaskContract } from "./taskContract.js";
import type { TaskIntentKind } from "./taskContract.js";
import type { PappyResult } from "@clawde/pappy-core";
import { fileURLToPath } from "node:url";
import type { OrcaToolEvent } from "./types.js";
import { TaskLifecycle } from "./lifecycle.js";

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
      qcResult: qc(verdict, "verified"), priorToolEvents: [event] });
    expect(envelope.outcome).toBe("inspected");
    expect(envelope.status.join(" ")).toContain("package.json");
    expect(envelope.status.join(" ")).toMatch(/not independently checked/);
    expect(envelope.status.join(" ")).not.toMatch(/verified/i);
    expect(envelope.narration).toBe("none");
    for (const events of [[], [{ ...event, ok: false }], [{ ...event, tool: "write_file" }], [{ ...event, raw: { path: "other.json" } }]]) {
      expect(buildDeliveryEnvelope({ contract: c, result: { status: "SUCCESS", userFacingText: "I inspected package.json" },
        qcResult: qc(verdict), toolEvents: events }).outcome).toBe("completed_unverified");
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
