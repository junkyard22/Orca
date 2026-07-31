import { evaluateWithPappy } from "@clawde/pappy-core";
import type { PappyInput, PappyResult } from "@clawde/pappy-core";
import type { JudgeFn, JudgeOutput, RunPacket, TrainingEligibility, Verdict } from "../types.js";

// ---------------------------------------------------------------------------
// Mode 1: raw-real-pappy
//
// Calls the actual current packages/pappy-core implementation as faithfully
// as possible. No anti-cheat logic, no extra semantic reasoning, nothing
// invented on top of what real Pappy already does — the point is to measure
// today's Pappy as it actually exists, even if the score is bad.
//
// See GAPS.md for the precise list of what pappy-core cannot see or check
// through this mapping.
// ---------------------------------------------------------------------------

/**
 * Mechanical RunPacket -> PappyInput mapping. Exported so other judges
 * (e.g. pappy-plus-hardening) can call real Pappy through the exact same,
 * un-embellished translation rather than re-deriving their own.
 */
export function toPappyInput(packet: RunPacket): PappyInput {
  return {
    task: packet.task,
    goals: packet.acceptanceCriteria,
    // PappyInput has a single outputText field for "what the agent says it did" —
    // there is no separate slot for diffSummary or testOutput (see GAPS.md).
    outputText: packet.agentClaim,
    filesChanged: packet.filesChanged,
    toolEvents: packet.toolTrace.map((t) => ({ tool: t.tool, ok: t.ok, summary: t.summary })),
  };
}

export function mapPappyVerdict(verdict: PappyResult["verdict"]): Verdict {
  // pappy-core is a 3-state gate (PASS/WARN/FAIL). It has no concept of an
  // ambiguous "needs_human_review" state, so that target verdict is
  // structurally unreachable through this mapping.
  switch (verdict) {
    case "PASS":
      return "accept";
    case "WARN":
      return "repair";
    case "FAIL":
      return "reject";
  }
}

function mapTrainingEligibility(result: PappyResult): TrainingEligibility {
  // pappy-core now derives this itself. The harness reports what Pappy said
  // rather than substituting a conservative default for a missing field.
  return result.trainingEligibility;
}

/** Maps a real PappyResult onto the harness's JudgeOutput shape with no added judgment. */
export function pappyResultToJudgeOutput(result: PappyResult): JudgeOutput {
  const actionableIssues = result.issues.filter((i) => i.severity !== "LOW");

  const evidenceUsed = [...new Set(result.receipt_ledger.flatMap((entry) => entry.evidence))];

  return {
    verdict: mapPappyVerdict(result.verdict),
    confidence: result.confidence,
    trainingEligibility: mapTrainingEligibility(result),
    deterministicFindings: [
      ...result.issues.map((i) => `[${i.code}] ${i.description}`),
    ],
    evidenceUsed,
    failureReasons: actionableIssues.map((i) => i.description),
    recommendedRepair: result.repairTask ?? "",
  };
}

export function rawRealPappyJudgeFn(packet: RunPacket): JudgeOutput {
  return pappyResultToJudgeOutput(evaluateWithPappy(toPappyInput(packet)));
}

export const rawRealPappyJudge: JudgeFn = rawRealPappyJudgeFn;
