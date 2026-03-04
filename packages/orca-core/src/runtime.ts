import type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  OrcaEventType,
  OrcaEvent,
} from "./types.js";
import { OrcaEmitter } from "./emitter.js";
import { buildPappyInput } from "./helpers.js";
import { handleRepairLoop } from "./repairLoop.js";

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * createOrcaRuntime — the single wiring point for the entire pod.
 *
 * Dependency flow (correct):
 *
 *   Benson ──(executeTask)──► orca-core
 *                                 │
 *                          maestro.run(task, ctx)   ← ctx carries ctx.llm (Miranda-backed)
 *                                 │
 *                          pappy.evaluate(result)
 *                                 │
 *                      PASS/WARN ─┤─ FAIL ─► repairLoop → maestro.run → pappy.evaluate
 *                                 │
 *                          OrcaExecutionResult ──► Benson formats for user
 *
 * orca-core has NO dependency on benson-core.
 * Benson is injected the other way: createBenson({ executeTask: runtime.executeTask }).
 *
 * Event lineage:
 *   Every event carries taskId (= ctx.runId), attempt, and isRepair so
 *   Doctor / logging can answer: "which tasks needed repairs?", "how many
 *   passes per task?", "which specific issues were resolved?"
 */
export function createOrcaRuntime(deps: OrcaRuntimeDeps): OrcaRuntime {
  const { maestro, pappy, llm, maxRepairPasses = 2, tools } = deps;
  const emitter = new OrcaEmitter();

  async function executeTask(taskSpec: OrcaTaskSpec): Promise<OrcaExecutionResult> {
    const ctx: OrcaRunCtx = {
      llm,
      runId: generateRunId(),
      tools,
      emit: (event) => emitter.emit(event),
    };
    const taskId = ctx.runId; // stable across all passes for this task

    emitter.emit({ type: "task:start", taskId, intent: taskSpec.intent });

    try {
      // ── 1. Maestro runs the task (attempt 0, not a repair) ────────────────
      //    Maestro uses ctx.llm (Miranda-backed) for all model calls.
      emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
      const maestroResult = await maestro.run(taskSpec, ctx);
      emitter.emit({ type: "maestro:done", taskId, attempt: 0, isRepair: false, hasOutput: !!maestroResult.outputText });

      // ── 2. Pappy evaluates ────────────────────────────────────────────────
      const qcResult = pappy.evaluate(buildPappyInput(taskSpec, maestroResult));
      emitter.emit({
        type: "qc:result",
        taskId,
        attempt: 0,
        isRepair: false,
        verdict: qcResult.verdict,
        issueCount: qcResult.issues.length,
      });

      // ── 3. PASS or WARN → done ────────────────────────────────────────────
      if (qcResult.verdict !== "FAIL") {
        emitter.emit({ type: "task:done", taskId, status: "SUCCESS" });
        return {
          status: "SUCCESS",
          userFacingText: maestroResult.outputText,
          summary: qcResult.internalSummary,
          artifacts: maestroResult,
        };
      }

      // ── 4. FAIL → repair loop ─────────────────────────────────────────────
      if (!qcResult.repairTask) {
        emitter.emit({ type: "task:done", taskId, status: "FAIL" });
        return { status: "FAIL", summary: qcResult.internalSummary };
      }

      const repaired = await handleRepairLoop(
        taskSpec,
        qcResult,        // full PappyResult — issues + repairTask go into repair context
        ctx,
        maestro,
        pappy,
        emitter,
        maxRepairPasses,
      );
      emitter.emit({ type: "task:done", taskId, status: repaired.status });
      return repaired;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitter.emit({ type: "task:done", taskId, status: "FAIL" });
      return { status: "FAIL", summary: `Runtime error: ${message}` };
    }
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (e: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
