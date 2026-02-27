import type {
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  MaestroPort,
  PappyPort,
} from "./types.js";
import type { OrcaEmitter } from "./emitter.js";
import { buildPappyInput } from "./helpers.js";

/**
 * Called when Pappy returns FAIL on the initial generation pass.
 *
 * Each pass:
 *   1. Wrap Pappy's repairTask string as a new OrcaTaskSpec
 *   2. Maestro.run() produces a fresh OrcaMaestroResult
 *   3. Pappy re-evaluates — if PASS/WARN, return SUCCESS
 *   4. If still FAIL and Pappy has another repairTask, repeat
 *   5. Cap at maxPasses → return FAIL
 */
export async function handleRepairLoop(
  originalTask: OrcaTaskSpec,
  initialRepairTask: string,
  ctx: OrcaRunCtx,
  maestro: MaestroPort,
  pappy: PappyPort,
  emitter: OrcaEmitter,
  maxPasses: number,
): Promise<OrcaExecutionResult> {
  let repairTaskText = initialRepairTask;

  for (let pass = 1; pass <= maxPasses; pass++) {
    emitter.emit({ type: "repair:start", pass, maxPasses });

    // Repair prompt becomes a new task; inherit original constraints
    const repairSpec: OrcaTaskSpec = {
      originalUserMessage: repairTaskText,
      intent: `repair:${originalTask.intent}`,
      goals: ["Resolve all issues identified in the QC evaluation"],
      constraints: originalTask.constraints,
      context: originalTask.context,
    };

    emitter.emit({ type: "maestro:start" });
    const maestroResult = await maestro.run(repairSpec, ctx);
    emitter.emit({ type: "maestro:done", hasOutput: !!maestroResult.outputText });

    const qcResult = pappy.evaluate(buildPappyInput(originalTask, maestroResult));
    emitter.emit({
      type: "qc:result",
      verdict: qcResult.verdict,
      issueCount: qcResult.issues.length,
    });

    if (qcResult.verdict !== "FAIL") {
      return {
        status: "SUCCESS",
        userFacingText: maestroResult.outputText,
        summary: qcResult.internalSummary,
        artifacts: maestroResult,
      };
    }

    if (!qcResult.repairTask) break; // Pappy can't guide further — give up
    repairTaskText = qcResult.repairTask;
  }

  return {
    status: "FAIL",
    summary: `Still failing after ${maxPasses} repair pass(es).`,
  };
}
