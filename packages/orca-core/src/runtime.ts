import type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  OrcaEventType,
  OrcaEvent,
  OrcaMaestroResult,
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
  const qcEnabled = pappy != null;
  const emitter = new OrcaEmitter();

  async function executeTask(taskSpec: OrcaTaskSpec): Promise<OrcaExecutionResult> {
    // ── Workspace snapshot (captured once, before any async work) ─────────
    const workspaceContext = deps.getWorkspaceContext?.();

    const ctx: OrcaRunCtx = {
      llm,
      runId: generateRunId(),
      // Gate tools to only what permissions allow
      tools: tools && (() => {
        const allowed = taskSpec.permissions?.toolsAllowed;
        if (!allowed) return tools; // no restrictions
        // Empty allow-list means no tools at all. Return undefined so ctx.tools
        // is falsy and the agent loop is skipped entirely — the LLM never sees
        // tool definitions and won't try to call any.
        if (allowed.length === 0) return undefined;
        return {
          execute(name: string, input: Record<string, unknown>) {
            if (!allowed.includes(name)) {
              return Promise.resolve({
                ok: false,
                output: "",
                error: `Tool "${name}" is not permitted for this request. Allowed: ${allowed.join(", ")}. Output the result in your response instead.`,
              });
            }
            return tools.execute(name, input);
          },
          formatForPrompt() {
            // Only describe tools the model is actually allowed to use.
            // Discover all tool names in the prompt and strip any not in allowed.
            const full = tools.formatForPrompt();
            const allToolNames = [...full.matchAll(/\*\*([\w_]+)\*\*/g)].map(m => m[1] as string);
            let filtered = full;
            for (const t of allToolNames) {
              if (!allowed.includes(t)) {
                // Match "**tool_name** — ..." line + any "  - ..." parameter lines + trailing blank line
                filtered = filtered.replace(
                  new RegExp(`\\*\\*${t}\\*\\*[^\\n]*(?:\\n  -[^\\n]*)*\\n?`, "g"),
                  "",
                );
              }
            }
            return filtered;
          },
        };
      })(),
      emit: (event) => emitter.emit(event),
      workspaceContext,
      gate: deps.gate,
    };
    const taskId = ctx.runId;
    const startTime = Date.now();

    // Track repair passes via events so we don't thread extra state through
    // the repair loop's return value.
    let repairPasses = 0;
    const unsubRepair = emitter.on("repair:start", () => { repairPasses++; });

    emitter.emit({ type: "task:start", taskId, intent: taskSpec.intent });

    // Default: always has a value after try/catch
    let result: OrcaExecutionResult = { status: "FAIL", summary: "Unknown error" };

    try {
      // ── 1. Maestro runs the task (attempt 0, not a repair) ──────────────
      //    Maestro uses ctx.llm (Miranda-backed) for all model calls.
      emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
      const maestroResult = await maestro.run(taskSpec, ctx);
      emitter.emit({ type: "maestro:done", taskId, attempt: 0, isRepair: false, hasOutput: !!maestroResult.outputText });

      if (!qcEnabled) {
        // ── QC disabled (Maestro-only mode) — accept output immediately ────
        result = {
          status: "SUCCESS",
          userFacingText: maestroResult.outputText,
          summary: "ok",
          artifacts: maestroResult,
        };
      } else {
        // ── 2. Pappy evaluates ───────────────────────────────────────────────
        const qcInput = buildPappyInput(taskSpec, maestroResult);

        ctx.gate?.beforeQC({ taskId, outputText: maestroResult.outputText ?? "" });
        const qcResult = pappy!.evaluate(qcInput);
        ctx.gate?.afterQC(
          { taskId, outputText: maestroResult.outputText ?? "" },
          qcResult.verdict,
          qcResult.issues.length,
        );

        emitter.emit({
          type: "qc:result",
          taskId,
          attempt: 0,
          isRepair: false,
          verdict: qcResult.verdict,
          issueCount: qcResult.issues.length,
        });

        if (qcResult.verdict === "FAIL") {
          console.log(
            `[Pappy FAIL] ${qcResult.issues.length} issue(s):`,
            qcResult.issues.map((i) => `${i.severity} ${i.code}: ${i.description}`),
          );
        }

        if (qcResult.verdict !== "FAIL") {
          result = {
            status: "SUCCESS",
            userFacingText: maestroResult.outputText,
            summary: qcResult.internalSummary,
            artifacts: maestroResult,
          };
        } else if (!qcResult.repairTask) {
          result = { status: "FAIL", userFacingText: maestroResult.outputText, summary: qcResult.internalSummary };
        } else {
          result = await handleRepairLoop(
            taskSpec,
            qcResult,
            ctx,
            maestro,
            pappy!,
            emitter,
            maxRepairPasses,
            maestroResult.outputText,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { status: "FAIL", summary: `Runtime error: ${message}` };
    }

    // ── Always runs — emit completion, persist, clean up ──────────────────
    unsubRepair();
    emitter.emit({ type: "task:done", taskId, status: result.status });

    if (deps.store) {
      const artifacts = result.artifacts as OrcaMaestroResult | undefined;
      deps.store.saveRun({
        runId:           taskId,
        timestamp:       startTime,
        durationMs:      Date.now() - startTime,
        status:          result.status,
        originalMessage: taskSpec.originalUserMessage,
        intent:          taskSpec.intent,
        goals:           JSON.stringify(taskSpec.goals),
        outputText:      result.userFacingText,
        summary:         result.summary,
        subagentCount:   artifacts?.subagentRuns?.length    ?? 0,
        toolEventCount:  artifacts?.toolEvents?.length      ?? 0,
        repairPasses,
        workspaceCwd:    workspaceContext?.cwd,
        gitBranch:       workspaceContext?.gitBranch,
        gitCommit:       workspaceContext?.gitCommit,
      });
    }

    return result;
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (e: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
