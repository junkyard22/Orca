import type {
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  MaestroPort,
  PappyPort,
} from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";
import type { OrcaEmitter } from "./emitter.js";
import { buildPappyInput } from "./helpers.js";

/**
 * Called when Pappy returns FAIL on the initial generation pass.
 *
 * Each pass:
 *   1. Build a proper "repair" OrcaTaskSpec — intent: "repair", structured
 *      context carries the original task + every issue Pappy found.
 *   2. maestro.run(repairSpec, ctx) — Maestro is always the "doer".
 *   3. pappy.evaluate() re-judges — Pappy is always the "judge".
 *   4. PASS/WARN → return SUCCESS. FAIL → next pass or cap out.
 *
 * Maestro never calls Miranda directly; ctx.llm (Miranda-backed) is the
 * only model surface it touches.
 */
export async function handleRepairLoop(
  originalTask: OrcaTaskSpec,
  initialQCResult: PappyResult,
  ctx: OrcaRunCtx,
  maestro: MaestroPort,
  pappy: PappyPort,
  emitter: OrcaEmitter,
  maxPasses: number,
): Promise<OrcaExecutionResult> {
  let currentQC = initialQCResult;

  for (let pass = 1; pass <= maxPasses; pass++) {
    emitter.emit({ type: "repair:start", pass, maxPasses });

    // Build a first-class repair task so Maestro understands it as work,
    // not a raw blob of text.  Context carries everything Maestro needs to
    // know: what the original intent was, and exactly which issues to fix.
    const repairSpec: OrcaTaskSpec = {
      originalUserMessage: currentQC.repairTask!,
      intent: "repair",
      goals: ["Fix all issues identified in the quality check"],
      constraints: originalTask.constraints,
      context: {
        ...originalTask.context,
        repair: {
          pass,
          maxPasses,
          original: {
            intent: originalTask.intent,
            goals: originalTask.goals,
            message: originalTask.originalUserMessage,
          },
          issues: currentQC.issues.map((i) => ({
            severity:    i.severity,
            code:        i.code,
            message:     i.message,
            suggestedFix: i.suggestedFix,
          })),
        },
      },
    };

    emitter.emit({ type: "maestro:start" });
    const maestroResult = await maestro.run(repairSpec, ctx);
    emitter.emit({ type: "maestro:done", hasOutput: !!maestroResult.outputText });

    // Always re-evaluate against the ORIGINAL task constraints, not the
    // repair spec — we're checking if the output satisfies the user's goal.
    const nextQC = pappy.evaluate(buildPappyInput(originalTask, maestroResult));
    emitter.emit({
      type: "qc:result",
      verdict: nextQC.verdict,
      issueCount: nextQC.issues.length,
    });

    if (nextQC.verdict !== "FAIL") {
      return {
        status: "SUCCESS",
        userFacingText: maestroResult.outputText,
        summary: nextQC.internalSummary,
        artifacts: maestroResult,
      };
    }

    if (!nextQC.repairTask) break; // Pappy can't produce further guidance
    currentQC = nextQC;
  }

  return {
    status: "FAIL",
    summary: `Still failing after ${maxPasses} repair pass(es).`,
  };
}
