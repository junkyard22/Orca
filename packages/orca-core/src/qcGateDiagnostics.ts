import type { GateResult, QCGateContext } from "@clawde/miranda-core";
import type { PappyResult } from "@clawde/pappy-core";
import type { OrcaMaestroResult, OrcaRunCtx } from "./types.js";

export interface BuildQCGateContextOptions {
  taskId: string;
  outputText: string;
  qcResult: PappyResult;
  qcStage: "initial" | "repair";
  attempt: number;
  maestroResult?: OrcaMaestroResult;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function buildQCGateContext(options: BuildQCGateContextOptions): QCGateContext {
  return {
    taskId: options.taskId,
    outputText: options.outputText,
    qcStage: options.qcStage,
    attempt: options.attempt,
    pappyVerdict: options.qcResult.verdict,
    issueCodes: uniqueStrings(options.qcResult.issues.map((issue) => issue.code)),
    issueTypes: uniqueStrings(options.qcResult.issues.map((issue) => issue.category)),
    confidence: options.qcResult.confidence,
    stoppedBecause: options.maestroResult?.metadata?.stoppedBecause,
  };
}

export function recordAfterQCGateDiagnostic(
  ctx: Pick<OrcaRunCtx, "recordTrace">,
  gateResult: GateResult,
  gateContext: QCGateContext,
): void {
  ctx.recordTrace?.("miranda.after_qc", {
    allowed: gateResult.allowed,
    gateVerdict: gateResult.verdict,
    reason: gateResult.reason,
    qcStage: gateContext.qcStage,
    attempt: gateContext.attempt,
    pappyVerdict: gateContext.pappyVerdict,
    issueCodes: gateContext.issueCodes,
    issueTypes: gateContext.issueTypes,
    confidence: gateContext.confidence,
    stoppedBecause: gateContext.stoppedBecause,
  });
}
