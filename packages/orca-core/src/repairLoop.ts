import type {
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  MaestroPort,
  PappyPort,
} from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";
import type { OrcaEmitter } from "./emitter.js";
import { buildPappyInput, normalizeMaestroResult } from "./helpers.js";

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
  initialOutputText?: string,
  originalRole?: string,
  budgetUsd?: number,
  spentSoFarUsd?: number,
): Promise<OrcaExecutionResult> {
  let currentQC = initialQCResult;
  // Seed with the initial output so we always have something to show
  let lastOutputText: string | undefined = initialOutputText;
  let spentUsd = spentSoFarUsd ?? 0;

  for (let pass = 1; pass <= maxPasses; pass++) {
    // ── Budget guard — abort before spending more ──────────────────────────
    if (budgetUsd && budgetUsd > 0 && spentUsd >= budgetUsd) {
      return {
        status: "WARN",
        userFacingText: lastOutputText,
        summary: `Budget cap $${budgetUsd.toFixed(4)} reached ($${spentUsd.toFixed(4)} spent). Skipped ${maxPasses - pass + 1} repair pass(es).`,
      };
    }
    emitter.emit({ type: "repair:start", taskId: ctx.runId, pass, maxPasses });

    // Build a first-class repair task so Maestro understands it as work,
    // not a raw blob of text.  Context carries everything Maestro needs to
    // know: what the original intent was, and exactly which issues to fix.
    
    // Preserve the original role in the repair task message so Brain routes
    // it back to the same role (e.g., reviewer) instead of a different one.
    const roleHint = originalRole ? `\n\nOriginal role: ${originalRole}\nRe-run using the ${originalRole} role.` : '';
    const repairSpec: OrcaTaskSpec = {
      originalUserMessage: `${currentQC.repairTask!}${roleHint}`,
      intent: "repair",
      goals: [
        ...originalTask.goals,
        "Fix all issues identified in the quality check — produce the corrected output, not a description of fixes",
      ],
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
            role: originalRole,
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

    emitter.emit({ type: "maestro:start", taskId: ctx.runId, attempt: pass, isRepair: true });
    const maestroResult = normalizeMaestroResult(await maestro.run(repairSpec, ctx));
    lastOutputText = maestroResult.outputText ?? lastOutputText;
    spentUsd += maestroResult.metadata?.costUsd ?? 0;
    emitter.emit({ type: "maestro:done", taskId: ctx.runId, attempt: pass, isRepair: true, hasOutput: !!maestroResult.outputText });

    // Evaluate THIS pass's maestroResult (latest artifacts) against the
    // ORIGINAL task constraints — the benchmark is always the user's goal,
    // never the repair spec.  "attempt: pass" lets Doctor correlate which
    // repair run produced which verdict.

    // Miranda: before_qc gate
    ctx.gate?.beforeQC({ taskId: ctx.runId, outputText: maestroResult.outputText ?? "" });

    const nextQC = pappy.evaluate(buildPappyInput(originalTask, maestroResult));

    // Miranda: after_qc gate
    ctx.gate?.afterQC(
      { taskId: ctx.runId, outputText: maestroResult.outputText ?? "" },
      nextQC.verdict,
      nextQC.issues.length,
    );

    emitter.emit({
      type: "qc:result",
      taskId: ctx.runId,
      attempt: pass,
      isRepair: true,
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
    userFacingText: lastOutputText,
    summary: `Still failing after ${maxPasses} repair pass(es).`,
  };
}
