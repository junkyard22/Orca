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
 */
export function createOrcaRuntime(deps: OrcaRuntimeDeps): OrcaRuntime {
  const { maestro, pappy, llm, maxRepairPasses = 2 } = deps;
  const emitter = new OrcaEmitter();

  async function executeTask(taskSpec: OrcaTaskSpec): Promise<OrcaExecutionResult> {
    emitter.emit({ type: "task:start", intent: taskSpec.intent });

    const ctx: OrcaRunCtx = { llm, runId: generateRunId() };

    try {
      // ── 1. Maestro runs the task ──────────────────────────────────────────
      //    Maestro uses ctx.llm (Miranda-backed) for all model calls.
      //    It can also use ctx for tools/storage when Workbench is wired.
      emitter.emit({ type: "maestro:start" });
      const maestroResult = await maestro.run(taskSpec, ctx);
      emitter.emit({ type: "maestro:done", hasOutput: !!maestroResult.outputText });

      // ── 2. Pappy evaluates ────────────────────────────────────────────────
      const qcResult = pappy.evaluate(buildPappyInput(taskSpec, maestroResult));
      emitter.emit({
        type: "qc:result",
        verdict: qcResult.verdict,
        issueCount: qcResult.issues.length,
      });

      // ── 3. PASS or WARN → done ────────────────────────────────────────────
      if (qcResult.verdict !== "FAIL") {
        emitter.emit({ type: "task:done", status: "SUCCESS" });
        return {
          status: "SUCCESS",
          userFacingText: maestroResult.outputText,
          summary: qcResult.internalSummary,
          artifacts: maestroResult,
        };
      }

      // ── 4. FAIL → repair loop ─────────────────────────────────────────────
      if (!qcResult.repairTask) {
        emitter.emit({ type: "task:done", status: "FAIL" });
        return { status: "FAIL", summary: qcResult.internalSummary };
      }

      const repaired = await handleRepairLoop(
        taskSpec,
        qcResult.repairTask,
        ctx,
        maestro,
        pappy,
        emitter,
        maxRepairPasses,
      );
      emitter.emit({ type: "task:done", status: repaired.status });
      return repaired;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitter.emit({ type: "task:done", status: "FAIL" });
      return { status: "FAIL", summary: `Runtime error: ${message}` };
    }
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (e: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
