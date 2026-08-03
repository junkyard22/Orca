import { describe, expect, it } from "vitest";
import type { PappyResult } from "@clawde/pappy-core";
import {
  buildQCGateContext,
  recordAfterQCGateDiagnostic,
} from "./qcGateDiagnostics.js";

describe("buildQCGateContext", () => {
  it("forwards missing receipt references to Miranda", () => {
    const qcResult: PappyResult = {
      verdict: "FAIL",
      trainingEligibility: "eligible",
      confidence: 0.8,
      summary: "Required receipt missing.",
      acceptance_criteria: [],
      claims: [],
      receipt_ledger: [
        {
          ref: "AC1",
          required_receipt: { type: "criterion_specific", details: "first criterion" },
          status: "PROVED",
          evidence: ["proof"],
        },
        {
          ref: "AC2",
          required_receipt: { type: "criterion_specific", details: "second criterion" },
          status: "MISSING",
          evidence: [],
        },
      ],
      issues: [],
      repair_task: null,
      internalSummary: "verdict=FAIL 1xHIGH",
    };

    const context = buildQCGateContext({
      taskId: "task-1",
      outputText: "partial output",
      qcResult,
      qcStage: "initial",
      attempt: 0,
    });

    expect(context.missingReceiptRefs).toEqual(["AC2"]);
  });

  it("records missing receipt references in the structured Miranda trace", () => {
    const traces: Array<{ stage: string; data?: Record<string, unknown> }> = [];

    recordAfterQCGateDiagnostic(
      {
        recordTrace(stage, data) {
          traces.push({ stage, data });
        },
      },
      {
        allowed: false,
        verdict: "BLOCK",
        reason: "QC consistency violation",
      },
      {
        taskId: "task-1",
        outputText: "partial output",
        pappyVerdict: "PASS",
        missingReceiptRefs: ["AC2"],
      },
    );

    expect(traces).toEqual([
      expect.objectContaining({
        stage: "miranda.after_qc",
        data: expect.objectContaining({ missingReceiptRefs: ["AC2"] }),
      }),
    ]);
  });
});
