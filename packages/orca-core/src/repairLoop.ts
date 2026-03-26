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
import { throwIfAborted } from "./abort.js";

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
  initialErrorMessage?: string,
  initialGateBlockReason?: string,
): Promise<OrcaExecutionResult> {
  let currentQC = initialQCResult;
  // Seed with the initial output so we always have something to show
  let lastOutputText: string | undefined = initialOutputText;
  let spentUsd = spentSoFarUsd ?? 0;

  for (let pass = 1; pass <= maxPasses; pass++) {
    throwIfAborted(ctx.abortSignal);
    // ── Budget guard — abort before spending more ──────────────────────────
    if (budgetUsd && budgetUsd > 0 && spentUsd >= budgetUsd) {
      ctx.recordTrace?.("repair.budget_stop", {
        pass,
        maxPasses,
        budgetUsd,
        spentUsd,
        lastOutputText,
      });
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
      permissions: originalTask.permissions,
      outputFormat: originalTask.outputFormat,
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
    ctx.recordTrace?.("repair.pass.spec", {
      pass,
      maxPasses,
      originalRole,
      repairSpec,
    });

    emitter.emit({ type: "maestro:start", taskId: ctx.runId, attempt: pass, isRepair: true });
    const maestroResult = normalizeMaestroResult(await maestro.run(repairSpec, ctx));
    lastOutputText = maestroResult.outputText ?? lastOutputText;
    spentUsd += maestroResult.metadata?.costUsd ?? 0;
    ctx.recordTrace?.("repair.pass.maestro_result", {
      pass,
      spentUsd,
      maestroResult,
    });
    emitter.emit({ type: "maestro:done", taskId: ctx.runId, attempt: pass, isRepair: true, hasOutput: !!maestroResult.outputText });

    // Evaluate THIS pass's maestroResult (latest artifacts) against the
    // ORIGINAL task constraints — the benchmark is always the user's goal,
    // never the repair spec.  "attempt: pass" lets Doctor correlate which
    // repair run produced which verdict.

    throwIfAborted(ctx.abortSignal);

    // Miranda: before_qc gate
    ctx.gate?.beforeQC({ taskId: ctx.runId, outputText: maestroResult.outputText ?? "" });

    const nextQC = pappy.evaluate(buildPappyInput(originalTask, maestroResult));
    ctx.recordTrace?.("repair.pass.qc_result", {
      pass,
      verdict: nextQC.verdict,
      confidence: nextQC.confidence,
      issues: nextQC.issues,
      repairTask: nextQC.repairTask,
      internalSummary: nextQC.internalSummary,
    });

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
      ctx.recordTrace?.("repair.pass.success", {
        pass,
        summary: nextQC.internalSummary,
      });
      return {
        status: "SUCCESS",
        userFacingText: maestroResult.outputText,
        summary: nextQC.internalSummary,
        artifacts: maestroResult,
      };
    }

    if (!nextQC.repairTask) {
      ctx.recordTrace?.("repair.pass.stopped_no_repair_task", { pass });
      break;
    }
    currentQC = nextQC;
  }

  ctx.recordTrace?.("repair.exhausted", {
    maxPasses,
    lastOutputText,
  });
  const failureSuffix = initialErrorMessage
    ? ` Agent error: ${initialErrorMessage}`
    : initialGateBlockReason
      ? ` ${initialGateBlockReason}`
      : '';
  return {
    status: "FAIL",
    userFacingText: lastOutputText,
    summary: `Still failing after ${maxPasses} repair pass(es).${failureSuffix}`,
  };
}
