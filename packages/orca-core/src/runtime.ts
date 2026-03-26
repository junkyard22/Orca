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
import type { PappyResult } from "@clawde/pappy-core";
import type { RunRecord, ThoughtRecord, ToolEvent, FileChange } from "./persistence/types.js";
import { OrcaEmitter } from "./emitter.js";
import { buildPappyInput, normalizeMaestroResult, normalizeTaskSpec } from "./helpers.js";
import { handleRepairLoop } from "./repairLoop.js";
import { isAbortError, throwIfAborted } from "./abort.js";

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
  const { maestro, pappy, llm, maxRepairPasses = 2, tools, budgetUsd } = deps;
  const qcEnabled = pappy != null;
  const emitter = new OrcaEmitter();

  async function executeTask(
    taskSpec: OrcaTaskSpec,
    options?: { abortSignal?: AbortSignal },
  ): Promise<OrcaExecutionResult> {
    throwIfAborted(options?.abortSignal);
    const normalizedTaskSpec = normalizeTaskSpec(taskSpec);

    // ── Workspace snapshot (captured once, before any async work) ─────────
    const workspaceContext = deps.getWorkspaceContext?.();

    const ctx: OrcaRunCtx = {
      llm,
      runId: generateRunId(),
      abortSignal: options?.abortSignal,
      toolNamesAllowed: normalizedTaskSpec.permissions?.toolsAllowed,
      // Gate tools to only what permissions allow
      tools: tools && (() => {
        const allowed = normalizedTaskSpec.permissions?.toolsAllowed;
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
      requestToolApproval: deps.requestToolApproval,
    };
    const taskId = ctx.runId;
    const startTime = Date.now();

    // Track repair passes via events so we don't thread extra state through
    // the repair loop's return value.
    let repairPasses = 0;
    let bufferedDeweyBrief: { userName: string; suggestedTone: string; relevantPreferences: string[]; relevantContext: string[] } | undefined;
    const bufferedMirandaCheckpoints: Array<{ gate: string; allowed: boolean; reason: string }> = [];

    const unsubDewey = emitter.on("dewey:brief", (e) => {
      if (e.type === "dewey:brief") {
        bufferedDeweyBrief = {
          userName:            e.userName,
          suggestedTone:       e.suggestedTone,
          relevantPreferences: e.relevantPreferences,
          relevantContext:     e.relevantContext,
        };
      }
    });
    const unsubMiranda = emitter.on("miranda:checkpoint", (e) => {
      if (e.type === "miranda:checkpoint") {
        bufferedMirandaCheckpoints.push({ gate: e.gate, allowed: e.allowed, reason: e.reason });
      }
    });
    const unsubRepair = emitter.on("repair:start", () => { repairPasses++; });

    emitter.emit({ type: "task:start", taskId, intent: normalizedTaskSpec.intent });

    // Default: always has a value after try/catch
    let result: OrcaExecutionResult = { status: "FAIL", summary: "Unknown error" };
    let persistedMaestroResult: OrcaMaestroResult | undefined;
    let persistedQcResult: PappyResult | undefined;
    let abortError: Error | undefined;

    try {
      throwIfAborted(options?.abortSignal);
      // ── 1. Maestro runs the task (attempt 0, not a repair) ──────────────
      //    Maestro uses ctx.llm (Miranda-backed) for all model calls.
      emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
      const maestroResult = normalizeMaestroResult(await maestro.run(normalizedTaskSpec, ctx));
      persistedMaestroResult = maestroResult;
      const initialSpendUsd = maestroResult.metadata?.costUsd ?? 0;
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
        throwIfAborted(options?.abortSignal);
        const qcInput = buildPappyInput(normalizedTaskSpec, maestroResult);

        const beforeQcGate = ctx.gate?.beforeQC({ taskId, outputText: maestroResult.outputText ?? "" });
        if (beforeQcGate) {
          emitter.emit({ type: "miranda:checkpoint", taskId, gate: "before_qc", allowed: beforeQcGate.allowed, reason: beforeQcGate.reason });
        }
        const qcResult = pappy!.evaluate(qcInput);
        persistedQcResult = qcResult;
        const afterQcGate = ctx.gate?.afterQC(
          { taskId, outputText: maestroResult.outputText ?? "" },
          qcResult.verdict,
          qcResult.issues.length,
        );
        if (afterQcGate) {
          emitter.emit({ type: "miranda:checkpoint", taskId, gate: "after_qc", allowed: afterQcGate.allowed, reason: afterQcGate.reason });
        }

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
        } else if (budgetUsd && budgetUsd > 0 && initialSpendUsd >= budgetUsd) {
          // ── Budget cap hit on initial pass — skip repair entirely ─────────
          result = {
            status: "WARN",
            userFacingText: maestroResult.outputText,
            summary: `Budget cap $${budgetUsd.toFixed(4)} reached ($${initialSpendUsd.toFixed(4)} spent on initial pass). Repair skipped.`,
          };
        } else {
          throwIfAborted(options?.abortSignal);
          const originalRole = maestroResult.metadata?.role;
          // Reset the streaming bubble in the UI before the repair pass starts
          // so the fresh repair output replaces the initial (failed) attempt.
          emitter.emit({ type: "stream:reset", taskId });
          result = await handleRepairLoop(
            normalizedTaskSpec,
            qcResult,
            ctx,
            maestro,
            pappy!,
            emitter,
            maxRepairPasses,
            maestroResult.outputText,
            originalRole,
            budgetUsd,
            initialSpendUsd,
          );
          if (result.artifacts) {
            persistedMaestroResult = normalizeMaestroResult(result.artifacts as OrcaMaestroResult);
            persistedQcResult = pappy!.evaluate(buildPappyInput(normalizedTaskSpec, persistedMaestroResult));
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        abortError = err instanceof Error ? err : new Error(String(err));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        result = { status: "FAIL", summary: `Runtime error: ${message}` };
      }
    }

    // ── Always runs — emit completion, persist, clean up ──────────────────
    const durationMs = Date.now() - startTime;
    unsubRepair();
    unsubDewey();
    unsubMiranda();
    if (abortError) {
      throw abortError;
    }
    emitter.emit({ type: "task:done", taskId, status: result.status });

    // Emit pipeline summary so the UI can render the badge without
    // needing to aggregate individual events itself.
    if (persistedQcResult) {
      emitter.emit({
        type: "pipeline:summary",
        taskId,
        role: persistedMaestroResult?.metadata?.role ?? "unknown",
        verdict: persistedQcResult.verdict,
        confidence: persistedQcResult.confidence,
        issueCount: persistedQcResult.issues.length,
        issues: persistedQcResult.issues.map((i) => ({
          severity: i.severity,
          code: i.code,
          description: i.description,
        })),
        acceptanceCriteria: persistedQcResult.acceptance_criteria.map((c) => {
          const ledger = persistedQcResult!.receipt_ledger.find((r) => r.ref === c.id);
          return {
            id: c.id,
            text: c.text,
            required: c.required,
            met: ledger?.status === "PROVED",
          };
        }),
        durationMs,
        repairPasses,
        deweyBrief: bufferedDeweyBrief,
        mirandaCheckpoints: bufferedMirandaCheckpoints.length > 0 ? bufferedMirandaCheckpoints : undefined,
      });
    }

    // Persist the run if store is available
    // Persistence failure must never crash the runtime
    try {
      const saveResult = deps.store?.saveRun(
        {
          id: taskId,
          createdAt: new Date(startTime).toISOString(),
          intent: normalizedTaskSpec.intent,
          role: persistedMaestroResult?.metadata?.role,
          brainDecision: persistedMaestroResult?.metadata?.brainDecision,
          status: result.status,
          stoppedBecause: persistedMaestroResult?.metadata?.stoppedBecause,
          iterationCount: persistedMaestroResult?.metadata?.iterationCount,
          outputText: result.userFacingText,
          summary: result.summary,
          verdict: persistedQcResult?.verdict,
          confidence: persistedQcResult?.confidence,
          issueCount: persistedQcResult?.issues.length,
          inputTokens: persistedMaestroResult?.metadata?.inputTokens,
          outputTokens: persistedMaestroResult?.metadata?.outputTokens,
          costUsd: persistedMaestroResult?.metadata?.costUsd,
          repairPasses,
        } as RunRecord,
        (persistedMaestroResult?.metadata?.thoughts ?? []).map((thought) => ({
          runId: taskId,
          iteration: thought.iteration,
          thought: thought.thought,
          observation: thought.observation,
          next: thought.next,
        })),
        (persistedMaestroResult?.toolEvents ?? []).map((event) => ({
          runId: taskId,
          tool: event.tool,
          ok: event.ok,
          summary: event.summary,
        })),
        (persistedMaestroResult?.filesChanged ?? []).map((file) => ({
          runId: taskId,
          path: file.path,
          changeType: file.changeType,
        })),
      );
      // If saveRun returns a Promise, await it to ensure data is persisted
      if (saveResult instanceof Promise) {
        await saveResult;
      }
    } catch (err) {
      console.error("[orca-core] store.saveRun failed:", err);
    }

    return result;
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (e: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
