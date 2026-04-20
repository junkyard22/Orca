import type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  OrcaEventType,
  OrcaEvent,
  OrcaMaestroResult,
  OrcaToolEvent,
  OrcaPipelineTrace,
  OrcaPipelineTraceEntry,
} from "./types.js";
import type { AHPPacket } from "./ahp/types.js";
import type { PappyResult } from "@clawde/pappy-core";
import { verifyAHPPacket } from "@clawde/pappy-core";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "./persistence/types.js";
import { OrcaEmitter } from "./emitter.js";
import { buildPappyInput, normalizeMaestroResult, normalizeTaskSpec } from "./helpers.js";
import { formatProjectAuditResult, isProjectAuditTask, runProjectAudit } from "./audit/index.js";
import type { ProjectAuditResult } from "./audit/index.js";
import { handleRepairLoop } from "./repairLoop.js";
import { isAbortError, throwIfAborted } from "./abort.js";
import {
  createRootPacket,
  registerChildOnRoot,
  deriveRootLifecycleFromChildren,
  appendAHPTrace,
  isTerminalAHPLifecycle,
} from "./ahp/types.js";
import { AHPLifecycle } from "./ahp/types.js";
import { serializeAHPPacketGraph, formatAHPPacketGraphSummary, formatAHPPacketGraphIssuesSummary } from "./ahp/graph.js";
import type { AHPPacketGraph } from "./ahp/graph.js";

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveWorkspaceRootCandidate(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"',.;:]+$/, "");
  if (!cleaned) return undefined;

  const attempts = [cleaned];
  const parts = cleaned.split(/\s+/);
  for (let end = parts.length - 1; end > 0; end--) {
    attempts.push(parts.slice(0, end).join(" "));
  }

  for (const candidate of [...new Set(attempts)]) {
    if (!existsSync(candidate)) continue;
    const stat = statSync(candidate);
    if (stat.isDirectory()) return candidate;
    if (stat.isFile()) return dirname(candidate);
  }

  return undefined;
}

function extractExplicitWorkspaceRoot(taskSpec: OrcaTaskSpec): string | undefined {
  const contextRoot = taskSpec.context?.["workspaceRoot"];
  if (typeof contextRoot === "string") {
    const resolved = resolveWorkspaceRootCandidate(contextRoot);
    if (resolved) return resolved;
  }

  const text = [
    taskSpec.originalUserMessage,
    taskSpec.intent,
    ...(taskSpec.goals ?? []),
  ].join("\n");

  for (const line of text.split(/\r?\n/)) {
    const windowsMatch = line.match(/\b[A-Za-z]:[\\/][^\r\n]+/);
    if (windowsMatch) {
      const resolved = resolveWorkspaceRootCandidate(windowsMatch[0]);
      if (resolved) return resolved;
    }

    const posixMatch = line.match(/(?:^|\s)(\/[^\r\n]+)/);
    if (posixMatch?.[1]) {
      const resolved = resolveWorkspaceRootCandidate(posixMatch[1]);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

function projectAuditVerdict(result: ProjectAuditResult): "PASS" | "WARN" | "FAIL" {
  switch (result.readiness.readiness) {
    case "ready":
      return "PASS";
    case "mostly_ready":
      return "WARN";
    default:
      return "FAIL";
  }
}

function projectAuditIssues(result: ProjectAuditResult): Array<{ severity: string; code: string; description: string }> {
  return [
    ...result.readiness.riskFlags.map((flag) => ({
      severity: "MEDIUM",
      code: String(flag).toUpperCase(),
      description: String(flag).replace(/_/g, " "),
    })),
    ...result.readiness.missingEvidence.map((missing) => ({
      severity: "LOW",
      code: "MISSING_EVIDENCE",
      description: missing,
    })),
  ];
}

function buildAuditToolEvents(auditResult: ProjectAuditResult): OrcaToolEvent[] {
  return [
    {
      tool: "audit_preflight",
      ok: true,
      summary: `audit_preflight: exists=${auditResult.preflight.exists}; kind=${auditResult.preflight.kind}; readable=${auditResult.preflight.readable}; markers=${auditResult.preflight.markers.length}`,
      raw: {
        path: auditResult.preflight.targetPath,
        exists: auditResult.preflight.exists,
        readable: auditResult.preflight.readable,
        kind: auditResult.preflight.kind,
        isRepo: auditResult.preflight.isRepo,
        markers: auditResult.preflight.markers.map((marker) => marker.path),
        failures: auditResult.preflight.failures,
      },
    },
    {
      tool: "audit_classification",
      ok: true,
      summary: `audit_classification: primary=${auditResult.classification.primary}; confidence=${auditResult.classification.confidence}`,
      raw: auditResult.classification,
    },
    ...auditResult.probes.map((probe): OrcaToolEvent => ({
      tool: `audit_probe_${probe.name}`,
      ok: true,
      summary: `audit_probe: ${probe.name}; status=${probe.status}; evidence=${probe.evidence.length}; missing=${probe.missing.length}`,
      raw: probe,
    })),
    {
      tool: "audit_command_policy",
      ok: true,
      summary: `audit_command_policy: shellAllowed=${auditResult.commandPolicy.shellAllowed}; recipes=${auditResult.commandPolicy.approvedRecipes.length}; decisions=${auditResult.commandPolicy.decisions.length}`,
      raw: auditResult.commandPolicy,
    },
    {
      tool: "audit_readiness",
      ok: true,
      summary: `audit_readiness: readiness=${auditResult.readiness.readiness}; confidence=${auditResult.readiness.confidence}; score=${auditResult.readiness.totalScore}`,
      raw: auditResult.readiness,
    },
  ];
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
    const explicitWorkspaceRoot = extractExplicitWorkspaceRoot(normalizedTaskSpec);
    const effectiveWorkspaceRoot = explicitWorkspaceRoot ?? deps.workspaceRoot ?? workspaceContext?.cwd;
    const effectiveWorkspaceContext = effectiveWorkspaceRoot
      ? { ...(workspaceContext ?? {}), cwd: effectiveWorkspaceRoot }
      : workspaceContext;
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
      workspaceContext: effectiveWorkspaceContext,
      workspaceRoot: effectiveWorkspaceRoot,
      gate: deps.gate,
      requestToolApproval: deps.requestToolApproval,
    };

    recordTrace("task.received", { taskSpec: normalizedTaskSpec });
    recordTrace("workspace.context", effectiveWorkspaceContext);
    recordTrace("workspace.root", {
      configured: deps.workspaceRoot ?? null,
      context: workspaceContext?.cwd ?? null,
      explicit: explicitWorkspaceRoot ?? null,
      effective: effectiveWorkspaceRoot ?? null,
    });
    recordTrace("task.permissions", {
      toolsAllowed: normalizedTaskSpec.permissions?.toolsAllowed ?? null,
      fileRead: normalizedTaskSpec.permissions?.fileRead ?? true,
      fileWrite: normalizedTaskSpec.permissions?.fileWrite ?? true,
      shellExec: normalizedTaskSpec.permissions?.shellExec ?? false,
      toolsEnabled: !!ctx.tools,
    });

    // ── Root AHP packet ────────────────────────────────────────────────────────────
    // Created once per run.  Miranda transitions it PENDING→RUNNING.
    // Workers operate on child packets; the root lifecycle is finalized
    // from children (or directly, for single-run Option-A paths).
    const ahpRootPacket = createRootPacket({
      id: `${taskId}_root`,
      objective: normalizedTaskSpec.intent,
      expectedOutput: {
        schema:             {},
        acceptanceCriteria: normalizedTaskSpec.goals ?? [],
      },
    });
    // Pass root packet through ctx so adapters/workers can reference it.
    ctx.ahpRootPacket = ahpRootPacket;

    // Miranda: PENDING → RUNNING (orchestration starts)
    const now0 = new Date().toISOString();
    ahpRootPacket.lifecycle       = AHPLifecycle.RUNNING;
    ahpRootPacket.meta.startedAt  = now0;
    ahpRootPacket.meta.updatedAt  = now0;
    appendAHPTrace(ahpRootPacket, {
      timestamp: now0,
      state: AHPLifecycle.RUNNING,
      actor: "orca-runtime",
      note: `Run ${taskId} started`,
    });
    recordTrace("ahp.root_packet.created", {
      packet_id: ahpRootPacket.id,
      objective: ahpRootPacket.objective,
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
    let persistedAuditResult: ProjectAuditResult | undefined;
    let abortError: Error | undefined;
    let gateBlockReason: string | undefined;
    let unknownTools: string[] = [];

    try {
      throwIfAborted(options?.abortSignal);
      if (isProjectAuditTask(normalizedTaskSpec)) {
        emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
        recordTrace("audit.mode.activated", {
          mode: "project_audit",
          reason: normalizedTaskSpec.mode === "project_audit" ? "task_mode" : "audit_request_detected",
        });
        const auditResult = runProjectAudit({
          taskSpec: normalizedTaskSpec,
          workspaceRoot: effectiveWorkspaceRoot,
        });
        persistedAuditResult = auditResult;
        recordTrace("audit.preflight", auditResult.preflight);
        recordTrace("audit.classification", auditResult.classification);
        recordTrace("audit.probes", auditResult.probes.map((probe) => ({
          name: probe.name,
          status: probe.status,
          evidenceCount: probe.evidence.length,
          missingCount: probe.missing.length,
        })));
        recordTrace("audit.command_policy", auditResult.commandPolicy);
        recordTrace("audit.readiness", auditResult.readiness);

        const outputText = formatProjectAuditResult(auditResult);
        const auditMaestroResult = normalizeMaestroResult({
          outputText,
          summary: `project_audit ${auditResult.readiness.readiness}`,
          toolEvents: buildAuditToolEvents(auditResult),
          filesChanged: [],
          metadata: {
            role: "project_audit",
            stoppedBecause: "done",
            auditResult,
          },
          doneCriteria: [
            "Output distinguishes observed file/config evidence from runtime verification",
            "Output states readiness, confidence, supporting evidence, missing evidence, and risk flags",
          ],
        });
        persistedMaestroResult = auditMaestroResult;
        emitter.emit({
          type: "maestro:done",
          taskId,
          attempt: 0,
          isRepair: false,
          hasOutput: !!auditMaestroResult.outputText,
        });

        if (qcEnabled) {
          const qcInput = buildPappyInput(normalizedTaskSpec, auditMaestroResult);
          recordTrace("qc.run.start", { attempt: 0, isRepair: false, input: qcInput });
          const qcResult = pappy.evaluate(qcInput);
          persistedQcResult = qcResult;
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
          result = {
            status: qcResult.verdict === "FAIL" ? "FAIL" : "SUCCESS",
            userFacingText: outputText,
            summary: qcResult.internalSummary,
            artifacts: { auditResult },
          };
        } else {
          recordTrace("qc.skipped", { reason: "pappy_not_configured" });
          result = {
            status: "SUCCESS",
            userFacingText: outputText,
            summary: auditMaestroResult.summary,
            artifacts: { auditResult },
          };
        }
      } else {
      emitter.emit({ type: "maestro:start", taskId, attempt: 0, isRepair: false });
      recordTrace("maestro.run.start", { attempt: 0, isRepair: false, task: normalizedTaskSpec });

      const maestroResult = normalizeMaestroResult(await maestro.run(normalizedTaskSpec, ctx));
      persistedMaestroResult = maestroResult;
      const initialSpendUsd = maestroResult.metadata?.costUsd ?? 0;

      // Detect tools the agent tried to call but weren't available.
      unknownTools = [
        ...new Set(
          (maestroResult.toolEvents ?? [])
            .filter((e) => !e.ok && typeof e.summary === "string" && e.summary.startsWith("Unknown tool:"))
            .map((e) => e.tool),
        ),
      ];

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
        recordTrace("qc.skipped", {
          reason: "pappy_not_configured",
        });
        result = {
          status: "SUCCESS",
          userFacingText: maestroResult.outputText,
          summary: "ok",
          artifacts: maestroResult,
        };
      } else {
        throwIfAborted(options?.abortSignal);
        const verifiedAHPIdsForQc = new Set<string>();
        const verifyPacketForQc = (packet: AHPPacket, traceStage: string): void => {
          if (verifiedAHPIdsForQc.has(packet.id)) return;
          verifiedAHPIdsForQc.add(packet.id);
          verifyAHPPacket(packet, {
            outputText: maestroResult.outputText,
            filesChanged: maestroResult.filesChanged,
            workspaceRoot: effectiveWorkspaceRoot,
          });
          recordTrace(traceStage, {
            packet_id: packet.id,
            lifecycle: packet.lifecycle,
            verdict: packet.verdict,
          });
        };
        if (maestroResult.ahpPacket) {
          verifyPacketForQc(maestroResult.ahpPacket, "ahp.verify");
        }
        for (const childPacket of maestroResult.ahpChildPackets ?? []) {
          verifyPacketForQc(childPacket, "ahp.verify.child");
        }

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
        } else if (!qcResult.repairTask && !maestroResult.ahpPacket?.repairPrompt) {
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
            maestroResult.ahpPacket,
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

    // ── Finalize root AHP packet ───────────────────────────────────────────
    // Collect child packets from the maestro result (if any).
    const ahpChildPackets: AHPPacket[] = [];

    if (persistedMaestroResult?.ahpPacket) {
      const childPacket = persistedMaestroResult.ahpPacket;
      // Hydrate hierarchy fields if the Maestro adapter pre-dates hierarchy support.
      if (!childPacket.parentPacketId) {
        (childPacket as { parentPacketId?: string }).parentPacketId = ahpRootPacket.id;
      }
      registerChildOnRoot(ahpRootPacket, childPacket);
      ahpChildPackets.push(childPacket);
    }

    // Also collect any explicit child packets Maestro returned.
    if (persistedMaestroResult?.ahpChildPackets) {
      for (const cp of persistedMaestroResult.ahpChildPackets) {
        if (!ahpChildPackets.includes(cp)) {
          if (!cp.parentPacketId) {
            (cp as { parentPacketId?: string }).parentPacketId = ahpRootPacket.id;
          }
          registerChildOnRoot(ahpRootPacket, cp);
          ahpChildPackets.push(cp);
        }
      }
    }

    // Derive final root lifecycle.
    // Option A (single-run, no decompose): root packet finalized directly from
    // execution result because there are no child packets from Maestro.
    // If child packets exist, use aggregate rules.
    const nowFinal = new Date().toISOString();
    if (!isTerminalAHPLifecycle(ahpRootPacket.lifecycle)) {
      let finalLifecycle: AHPLifecycle;
      if (ahpChildPackets.length > 0) {
        // Aggregate children — derive from their terminal states.
        finalLifecycle = deriveRootLifecycleFromChildren(ahpChildPackets);
      } else {
        // Option A: no children — finalize directly from execution result.
        if (abortError) {
          finalLifecycle = AHPLifecycle.INCONCLUSIVE;
        } else if (result.status === "SUCCESS") {
          finalLifecycle = AHPLifecycle.COMPLETE;
        } else if (result.status === "WARN") {
          // WARN means work completed but quality was imperfect — still COMPLETE.
          finalLifecycle = AHPLifecycle.COMPLETE;
        } else {
          // FAIL status → FAILED lifecycle
          finalLifecycle = AHPLifecycle.FAILED;
        }
      }
      ahpRootPacket.lifecycle       = finalLifecycle;
      ahpRootPacket.meta.completedAt = nowFinal;
      ahpRootPacket.meta.updatedAt   = nowFinal;
      appendAHPTrace(ahpRootPacket, {
        timestamp: nowFinal,
        state:     finalLifecycle,
        actor:     "orca-runtime",
        note: ahpChildPackets.length > 0
          ? `Aggregated from ${ahpChildPackets.length} child packet(s)`
          : `Single-run finalization; result=${result.status}${abortError ? " (aborted)" : ""}`,
      });
      recordTrace("ahp.root_packet.finalized", {
        packet_id:  ahpRootPacket.id,
        lifecycle:  finalLifecycle,
        childCount: ahpChildPackets.length,
      });
    }

    // Attach root/child packets to the execution result.
    result.ahpRootPacket   = ahpRootPacket;
    result.ahpChildPackets = ahpChildPackets.length > 0 ? ahpChildPackets : undefined;

    // Build serializable graph snapshot for persistence and inspection.
    let ahpGraph: AHPPacketGraph | undefined;
    if (ahpRootPacket) {
      ahpGraph = serializeAHPPacketGraph(ahpRootPacket, ahpChildPackets);
    }

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
        ahpPacketGraph: ahpGraph,
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
      const auditIssues = persistedAuditResult ? projectAuditIssues(persistedAuditResult) : undefined;
      emitter.emit({
        type: "pipeline:summary",
        taskId,
        role: persistedMaestroResult?.metadata?.role ?? "unknown",
        verdict: persistedAuditResult ? projectAuditVerdict(persistedAuditResult) : persistedQcResult.verdict,
        confidence: persistedAuditResult ? persistedAuditResult.readiness.confidence : persistedQcResult.confidence,
        issueCount: auditIssues ? auditIssues.length : persistedQcResult.issues.length,
        issues: (auditIssues ?? persistedQcResult.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          description: issue.description,
        }))),
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
        traceStages: trace.entries.map((entry) => entry.stage),
        deweyBrief: bufferedDeweyBrief,
        mirandaCheckpoints: bufferedMirandaCheckpoints.length > 0 ? bufferedMirandaCheckpoints : undefined,
        auditDetail: persistedAuditResult ? {
          classification: {
            primary: persistedAuditResult.classification.primary,
            categories: persistedAuditResult.classification.categories,
            confidence: persistedAuditResult.classification.confidence,
          },
          probes: persistedAuditResult.probes.map((p) => ({
            name: p.name,
            status: p.status,
            evidenceCount: p.evidence.length,
            missingCount: p.missing.length,
          })),
          supportingEvidence: persistedAuditResult.readiness.supportingEvidence,
          missingEvidence: persistedAuditResult.readiness.missingEvidence,
          riskFlags: persistedAuditResult.readiness.riskFlags,
          commandDecisions: persistedAuditResult.commandPolicy.decisions.map((d) => ({
            command: d.command,
            status: d.status,
            reason: d.reason,
          })),
        } : undefined,
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
          ahpPacketGraph: ahpGraph ? JSON.stringify(ahpGraph) : undefined,
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

    // Emit a human-readable AHP graph summary to stderr when AHP data is present.
    if (ahpGraph) {
      console.error(formatAHPPacketGraphSummary(ahpGraph));
      // Emit focused issues view when something is wrong — zero noise on clean runs.
      const issuesSummary = formatAHPPacketGraphIssuesSummary(ahpGraph);
      if (issuesSummary) {
        console.error(issuesSummary);
      }
    }

    // If the agent tried tools that weren't available, surface that to the user.
    if (unknownTools && unknownTools.length > 0 && !result.followUpQuestion) {
      const toolList = unknownTools.map((t) => `\`${t}\``).join(", ");
      const plural = unknownTools.length > 1;
      result = {
        ...result,
        followUpQuestion: `I needed the ${toolList} tool${plural ? "s" : ""} to complete this task, but ${plural ? "they aren't" : "it isn't"} currently available. Would you like me to add ${plural ? "them" : "it"} or find another way to complete the task?`,
      };
    }

    return result;
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (event: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}
