import { buildHostRecord, correctProvenance } from "./hostRecord.js";
import { buildAcceptanceContract } from "./acceptanceContract.js";
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
import { isAbortError, throwIfAborted, untilAborted } from "./abort.js";
import { WorkspaceProtectedError } from "./workspaceGuard.js";
import { guardDispatch } from "./dispatchGuard.js";
import { buildQCGateContext, recordAfterQCGateDiagnostic } from "./qcGateDiagnostics.js";
import { BudgetRefusedError, TaskBudgetLedger, composeMirandaGates, createMirandaGate, currentBudgetLedger } from "@clawde/miranda-core";
import { TaskLifecycle } from "./lifecycle.js";
import { accountPass, budgetStopReason, formatBudgetStop, withPassAccounting } from "./budget/passAccounting.js";
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
import { createFilteredToolService } from "./toolFilter.js";
import { createWorkspaceEvidenceCollector } from "./workspaceEvidence.js";

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
    const taskPermissionGate = normalizedTaskSpec.permissions
      ? createMirandaGate({
          taskPermissions: {
            fileRead: normalizedTaskSpec.permissions.fileRead,
            fileWrite: normalizedTaskSpec.permissions.fileWrite,
            shellExec: normalizedTaskSpec.permissions.shellExec,
            networkAccess: normalizedTaskSpec.permissions.networkAccess ?? false,
          },
          connectorTools: deps.connectorTools,
        })
      : undefined;
    const effectiveGate = composeMirandaGates(deps.gate, taskPermissionGate);
    const workspaceContext = deps.getWorkspaceContext?.();
    const explicitWorkspaceRoot = extractExplicitWorkspaceRoot(normalizedTaskSpec);
    const effectiveWorkspaceRoot = explicitWorkspaceRoot ?? deps.workspaceRoot ?? workspaceContext?.cwd;
    const effectiveWorkspaceContext = effectiveWorkspaceRoot
      ? { ...(workspaceContext ?? {}), cwd: effectiveWorkspaceRoot }
      : workspaceContext;
    // A workspace an earlier task left unsettled (an operation or a child
    // process that may still write) is refused before anything is read or
    // any model is called. The error says what was left and how to recover.
    if (effectiveWorkspaceRoot && deps.workspaceGuard) {
      const protections = await deps.workspaceGuard.status(effectiveWorkspaceRoot);
      if (protections.length > 0) throw new WorkspaceProtectedError(protections);
    }

    const taskId = generateRunId();
    const startTime = Date.now();
    const traceEntries: OrcaPipelineTraceEntry[] = [];

    // Baseline the workspace before any worker runs, so verification compares
    // real before/after contents and host-observed test runs rather than what
    // the worker reports. The collector also watches the trace for test
    // commands and fingerprints the source as each one finishes.
    const evidence = effectiveWorkspaceRoot ? createWorkspaceEvidenceCollector(effectiveWorkspaceRoot) : undefined;
    if (evidence) await evidence.ready;

    const recordTrace = (stage: string, detail?: unknown): void => {
      evidence?.observeTrace(stage, detail);
      traceEntries.push({
        at: new Date().toISOString(),
        stage,
        detail: detail === undefined ? undefined : sanitizeTraceValue(detail),
      });
    };

    // One budget ledger for everything this task asks a model: the shell may
    // have opened one for the whole user interaction (then narration and
    // utility calls share it); otherwise the task gets its own, from the
    // configured limit. Every reservation, settlement and refusal is traced
    // and emitted so the UI and the journal see the figures as they move.
    const budgetLedger = currentBudgetLedger() ?? new TaskBudgetLedger({
      taskId,
      limitUsd: budgetUsd ?? null,
      limitSource: deps.budgetSource,
      customPrices: deps.customPrices,
      parent: deps.sessionBudget,
    });
    const unsubBudget = budgetLedger.subscribe({
      trace: (stage, detail) => recordTrace(stage, detail),
      onChange: (snapshot) => {
        emitter.emit({ type: "budget:update", taskId, budget: snapshot });
        deps.budgetJournal?.update(snapshot);
      },
    });
    deps.budgetJournal?.open(budgetLedger.taskId, budgetLedger.snapshot());
    recordTrace("budget.task", budgetLedger.snapshot());

    // The task's lifecycle: every state change is traced and emitted; a
    // cancellation request (the abort signal) moves it to CANCELLING at once,
    // and it only becomes CANCELLED when every tracked operation has settled.
    const lifecycle = new TaskLifecycle({ taskId });
    lifecycle.subscribe((snapshot, transition) => {
      if (!transition) return;
      recordTrace("task.state", { from: transition.from, to: transition.to, reason: transition.reason, activeOperations: snapshot.activeOperations.map((o) => `${o.kind} ${o.label}`) });
      emitter.emit({
        type: "task:state", taskId, state: transition.to, previous: transition.from, reason: transition.reason,
        activeOperations: snapshot.activeOperations.length,
        ...(snapshot.unsettledOperations.length > 0 ? { unsettledOperations: snapshot.unsettledOperations.map((o) => `${o.kind} ${o.label}`) } : {}),
        ...(snapshot.unsettledResources.length > 0 ? { unsettledResources: snapshot.unsettledResources.map((r) => `process ${r.pid} (${r.label})`) } : {}),
      });
    });
    const onAbort = () => lifecycle.cancel(options?.abortSignal?.reason instanceof Error ? options.abortSignal.reason.message : "cancelled");
    if (options?.abortSignal?.aborted) onAbort();
    else options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Approval waits are a lifecycle state of their own, and a cancelled task
    // never gets to ask: a stale request resolves to "not approved".
    const requestToolApproval = deps.requestToolApproval
      ? async (tool: string, args: Record<string, unknown>): Promise<boolean> => {
          if (!lifecycle.mayDispatch) return false;
          const previous = lifecycle.current;
          const op = lifecycle.begin("approval", tool, true);
          lifecycle.transition("WAITING_FOR_APPROVAL", `approval requested for ${tool}`);
          try {
            const approved = await deps.requestToolApproval!(tool, args);
            // An approval that arrives after cancellation authorizes nothing.
            return approved && lifecycle.mayDispatch;
          } finally {
            op.end();
            if (lifecycle.current === "WAITING_FOR_APPROVAL") lifecycle.transition(previous === "WAITING_FOR_APPROVAL" ? "RUNNING" : previous, `approval for ${tool} settled`);
          }
        }
      : undefined;

    const scopedTools = tools && (() => {
      const allowed = normalizedTaskSpec.permissions?.toolsAllowed;
      if (!allowed) return tools;
      if (allowed.length === 0) return undefined;
      return createFilteredToolService(tools, allowed);
    })();

    // A model call made for a task that is no longer running is refused the
    // same way a tool call is: a late worker callback cannot spend or act.
    const guardedLLM = guardDispatch(llm, lifecycle);

    const ctx: OrcaRunCtx = {
      llm: guardedLLM,
      runId: taskId,
      abortSignal: options?.abortSignal,
      recordTrace,
      budget: budgetLedger,
      lifecycle,
      toolNamesAllowed: normalizedTaskSpec.permissions?.toolsAllowed,
      // Every tool run through the runtime's service is a tracked operation
      // and is refused once cancellation was requested.
      tools: scopedTools && {
        ...scopedTools,
        execute: (name, input) => {
          if (!lifecycle.mayDispatch) {
            return Promise.resolve({ ok: false, output: "", error: `Tool ${name} not run: the task is ${lifecycle.current.toLowerCase()}.` });
          }
          return lifecycle.track("tool", name, () => scopedTools.execute(name, input));
        },
      },
      emit: (event) => emitter.emit(event),
      workspaceContext: effectiveWorkspaceContext,
      workspaceRoot: effectiveWorkspaceRoot,
      gate: effectiveGate,
      model: deps.model,
      requestToolApproval,
      collectWorkspaceEvidence: evidence
        ? async () => {
            // Evidence is judged only when nothing can still act for the task:
            // an operation in flight (a tool that has not settled, a model
            // request still open) makes the inventory partial, and Pappy
            // treats a partial inventory as insufficient evidence.
            // A scan for processes a command left behind answers within a few
            // seconds; it is waited for so a survivor is known before judging.
            await lifecycle.waitForScans(8000);
            // A recorded process that has exited can no longer write: wait a
            // bounded time for recorded processes to exit, release the ones
            // verified gone, and take the evidence afterwards — so the
            // inventory includes anything they wrote. Whatever is still
            // running (or cannot be verified) keeps the evidence partial.
            if (deps.processProbe && lifecycle.unsettledResources().length > 0) {
              const { released, remaining } = await lifecycle.reverifyResources(
                deps.processProbe,
                "verified gone before the workspace evidence was taken",
                { waitMs: deps.resourceSettleWaitMs ?? 10_000, intervalMs: 500 },
              );
              recordTrace("lifecycle.resources.reverified", {
                stage: "before_evidence",
                released: released.map((r) => ({ pid: r.pid, label: r.label, ownership: r.ownership ?? null })),
                remaining: remaining.map((r) => ({ pid: r.pid, label: r.label, ownership: r.ownership ?? null })),
              });
            }
            const collected = await evidence.collect();
            const active = lifecycle.activeOperations().filter((o) => o.kind !== "verification" && o.kind !== "scan");
            const survivors = lifecycle.unsettledResources();
            if (collected.available && (active.length > 0 || survivors.length > 0)) {
              const attributed = survivors.filter((r) => r.ownership !== "unknown");
              const unattributed = survivors.filter((r) => r.ownership === "unknown");
              const reasons = [
                ...(active.length > 0 ? [`${active.length} operation(s) still active while verifying: ${active.map((o) => `${o.kind} ${o.label}`).join(", ")}`] : []),
                ...(attributed.length > 0 ? [`${attributed.length} process(es) started by the task may still be writing: ${attributed.map((r) => `pid ${r.pid} (${r.label})`).join(", ")}`] : []),
                ...(unattributed.length > 0 ? [`${unattributed.length} process(es) of unknown ownership, created while the task's commands ran, are still running and may be writing: ${unattributed.map((r) => `pid ${r.pid} (${r.label})`).join(", ")}`] : []),
              ];
              const partialEvidence = { ...collected, partial: true, reason: reasons.join("; ") };
              ctx.lastWorkspaceEvidence = partialEvidence;
              return partialEvidence;
            }
            ctx.lastWorkspaceEvidence = collected;
            return collected;
          }
        : undefined,
      verificationReceipts: [],
      passLog: [],
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
      networkAccess: normalizedTaskSpec.permissions?.networkAccess ?? false,
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
        lifecycle.transition("REPAIRING", `repair pass ${event.pass} of ${event.maxPasses}`);
      }
    });
    const unsubStages = emitter.on("maestro:start", () => {
      lifecycle.transition("RUNNING", "Maestro started");
    });
    const unsubQc = emitter.on("qc:result", () => {
      // The verdict is in; the lifecycle moves on when the runtime decides what follows.
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
          ctx.acceptanceContract ??= buildAcceptanceContract(normalizedTaskSpec, auditMaestroResult.doneCriteria);
          recordTrace("acceptance.contract", ctx.acceptanceContract);
          const qcInput = buildPappyInput(normalizedTaskSpec, auditMaestroResult, await ctx.collectWorkspaceEvidence?.(), [...(ctx.verificationReceipts ?? [])], ctx.acceptanceContract.goals);
          ctx.verificationReceipts?.push(...(auditMaestroResult.toolEvents ?? []));
          recordTrace("qc.run.start", { attempt: 0, isRepair: false, input: qcInput });
          const beforeQcGate = ctx.gate?.beforeQC({ taskId, outputText });
          if (beforeQcGate) {
            emitter.emit({
              type: "miranda:checkpoint",
              taskId,
              gate: "before_qc",
              allowed: beforeQcGate.allowed,
              reason: beforeQcGate.reason,
            });
          }

          if (beforeQcGate && !beforeQcGate.allowed) {
            gateBlockReason = beforeQcGate.reason;
            recordTrace("qc.run.blocked", {
              attempt: 0,
              isRepair: false,
              reason: beforeQcGate.reason,
            });
            result = {
              status: "FAIL",
              userFacingText: outputText,
              summary: "Quality verification was blocked before evaluation.",
              artifacts: { auditResult },
            };
          } else {
          const qcResult = pappy.evaluate(qcInput);
          persistedQcResult = qcResult;
          const afterQcContext = buildQCGateContext({
            taskId,
            outputText,
            qcResult,
            qcStage: "initial",
            attempt: 0,
            maestroResult: auditMaestroResult,
          });
          const afterQcGate = ctx.gate?.afterQC(
            afterQcContext,
            qcResult.verdict,
            qcResult.issues.length,
          );
          if (afterQcGate) {
            recordAfterQCGateDiagnostic(ctx, afterQcGate, afterQcContext);
            emitter.emit({
              type: "miranda:checkpoint",
              taskId,
              gate: "after_qc",
              allowed: afterQcGate.allowed,
              verdict: afterQcGate.verdict,
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
            issues: qcResult.issues.map((issue) => ({
              severity: issue.severity,
              code: issue.code,
              description: issue.description,
            })),
          });
          recordTrace("qc.run.result", {
            attempt: 0,
            isRepair: false,
            verdict: qcResult.verdict,
            confidence: qcResult.confidence,
            issues: qcResult.issues,
            repairTask: qcResult.repairTask,
            internalSummary: qcResult.internalSummary,
            evidenceRequests: qcResult.evidenceRequests,
          });
          result = {
            status: qcResult.verdict === "FAIL" ? "FAIL" : "SUCCESS",
            userFacingText: outputText,
            summary: qcResult.internalSummary,
            artifacts: { auditResult },
          };
          }
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

      const initialPass = await accountPass(budgetLedger, () => untilAborted(maestro.run(normalizedTaskSpec, ctx), options?.abortSignal), effectiveGate);
      const maestroResult = withPassAccounting(normalizeMaestroResult(initialPass.result), initialPass.accounting);
      persistedMaestroResult = maestroResult;
      // One acceptance contract for the whole task: the user's goals plus the
      // criteria Brain derived for this pass, fixed now and used for every
      // verdict (first pass, repairs) — a repair cannot change the standard.
      ctx.acceptanceContract ??= buildAcceptanceContract(normalizedTaskSpec, maestroResult.doneCriteria);
      recordTrace("acceptance.contract", ctx.acceptanceContract);
      ctx.passLog?.push({ pass: 1, label: "first pass", ...(maestroResult.metadata?.role ? { role: maestroResult.metadata.role } : {}), toolEvents: maestroResult.toolEvents ?? [] });
      const initialSpendUsd = (maestroResult.metadata?.costUsd ?? 0) + (maestroResult.metadata?.costUnreconciledUsd ?? 0);

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
        const subagentRunsByPacketId = new Map(
          (maestroResult.subagentRuns ?? [])
            .filter((run) => typeof run.packetId === "string" && run.packetId.length > 0)
            .map((run) => [run.packetId!, run] as const),
        );
        const verifyPacketForQc = (
          packet: AHPPacket,
          traceStage: string,
          verificationInput: {
            outputText?: string;
            filesChanged?: typeof maestroResult.filesChanged;
            artifactSource: "maestro" | "subagent";
          },
        ): void => {
          if (verifiedAHPIdsForQc.has(packet.id)) return;
          verifiedAHPIdsForQc.add(packet.id);
          verifyAHPPacket(packet, {
            outputText: verificationInput.outputText,
            filesChanged: verificationInput.filesChanged,
            workspaceRoot: effectiveWorkspaceRoot,
          });
          recordTrace(traceStage, {
            packet_id: packet.id,
            lifecycle: packet.lifecycle,
            verdict: packet.verdict,
            artifactSource: verificationInput.artifactSource,
          });
        };
        if (maestroResult.ahpPacket) {
          verifyPacketForQc(maestroResult.ahpPacket, "ahp.verify", {
            outputText: maestroResult.outputText,
            filesChanged: maestroResult.filesChanged,
            artifactSource: "maestro",
          });
        }
        for (const childPacket of maestroResult.ahpChildPackets ?? []) {
          const childRun = subagentRunsByPacketId.get(childPacket.id);
          verifyPacketForQc(childPacket, "ahp.verify.child", {
            outputText: childRun?.outputText ?? maestroResult.outputText,
            filesChanged: childRun?.filesChanged ?? maestroResult.filesChanged,
            artifactSource: childRun ? "subagent" : "maestro",
          });
        }

        lifecycle.transition("VERIFYING", "initial pass complete; Pappy evaluates");
        const qcInput = buildPappyInput(normalizedTaskSpec, maestroResult, await ctx.collectWorkspaceEvidence?.(), [...(ctx.verificationReceipts ?? [])], ctx.acceptanceContract?.goals);
        ctx.verificationReceipts?.push(...(maestroResult.toolEvents ?? []));
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
        }

        if (beforeQcGate && !beforeQcGate.allowed) {
          gateBlockReason = beforeQcGate.reason;
          recordTrace("qc.run.blocked", {
            attempt: 0,
            isRepair: false,
            reason: beforeQcGate.reason,
          });
          result = {
            status: "FAIL",
            userFacingText: maestroResult.outputText,
            summary: "Quality verification was blocked before evaluation.",
          };
        } else {
        const qcResult = pappy.evaluate(qcInput);
        persistedQcResult = qcResult;

        const afterQcContext = buildQCGateContext({
          taskId,
          outputText: maestroResult.outputText ?? "",
          qcResult,
          qcStage: "initial",
          attempt: 0,
          maestroResult,
        });
        const afterQcGate = ctx.gate?.afterQC(
          afterQcContext,
          qcResult.verdict,
          qcResult.issues.length,
        );
        if (afterQcGate) {
          recordAfterQCGateDiagnostic(ctx, afterQcGate, afterQcContext);
          emitter.emit({
            type: "miranda:checkpoint",
            taskId,
            gate: "after_qc",
            allowed: afterQcGate.allowed,
            verdict: afterQcGate.verdict,
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
          issues: qcResult.issues.map((issue) => ({
            severity: issue.severity,
            code: issue.code,
            description: issue.description,
          })),
        });
        recordTrace("qc.run.result", {
          attempt: 0,
          isRepair: false,
          verdict: qcResult.verdict,
          confidence: qcResult.confidence,
          issues: qcResult.issues,
          repairTask: qcResult.repairTask,
          internalSummary: qcResult.internalSummary,
          evidenceRequests: qcResult.evidenceRequests,
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
        } else if (
          !qcResult.repairTask &&
          !maestroResult.ahpPacket?.repairPrompt &&
          !(maestroResult.ahpChildPackets ?? []).some((packet) => typeof packet.repairPrompt === "string")
        ) {
          recordTrace("repair.unavailable", { reason: "pappy_returned_no_repair_task" });
          result = {
            status: "FAIL",
            userFacingText: maestroResult.outputText,
            summary: qcResult.internalSummary,
          };
        } else if (budgetStopReason(budgetLedger, initialPass.accounting) || legacyBudgetStop(budgetLedger, budgetUsd, initialSpendUsd)) {
          // The ledger decides; a Maestro that reports its own cost without
          // going through a budgeted adapter keeps the legacy cap check.
          const ledgerReason = budgetStopReason(budgetLedger, initialPass.accounting);
          const snapshot = budgetLedger.snapshot();
          recordTrace("repair.skipped.budget", {
            budgetUsd: snapshot.limitUsd ?? budgetUsd,
            spentUsd: initialSpendUsd,
            reason: ledgerReason ?? legacyBudgetStop(budgetLedger, budgetUsd, initialSpendUsd),
            budget: snapshot,
          });
          result = {
            status: "FAIL",
            userFacingText: maestroResult.outputText,
            summary: `${ledgerReason ? formatBudgetStop(ledgerReason, snapshot) : `${legacyBudgetStop(budgetLedger, budgetUsd, initialSpendUsd)}.`} Repair skipped.`,
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
            undefined,
            maestroResult.ahpPacket,
            maestroResult,
          );
          if (result.artifacts) {
            persistedMaestroResult = normalizeMaestroResult(result.artifacts as OrcaMaestroResult);
            persistedQcResult = result.qcResult ?? persistedQcResult;
            if (persistedQcResult) {
              recordTrace("repair.final_result", {
                result: persistedMaestroResult,
                qcVerdict: persistedQcResult.verdict,
                qcIssues: persistedQcResult.issues,
              });
            }
          }
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
        // The promise rejected, but the task is not stopped until its
        // operations have settled: wait for them, then say what never did.
        lifecycle.cancel(abortError.message);
        const settled = await lifecycle.drain(deps.drainTimeoutMs ?? 10_000);
        // Operations that ended but left a process unconfirmed already moved
        // the task to INTERRUPTED; operations still active do so here.
        if (!settled && !lifecycle.terminal) lifecycle.interrupt(`${abortError.message}; operations still active after ${deps.drainTimeoutMs ?? 10_000} ms`);
        recordTrace(settled ? "task.cancelled" : "task.interrupted", lifecycle.snapshot());
      } else if (error instanceof BudgetRefusedError) {
        // A model request was refused before dispatch and nothing above could
        // continue without it. The task is incomplete; say exactly why.
        const snapshot = budgetLedger.snapshot();
        result = {
          status: "FAIL",
          userFacingText: persistedMaestroResult?.outputText,
          summary: formatBudgetStop(error.decision.reason, snapshot),
        };
        recordTrace("budget.stop", { kind: error.decision.kind, reason: error.decision.reason, budget: snapshot });
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
    unsubBudget();
    const finalBudget = budgetLedger.snapshot();
    recordTrace("budget.final", finalBudget);
    deps.budgetJournal?.close(budgetLedger.taskId);
    unsubRepair();
    unsubStages();
    unsubQc();
    unsubDewey();
    unsubMiranda();
    options?.abortSignal?.removeEventListener("abort", onAbort);

    // The lifecycle ends from the result, never from the promise: a task is
    // COMPLETED only when it succeeded and QC did not fail; a cancellation
    // outcome already set above wins over any late result. Either way the
    // task is not over while something it started still runs: an operation
    // left behind by a failed or finished pass is waited for, and one that
    // will not settle makes the task INTERRUPTED rather than quietly done.
    if (!lifecycle.terminal && lifecycle.activeOperations().length > 0) {
      await lifecycle.drain(deps.drainTimeoutMs ?? 10_000);
      if (lifecycle.activeOperations().length > 0) {
        lifecycle.interrupt(`${result.status}: operations still active after the task ended (${deps.drainTimeoutMs ?? 10_000} ms)`);
        recordTrace("task.interrupted", lifecycle.snapshot());
      }
    }
    // The final explanation is checked against what the host recorded: a
    // statement that the change pre-existed, came from someone else, or was
    // made in a pass that made no change is corrected from the record.
    const hostRecord = ctx.lastWorkspaceEvidence ? buildHostRecord(ctx.lastWorkspaceEvidence, ctx.passLog ?? [], effectiveWorkspaceRoot) : undefined;
    let provenance: OrcaExecutionResult["provenance"];
    if (hostRecord && !abortError && result.userFacingText) {
      const corrected = correctProvenance(result.userFacingText, hostRecord);
      if (corrected.check.contradictions.length > 0) {
        provenance = { contradictions: corrected.check.contradictions, corrected: corrected.text !== result.userFacingText };
        recordTrace("provenance.corrected", { contradictions: corrected.check.contradictions, correction: corrected.check.correction ?? null });
        result = { ...result, userFacingText: corrected.text };
      }
    }
    if (hostRecord) result = { ...result, hostRecord, ...(provenance ? { provenance } : {}) };
    if (!lifecycle.terminal) {
      const succeeded = !abortError && result.status !== "FAIL" && persistedQcResult?.verdict !== "FAIL";
      lifecycle.finish(succeeded ? "COMPLETED" : "FAILED", abortError ? abortError.message : `${result.status}: ${result.summary ?? ""}`);
    }
    const finalLifecycle = lifecycle.snapshot();
    if (finalLifecycle.notes.length > 0) recordTrace("task.notes", { notes: finalLifecycle.notes });
    // The task's state is settled; its workspace may not be. A task that was
    // interrupted, or that ended (even COMPLETED) with a process it started
    // still running, leaves the workspace protected until the leftovers
    // settle, are verified gone, or the user knowingly overrides.
    // Probe recorded processes once more: one that has exited since the
    // evidence was taken does not leave the workspace protected. Anything
    // still running, or that cannot be verified, still does.
    if (deps.processProbe && lifecycle.unsettledResources().length > 0) {
      const { released, remaining } = await lifecycle.reverifyResources(deps.processProbe, "verified gone when the task ended");
      recordTrace("lifecycle.resources.reverified", {
        stage: "task_end",
        released: released.map((r) => ({ pid: r.pid, label: r.label, ownership: r.ownership ?? null })),
        remaining: remaining.map((r) => ({ pid: r.pid, label: r.label, ownership: r.ownership ?? null })),
      });
    }
    const leftover = lifecycle.activeOperations().length > 0 || lifecycle.unsettledResources().length > 0;
    if (finalLifecycle.state === "INTERRUPTED" || leftover) {
      const operations = lifecycle.activeOperations().map((o) => `${o.kind} ${o.label}`);
      const resources = lifecycle.unsettledResources().map((r) => `process ${r.pid} (${r.label})`);
      if (effectiveWorkspaceRoot && deps.workspaceGuard) {
        const protection = deps.workspaceGuard.protect(effectiveWorkspaceRoot, { taskId, reason: finalLifecycle.state === "INTERRUPTED" ? "was interrupted with work still running" : `ended ${finalLifecycle.state.toLowerCase()}, but a process it started is still running`, lifecycle });
        const recovery = deps.workspaceGuard.describe([protection]);
        recordTrace("workspace.protected", { root: protection.root, operations, resources });
        emitter.emit({ type: "workspace:protected", taskId, root: protection.root, reason: protection.reason, operations, resources, recovery });
      } else {
        recordTrace("workspace.unprotected", { root: effectiveWorkspaceRoot ?? null, operations, resources, note: "no workspace guard is configured; the host must keep the workspace quiet" });
      }
    }
    const stoppedBecause = (finalLifecycle.state === "CANCELLED" ? "cancelled" : finalLifecycle.state === "INTERRUPTED" ? "interrupted" : persistedMaestroResult?.metadata?.stoppedBecause) as RunRecord["stoppedBecause"];

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
        budget: finalBudget,
        lifecycle: finalLifecycle,
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

    // A cancelled task reports its state through task:state and its run record;
    // it never emits a completion summary.
    if (!abortError) emitter.emit({ type: "task:done", taskId, status: result.status });

    if (persistedQcResult && !abortError) {
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
        budget: finalBudget,
        lifecycle: finalLifecycle,
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

    const ledgerIsAccountOfRecord = finalBudget.requests.total > 0;
    try {
      const saveResult = deps.store?.saveRun(
        {
          id: taskId,
          createdAt: new Date(startTime).toISOString(),
          intent: normalizedTaskSpec.intent,
          role: persistedMaestroResult?.metadata?.role,
          brainDecision: persistedMaestroResult?.metadata?.brainDecision,
          status: result.status,
          stoppedBecause,
          errorMessage: persistedMaestroResult?.metadata?.errorMessage ?? gateBlockReason,
          iterationCount: persistedMaestroResult?.metadata?.iterationCount,
          outputText: result.userFacingText,
          // A stopped task has no result summary of its own ("Unknown error"
          // is the placeholder it never got past); say what happened instead.
          summary: finalLifecycle.state === "CANCELLED" ? "Stopped before completion (cancelled by the user)."
            : finalLifecycle.state === "INTERRUPTED" ? "Stopped before completion (interrupted: work was still running)."
            : result.summary,
          verdict: persistedQcResult?.verdict,
          confidence: persistedQcResult?.confidence,
          issueCount: persistedQcResult?.issues.length,
          // The task ledger is the account of record: it covers every pass
          // (initial and repairs) and every request, including those of a
          // cancelled or interrupted task. The Maestro metadata describes the
          // last pass only, and is absent when the task was stopped — the 1.7.0
          // rehearsal persisted a repaired task at the last pass's cost and an
          // interrupted task at no cost while the UI showed the real figures.
          inputTokens: ledgerIsAccountOfRecord ? finalBudget.inputTokens : persistedMaestroResult?.metadata?.inputTokens,
          outputTokens: ledgerIsAccountOfRecord ? finalBudget.outputTokens : persistedMaestroResult?.metadata?.outputTokens,
          costUsd: ledgerIsAccountOfRecord ? finalBudget.spentUsd : persistedMaestroResult?.metadata?.costUsd,
          costUnreconciledUsd: ledgerIsAccountOfRecord ? (finalBudget.unreconciledUsd > 0 ? finalBudget.unreconciledUsd : undefined) : persistedMaestroResult?.metadata?.costUnreconciledUsd,
          costBasis: ledgerIsAccountOfRecord ? finalBudget.costBasis : persistedMaestroResult?.metadata?.costBasis,
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

    if (abortError) throw abortError;

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

    // The caller sees the lifecycle the trace and the summary saw: a result
    // alone cannot say whether the task settled quietly.
    return { ...result, lifecycle: finalLifecycle, ...(persistedQcResult && !result.qcResult ? { qcResult: persistedQcResult } : {}) };
  }

  return {
    executeTask,
    on: (type: OrcaEventType, handler: (event: OrcaEvent) => void) =>
      emitter.on(type, handler),
  };
}

/**
 * Legacy cap check for a Maestro that reports `metadata.costUsd` itself and
 * makes no request through a budgeted adapter (the ledger saw nothing).
 */
function legacyBudgetStop(ledger: TaskBudgetLedger, budgetUsd: number | undefined, spentUsd: number): string | undefined {
  if (ledger.snapshot().requests.total > 0) return undefined;
  if (!budgetUsd || budgetUsd <= 0 || spentUsd < budgetUsd) return undefined;
  return `Budget cap $${budgetUsd.toFixed(4)} reached ($${spentUsd.toFixed(4)} spent on initial pass)`;
}
