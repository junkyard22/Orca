import type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  OrcaEventType,
  OrcaEvent,
  OrcaMaestroResult,
  OrcaPipelineTrace,
  OrcaPipelineTraceEntry,
} from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";
import type { RunRecord } from "./persistence/types.js";
import { OrcaEmitter } from "./emitter.js";
import { buildPappyInput, normalizeMaestroResult, normalizeTaskSpec } from "./helpers.js";
import { handleRepairLoop } from "./repairLoop.js";
import { isAbortError, throwIfAborted } from "./abort.js";

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeTraceValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 40_000
      ? `${value.slice(0, 40_000)}\n[trace truncated after 40000 chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (depth >= 6) return "[MaxDepth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map((item) => sanitizeTraceValue(item, depth + 1, seen));
    if (value.length > 200) {
      items.push(`[Truncated ${value.length - 200} more item(s)]`);
    }
    return items;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const entries = Object.entries(value as Record<string, unknown>);
  const limitedEntries = entries.slice(0, 100);
  const sanitized = Object.fromEntries(
    limitedEntries.map(([key, entryValue]) => [
      key,
      sanitizeTraceValue(entryValue, depth + 1, seen),
    ]),
  );
  if (entries.length > 100) {
    sanitized.__truncatedKeys = entries.length - 100;
  }
  return sanitized;
}

/**
 * createOrcaRuntime - the single wiring point for the entire pod.
 *
 * Dependency flow (correct):
 *
 *   Benson --(executeTask)--> orca-core
 *                                |
 *                         maestro.run(task, ctx)   <- ctx carries ctx.llm
 *                                |
 *                         pappy.evaluate(result)
 *                                |
 *                     PASS/WARN --+-- FAIL --> repairLoop -> maestro.run -> pappy.evaluate
 *                                |
 *                         OrcaExecutionResult --> Benson formats for user
 *
 * orca-core has NO dependency on benson-core.
 * Benson is injected the other way: createBenson({ executeTask: runtime.executeTask }).
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
    const workspaceContext = deps.getWorkspaceContext?.();
    const taskId = generateRunId();
    const startTime = Date.now();
    const traceEntries: OrcaPipelineTraceEntry[] = [];

    const recordTrace = (stage: string, detail?: unknown): void => {
      traceEntries.push({
        at: new Date().toISOString(),
        stage,
        detail: detail === undefined ? undefined : sanitizeTraceValue(detail),
      });
    };

    const ctx: OrcaRunCtx = {
      llm,
      runId: taskId,
      abortSignal: options?.abortSignal,
      recordTrace,
      toolNamesAllowed: normalizedTaskSpec.permissions?.toolsAllowed,
      tools: tools && (() => {
        const allowed = normalizedTaskSpec.permissions?.toolsAllowed;
        if (!allowed) return tools;
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
            const full = tools.formatForPrompt();
            const allToolNames = [...full.matchAll(/\*\*([\w_]+)\*\*/g)].map((match) => match[1] as string);
            let filtered = full;
            for (const toolName of allToolNames) {
              if (!allowed.includes(toolName)) {
                filtered = filtered.replace(
                  new RegExp(`\\*\\*${toolName}\\*\\*[^\\n]*(?:\\n  -[^\\n]*)*\\n?`, "g"),
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

    recordTrace("task.received", { taskSpec: normalizedTaskSpec });
    recordTrace("workspace.context", workspaceContext);
    recordTrace("task.permissions", {
      toolsAllowed: normalizedTaskSpec.permissions?.toolsAllowed ?? null,
      fileRead: normalizedTaskSpec.permissions?.fileRead ?? true,
      fileWrite: normalizedTaskSpec.permissions?.fileWrite ?? true,
      shellExec: normalizedTaskSpec.permissions?.shellExec ?? false,
      toolsEnabled: !!ctx.tools,
    });

    let repairPasses = 0;
    let bufferedDeweyBrief:
      | { userName: string; suggestedTone: string; relevantPreferences: string[]; relevantContext: string[] }
      | undefined;
    const bufferedMirandaCheckpoints: Array<{ gate: string; allowed: boolean; reason: string }> = [];

    const unsubDewey = emitter.on("dewey:brief", (event) => {
      if (event.type !== "dewey:brief") return;
      bufferedDeweyBrief = {
        userName: event.userName,
        suggestedTone: event.suggestedTone,
        relevantPreferences: event.relevantPreferences,
        relevantContext: event.relevantContext,
      };
      recordTrace("dewey.brief", bufferedDeweyBrief);
    });
    const unsubMiranda = emitter.on("miranda:checkpoint", (event) => {
      if (event.type !== "miranda:checkpoint") return;
      const checkpoint = { gate: event.gate, allowed: event.allowed, reason: event.reason };
      bufferedMirandaCheckpoints.push(checkpoint);
      recordTrace(`miranda.${event.gate}`, checkpoint);
    });
    const unsubRepair = emitter.on("repair:start", (event) => {
      repairPasses++;
      if (event.type === "repair:start") {
        recordTrace("repair.start", { pass: event.pass, maxPasses: event.maxPasses });
      }
    });

    emitter.emit({ type: "task:start", taskId, intent: normalizedTaskSpec.intent });

    let result: OrcaExecutionResult = { status: "FAIL", summary: "Unknown error" };
    let persistedMaestroResult: OrcaMaestroResult | undefined;
    let persistedQcResult: PappyResult | undefined;
    let abortError: Error | undefined;
    let gateBlockReason: string | undefined;

    try {
      throwIfAborted(options?.abortSignal);
      emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
      recordTrace("maestro.run.start", { attempt: 0, isRepair: false, task: normalizedTaskSpec });

      const maestroResult = normalizeMaestroResult(await maestro.run(normalizedTaskSpec, ctx));
      persistedMaestroResult = maestroResult;
      const initialSpendUsd = maestroResult.metadata?.costUsd ?? 0;

      emitter.emit({
        type: "maestro:done",
        taskId,
        attempt: 0,
        isRepair: false,
        hasOutput: !!maestroResult.outputText,
      });
      recordTrace("maestro.run.result", {
        attempt: 0,
        isRepair: false,
        result: maestroResult,
      });

      if (!qcEnabled) {
        recordTrace("qc.skipped", { reason: "pappy_not_configured" });
        result = {
          status: "SUCCESS",
          userFacingText: maestroResult.outputText,
          summary: "ok",
          artifacts: maestroResult,
        };
      } else {
        throwIfAborted(options?.abortSignal);
        const qcInput = buildPappyInput(normalizedTaskSpec, maestroResult);
        recordTrace("qc.run.start", { attempt: 0, isRepair: false, input: qcInput });

        const beforeQcGate = ctx.gate?.beforeQC({ taskId, outputText: maestroResult.outputText ?? "" });
        if (beforeQcGate) {
          emitter.emit({
            type: "miranda:checkpoint",
            taskId,
            gate: "before_qc",
            allowed: beforeQcGate.allowed,
            reason: beforeQcGate.reason,
          });
          if (!beforeQcGate.allowed) {
            gateBlockReason = beforeQcGate.reason;
          }
        }

        const qcResult = pappy.evaluate(qcInput);
        persistedQcResult = qcResult;

        const afterQcGate = ctx.gate?.afterQC(
          { taskId, outputText: maestroResult.outputText ?? "" },
          qcResult.verdict,
          qcResult.issues.length,
        );
        if (afterQcGate) {
          emitter.emit({
            type: "miranda:checkpoint",
            taskId,
            gate: "after_qc",
            allowed: afterQcGate.allowed,
            reason: afterQcGate.reason,
          });
        }

        emitter.emit({
          type: "qc:result",
          taskId,
          attempt: 0,
          isRepair: false,
          verdict: qcResult.verdict,
          issueCount: qcResult.issues.length,
        });
        recordTrace("qc.run.result", {
          attempt: 0,
          isRepair: false,
          verdict: qcResult.verdict,
          confidence: qcResult.confidence,
          issues: qcResult.issues,
          repairTask: qcResult.repairTask,
          internalSummary: qcResult.internalSummary,
        });

        if (qcResult.verdict === "FAIL") {
          console.error(
            `[Pappy FAIL] ${qcResult.issues.length} issue(s):`,
            qcResult.issues.map((issue) => `${issue.severity} ${issue.code}: ${issue.description}`),
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
          recordTrace("repair.unavailable", { reason: "pappy_returned_no_repair_task" });
          result = {
            status: "FAIL",
            userFacingText: maestroResult.outputText,
            summary: qcResult.internalSummary,
          };
        } else if (budgetUsd && budgetUsd > 0 && initialSpendUsd >= budgetUsd) {
          recordTrace("repair.skipped.budget", {
            budgetUsd,
            spentUsd: initialSpendUsd,
          });
          result = {
            status: "WARN",
            userFacingText: maestroResult.outputText,
            summary: `Budget cap $${budgetUsd.toFixed(4)} reached ($${initialSpendUsd.toFixed(4)} spent on initial pass). Repair skipped.`,
          };
        } else {
          throwIfAborted(options?.abortSignal);
          const originalRole = maestroResult.metadata?.role;
          emitter.emit({ type: "stream:reset", taskId });
          result = await handleRepairLoop(
            normalizedTaskSpec,
            qcResult,
            ctx,
            maestro,
            pappy,
            emitter,
            maxRepairPasses,
            maestroResult.outputText,
            originalRole,
            budgetUsd,
            initialSpendUsd,
            maestroResult.metadata?.errorMessage,
            gateBlockReason,
          );
          if (result.artifacts) {
            persistedMaestroResult = normalizeMaestroResult(result.artifacts as OrcaMaestroResult);
            persistedQcResult = pappy.evaluate(buildPappyInput(normalizedTaskSpec, persistedMaestroResult));
            recordTrace("repair.final_result", {
              result: persistedMaestroResult,
              qcVerdict: persistedQcResult.verdict,
              qcIssues: persistedQcResult.issues,
            });
          }
        }
      }
      recordTrace("task.completed", {
        status: result.status,
        summary: result.summary,
      });
    } catch (error) {
      if (isAbortError(error)) {
        abortError = error instanceof Error ? error : new Error(String(error));
        recordTrace("task.aborted", {
          name: abortError.name,
          message: abortError.message,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        result = { status: "FAIL", summary: `Runtime error: ${message}` };
        recordTrace("task.error", {
          name: error instanceof Error ? error.name : "Error",
          message,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    unsubRepair();
    unsubDewey();
    unsubMiranda();

    const trace: OrcaPipelineTrace = {
      version: 1,
      taskId,
      createdAt: new Date(startTime).toISOString(),
      task: sanitizeTraceValue(normalizedTaskSpec) as OrcaTaskSpec,
      entries: traceEntries,
      finalResult: {
        status: abortError ? "ABORTED" : result.status,
        summary: abortError ? abortError.message : result.summary,
        userFacingText: abortError ? undefined : result.userFacingText,
        role: persistedMaestroResult?.metadata?.role,
        qcVerdict: persistedQcResult?.verdict,
        issueCount: persistedQcResult?.issues.length,
        repairPasses,
        durationMs,
      },
    };

    try {
      const writeTraceResult = deps.writeTrace?.(trace);
      if (writeTraceResult instanceof Promise) {
        await writeTraceResult;
      }
    } catch (error) {
      console.error("[orca-core] writeTrace failed:", error);
    }

    if (abortError) {
      throw abortError;
    }

    emitter.emit({ type: "task:done", taskId, status: result.status });

    if (persistedQcResult) {
      emitter.emit({
        type: "pipeline:summary",
        taskId,
        role: persistedMaestroResult?.metadata?.role ?? "unknown",
        verdict: persistedQcResult.verdict,
        confidence: persistedQcResult.confidence,
        issueCount: persistedQcResult.issues.length,
        issues: persistedQcResult.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          description: issue.description,
        })),
        acceptanceCriteria: persistedQcResult.acceptance_criteria.map((criterion) => {
          const ledger = persistedQcResult.receipt_ledger.find((receipt) => receipt.ref === criterion.id);
          return {
            id: criterion.id,
            text: criterion.text,
            required: criterion.required,
            met: ledger?.status === "PROVED",
          };
        }),
        durationMs,
        repairPasses,
        errorMessage: persistedMaestroResult?.metadata?.errorMessage ?? gateBlockReason,
        deweyBrief: bufferedDeweyBrief,
        mirandaCheckpoints: bufferedMirandaCheckpoints.length > 0 ? bufferedMirandaCheckpoints : undefined,
      });
    }

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
          errorMessage: persistedMaestroResult?.metadata?.errorMessage ?? gateBlockReason,
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
      if (saveResult instanceof Promise) {
        await saveResult;
      }
    } catch (error) {
      console.error("[orca-core] store.saveRun failed:", error);
    }

    return result;
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (event: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
