import { describe, expect, it, vi } from "vitest";
import type { PappyResult } from "@clawde/pappy-core";
import { handleRepairLoop } from "./repairLoop.js";
import type { OrcaRunCtx, OrcaTaskSpec, MaestroPort, PappyPort } from "./types.js";

function createFailResult(): PappyResult {
  return {
    verdict: "FAIL",
    confidence: 1,
    summary: "fail",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [{
      issueId: "TEST:READONLY",
      severity: "HIGH",
      code: "READONLY",
      category: "Safety",
      description: "should stay read-only",
      expected_receipt: "none",
      evidence: "test",
      fix_hint: "keep permissions",
      message: "keep permissions",
    }],
    repair_task: {
      title: "Answer the question accurately",
      steps: ["Read the file", "Return the answer"],
      required_proofs: [],
    },
    internalSummary: "fail",
  };
}

function createPassResult(): PappyResult {
  return {
    verdict: "PASS",
    confidence: 1,
    summary: "pass",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [],
    repair_task: null,
    internalSummary: "pass",
  };
}

describe("handleRepairLoop", () => {
  it("preserves permissions and outputFormat on repair specs", async () => {
    const originalTask: OrcaTaskSpec = {
      originalUserMessage: "Read package.json and summarize it",
      intent: "read package.json",
      goals: ["Read package.json", "Summarize it"],
      permissions: {
        fileRead: true,
        fileWrite: false,
        shellExec: false,
        toolsAllowed: ["read_file", "list_directory", "search_files"],
      },
      outputFormat: "prose",
    };

    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return {
          outputText: "- name: orca\n- test script: yes\n- workspaces: 2",
          summary: "reader result",
        };
      }),
    };

    const pappy: PappyPort = {
      evaluate: vi.fn(() => createPassResult()),
    };

    const ctx: OrcaRunCtx = {
      llm: { complete: vi.fn() as any },
      runId: "repair-test",
    };

    const emitter = { emit: vi.fn() } as any;

    await handleRepairLoop(
      originalTask,
      createFailResult(),
      ctx,
      maestro,
      pappy,
      emitter,
      1,
      "draft output",
      "reader",
    );

    expect(capturedSpecs).toHaveLength(1);
    expect(capturedSpecs[0]?.permissions).toEqual(originalTask.permissions);
    expect(capturedSpecs[0]?.outputFormat).toBe("prose");
  });
});
