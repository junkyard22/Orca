import type {
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaRunCtx,
  MaestroPort,
  PappyPort,
  OrcaMaestroResult,
} from "./types.js";
import type { AHPPacket } from "./ahp/types.js";
import { verifyAHPPacket } from "@clawde/pappy-core";
import type { PappyResult } from "@clawde/pappy-core";
import type { OrcaEmitter } from "./emitter.js";
import { buildPappyInput, normalizeMaestroResult } from "./helpers.js";
import { throwIfAborted, untilAborted } from "./abort.js";
import { buildQCGateContext, recordAfterQCGateDiagnostic } from "./qcGateDiagnostics.js";
import { accountPass, budgetStopReason, formatBudgetStop, withPassAccounting } from "./budget/passAccounting.js";
import type { PassAccounting } from "./budget/passAccounting.js";
import { classifyRepairIssue, decideRepair } from "./repairClassification.js";
import { buildHostRecord } from "./hostRecord.js";

type RepairSubagentRun = NonNullable<OrcaMaestroResult["subagentRuns"]>[number];

const INFRASTRUCTURE_ACTORS = new Set(["brain", "miranda", "pappy"]);

function selectRepairPacket(
  artifacts: OrcaMaestroResult | undefined,
  fallbackPacket?: AHPPacket,
): AHPPacket | undefined {
  const childCandidate = (artifacts?.ahpChildPackets ?? []).find((packet) =>
    typeof packet.repairPrompt === "string" ||
    packet.lifecycle !== "COMPLETE" ||
    (packet.verdict !== undefined && packet.verdict !== "PASS")
  );
  return childCandidate ?? artifacts?.ahpPacket ?? fallbackPacket;
}

function deriveRepairRole(
  packet: AHPPacket | undefined,
  artifacts: OrcaMaestroResult | undefined,
  fallbackRole?: string,
): string | undefined {
  if (!packet) return fallbackRole;
  const subagentRole = artifacts?.subagentRuns?.find((run) => run.packetId === packet.id)?.role;
  if (subagentRole) return subagentRole;
  const workerTrace = [...packet.trace].reverse().find((entry) => !INFRASTRUCTURE_ACTORS.has(entry.actor));
  return workerTrace?.actor ?? fallbackRole;
}

function verifyRepairPackets(
  artifacts: OrcaMaestroResult,
  ctx: OrcaRunCtx,
): void {
  const subagentRunsByPacketId = new Map<string, RepairSubagentRun>(
    (artifacts.subagentRuns ?? [])
      .filter((run): run is RepairSubagentRun & { packetId: string } => typeof run.packetId === "string" && run.packetId.length > 0)
      .map((run) => [run.packetId, run]),
  );

  if (artifacts.ahpPacket) {
    verifyAHPPacket(artifacts.ahpPacket, {
      outputText: artifacts.outputText,
      filesChanged: artifacts.filesChanged,
      workspaceRoot: ctx.workspaceRoot,
    });
    ctx.recordTrace?.("repair.pass.ahp.verify", {
      packet_id: artifacts.ahpPacket.id,
      artifactSource: "maestro",
      verdict: artifacts.ahpPacket.verdict,
      lifecycle: artifacts.ahpPacket.lifecycle,
    });
  }

  for (const packet of artifacts.ahpChildPackets ?? []) {
    const childRun = subagentRunsByPacketId.get(packet.id);
    if (!childRun && packet.verdict !== undefined) continue;
    verifyAHPPacket(packet, {
      outputText: childRun?.outputText ?? artifacts.outputText,
      filesChanged: childRun?.filesChanged ?? artifacts.filesChanged,
      workspaceRoot: ctx.workspaceRoot,
    });
    ctx.recordTrace?.("repair.pass.ahp.verify.child", {
      packet_id: packet.id,
      artifactSource: childRun ? "subagent" : "maestro",
      verdict: packet.verdict,
      lifecycle: packet.lifecycle,
    });
  }
}

function hasRepairPath(
  qcResult: PappyResult,
  artifacts: OrcaMaestroResult | undefined,
  fallbackPacket?: AHPPacket,
): boolean {
  if (qcResult.repairTask) return true;
  return typeof selectRepairPacket(artifacts, fallbackPacket)?.repairPrompt === "string";
}

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
 * Maestro never calls a model directly; ctx.llm is the only model surface
 * it touches. The concrete LLM service is injected at startup by the app shell.
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
  _initialGateBlockReason?: string,
  ahpPacket?: AHPPacket,
  initialArtifacts?: OrcaMaestroResult,
): Promise<OrcaExecutionResult> {
  let currentQC = initialQCResult;
  // Seed with the initial output so we always have something to show
  let lastOutputText: string | undefined = initialOutputText;
  let spentUsd = spentSoFarUsd ?? 0;
  let currentArtifacts = initialArtifacts;
  let lastPass: PassAccounting | undefined;

  for (let pass = 1; pass <= maxPasses; pass++) {
    throwIfAborted(ctx.abortSignal);
    // ── Budget guard — abort before spending more ──────────────────────────
    // The task ledger is the authority: it knows what was reconciled, what is
    // unreconciled and what is reserved. The legacy metadata sum is the
    // fallback for callers that run without a ledger.
    const ledgerStop = budgetStopReason(ctx.budget, lastPass);
    const legacyStop = (!ctx.budget || ctx.budget.snapshot().requests.total === 0) && budgetUsd && budgetUsd > 0 && spentUsd >= budgetUsd
      ? `Budget cap $${budgetUsd.toFixed(4)} reached ($${spentUsd.toFixed(4)} spent)`
      : undefined;
    if (ledgerStop || legacyStop) {
      const snapshot = ctx.budget?.snapshot();
      ctx.recordTrace?.("repair.budget_stop", {
        pass,
        maxPasses,
        budgetUsd: snapshot?.limitUsd ?? budgetUsd,
        spentUsd: snapshot?.accountedUsd ?? spentUsd,
        reason: ledgerStop ?? legacyStop,
        budget: snapshot,
      });
      return {
        status: "FAIL",
        userFacingText: lastOutputText,
        summary: `${ledgerStop && snapshot ? formatBudgetStop(ledgerStop, snapshot) : legacyStop} Skipped ${maxPasses - pass + 1} repair pass(es).`,
        ...(currentArtifacts ? { artifacts: currentArtifacts } : {}),
        qcResult: currentQC,
      };
    }
    // ── Is there anything a worker can fix? ────────────────────────────────
    // A FAIL whose blocking issues are all about evidence integrity (the
    // evidence could not be taken completely) or a call the user did not
    // approve cannot be resolved by editing code: a worker sent to "fix" it
    // rewrites correct source until its iterations run out. No pass is
    // dispatched; Pappy's FAIL stands and is reported for a person to act on.
    const decision = decideRepair(currentQC.issues);
    if (!decision.dispatch) {
      ctx.recordTrace?.("repair.skipped", {
        pass,
        maxPasses,
        reason: decision.reason,
        blocking: decision.blocking,
      });
      return {
        status: "FAIL",
        userFacingText: lastOutputText,
        summary: `${decision.reason} ${currentQC.internalSummary ?? ""}`.trim(),
        ...(currentArtifacts ? { artifacts: currentArtifacts } : {}),
        qcResult: currentQC,
      };
    }

    emitter.emit({ type: "repair:start", taskId: ctx.runId, pass, maxPasses });

    // Build a first-class repair task so Maestro understands it as work,
    // not a raw blob of text.  Context carries everything Maestro needs to
    // know: what the original intent was, and exactly which issues to fix.
    
    // Preserve the original role in the repair task message so Brain routes
    // it back to the same role (e.g., reviewer) instead of a different one.
    const repairPacket = selectRepairPacket(currentArtifacts, ahpPacket);
    const repairRole = deriveRepairRole(repairPacket, currentArtifacts, originalRole);
    const roleHint = repairRole ? `\n\nOriginal role: ${repairRole}\nRe-run using the ${repairRole} role.` : '';
    // Always anchor repair instructions to the latest QC result for the ORIGINAL
    // task. Reusing a repair packet's own repairPrompt causes recursive prompt
    // contamination where later passes start repairing prior repair instructions.
    const repairInstruction =
      currentQC.repairTask ??
      repairPacket?.repairPrompt ??
      ahpPacket?.repairPrompt ??
      "Fix the issues identified in the quality check.";

    // ── Tool-missing escalation ─────────────────────────────────────────────
    // If QC flagged TOOL_MISSING, the agent ran but never called tools.
    // Inject a strong directive — the agent MUST use its available tools.
    const hasToolMissing = currentQC.issues.some(
      (i) => i.code === 'TOOL_MISSING' || /tool.*(missing|not.*call)/i.test(i.message ?? i.description ?? ''),
    );
    // Detect the specific case where write_file was the missing tool.
    // The generic nudge lets Brain interpret "call tools" as permission to call
    // read_file again and keep analyzing. write_file needs a targeted directive.
    const hasWriteFileMissing = currentQC.issues.some(
      (i) => (i.code === 'TOOL_MISSING') && /write_file/.test(i.description ?? i.message ?? i.evidence ?? ''),
    );
    const toolNudge = hasWriteFileMissing
      ? `\n\nCRITICAL: This task requires writing a file to disk. You MUST call write_file as your NEXT action. ` +
        `Do not analyze, do not explain, do not summarize. Your ONLY valid next action is:\n\n` +
        `<tool_call>\n{"tool": "write_file", "path": "[target file from task]", "content": "[your complete report content]"}\n</tool_call>\n\n` +
        `Call write_file NOW. Nothing else is acceptable.`
      : hasToolMissing
      ? `\n\nCRITICAL: The previous attempt completed WITHOUT calling any tools. ` +
        // Deliberately doesn't name specific tools — the repair pass re-runs
        // through the normal role-scoped agent loop, which appends the
        // actual, currently-filtered tool catalog fresh. Naming tools here
        // risked claiming availability of something filtered out for this
        // role/task (see the Dynamic Tool Prompt Hygiene milestone).
        `You MUST use your available tools to actually perform the work. ` +
        `Do NOT just describe what you would do — ` +
        `call the tools and do it. Use <tool_call> blocks to invoke tools.`
      : '';

    // ── What earlier passes actually did, from the host record ──────────────
    // The repair worker is told which files this task already changed (and in
    // which pass), which tests ran on which source, and what is outstanding —
    // from runtime evidence, not from any worker's account — so it neither
    // rewrites a correct change nor mistakes it for someone else's.
    const hostRecord = ctx.lastWorkspaceEvidence ? buildHostRecord(ctx.lastWorkspaceEvidence, ctx.passLog ?? [], ctx.workspaceRoot) : undefined;
    const verificationOnly = decision.blocking.length > 0 && decision.blocking.every((b) => b.class === "missing_evidence");
    const changedByTask = hostRecord?.changes.filter((c) => c.attribution === "this_task") ?? [];
    const sourceChangeRequired = !(verificationOnly && changedByTask.length > 0);
    const blockingCodes = [...new Set(decision.blocking.map((b) => b.code))];
    const hostSection = hostRecord?.available
      ? [
          "",
          "",
          hostRecord.text,
          verificationOnly
            ? `- Outstanding: verification only. Pappy found missing evidence, not a defect in the code: ${blockingCodes.join(", ")}.`
            : `- Outstanding: ${decision.blocking.map((b) => `${b.code} (${b.class.replace("_", " ")})`).filter((v, k, a) => a.indexOf(v) === k).join(", ")}.`,
          sourceChangeRequired
            ? "Required next action: resolve what the issues describe; keep any change listed above that is already correct."
            : `Required next action: run the project's full test suite on the current source and report its recorded result. ${changedByTask.map((c) => c.path).join(", ")} was changed by this task. Keep that change, do not rewrite it unless a test fails, and do not describe it as pre-existing or as someone else's work.`,
        ].join("\n")
      : "";

    const repairSpec: OrcaTaskSpec = {
      originalUserMessage: `${repairInstruction}${hostSection}${roleHint}${toolNudge}`,
      intent: "repair",
      goals: [...originalTask.goals],
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
          ...(currentArtifacts?.ahpChildPackets?.length
            ? {
                targetRole: repairRole,
                targetChildPacket: repairPacket,
                priorSubagentRuns: currentArtifacts.subagentRuns ?? [],
                priorChildPackets: currentArtifacts.ahpChildPackets ?? [],
                synthesisHint: currentArtifacts.metadata?.decomposition?.synthesisHint,
                doneCriteria: currentArtifacts.doneCriteria ?? originalTask.goals,
                repairInstruction: `${repairInstruction}${hostSection}`,
                originalRequest: originalTask.originalUserMessage,
              }
            : {}),
          ...(hostRecord?.available
            ? { hostRecord: { text: hostRecord.text, changes: hostRecord.changes, testRuns: hostRecord.testRuns, finalSourceTested: hostRecord.finalSourceTested, sourceChangeRequired } }
            : {}),
          issues: currentQC.issues.map((i) => ({
            severity:    i.severity,
            code:        i.code,
            message:     i.message,
            suggestedFix: i.suggestedFix,
            class:       classifyRepairIssue(i),
          })),
        },
      },
    };
    ctx.recordTrace?.("repair.pass.spec", {
      pass,
      maxPasses,
      originalRole,
      repairPacketId: repairPacket?.id,
      repairRole,
      repairSpec,
    });

    emitter.emit({ type: "maestro:start", taskId: ctx.runId, attempt: pass, isRepair: true });
    let maestroResult: OrcaMaestroResult;
    if (ctx.budget) {
      const pass_ = await accountPass(ctx.budget, () => untilAborted(maestro.run(repairSpec, ctx), ctx.abortSignal), ctx.gate);
      maestroResult = withPassAccounting(normalizeMaestroResult(pass_.result), pass_.accounting);
      lastPass = pass_.accounting;
    } else {
      maestroResult = normalizeMaestroResult(await untilAborted(maestro.run(repairSpec, ctx), ctx.abortSignal));
    }
    currentArtifacts = maestroResult;
    ctx.passLog?.push({ pass: pass + 1, label: `repair pass ${pass}`, ...(maestroResult.metadata?.role ? { role: maestroResult.metadata.role } : {}), toolEvents: maestroResult.toolEvents ?? [] });
    lastOutputText = maestroResult.outputText ?? lastOutputText;
    spentUsd += (maestroResult.metadata?.costUsd ?? 0) + (maestroResult.metadata?.costUnreconciledUsd ?? 0);
    ctx.recordTrace?.("repair.pass.maestro_result", {
      pass,
      spentUsd,
      budget: ctx.budget?.snapshot(),
      maestroResult,
    });
    emitter.emit({ type: "maestro:done", taskId: ctx.runId, attempt: pass, isRepair: true, hasOutput: !!maestroResult.outputText });

    // A repair pass that could not get a single model request past the budget
    // produced nothing worth judging; stop here and say why, before QC.
    const passStop = lastPass && lastPass.settled === 0 ? budgetStopReason(ctx.budget, lastPass) : undefined;
    if (passStop && ctx.budget) {
      const snapshot = ctx.budget.snapshot();
      ctx.recordTrace?.("repair.budget_stop", { pass, maxPasses, reason: passStop, budget: snapshot });
      return {
        status: "FAIL",
        userFacingText: lastOutputText,
        summary: `${formatBudgetStop(passStop, snapshot)} Repair pass ${pass} made no model request.`,
        artifacts: maestroResult,
        qcResult: currentQC,
      };
    }

    // Evaluate THIS pass's maestroResult (latest artifacts) against the
    // ORIGINAL task constraints — the benchmark is always the user's goal,
    // never the repair spec.  "attempt: pass" lets Doctor correlate which
    // repair run produced which verdict.

    throwIfAborted(ctx.abortSignal);

    // Miranda: before_qc is an enforcing gate. A denial is a controlled stop;
    // the previous Pappy FAIL remains authoritative and is never re-judged.
    const beforeQcGate = ctx.gate?.beforeQC({
      taskId: ctx.runId,
      outputText: maestroResult.outputText ?? "",
    });
    if (beforeQcGate) {
      emitter.emit({
        type: "miranda:checkpoint",
        taskId: ctx.runId,
        gate: "before_qc",
        allowed: beforeQcGate.allowed,
        reason: beforeQcGate.reason,
      });
      if (!beforeQcGate.allowed) {
        ctx.recordTrace?.("repair.pass.qc_blocked", {
          pass,
          reason: beforeQcGate.reason,
        });
        return {
          status: "FAIL",
          userFacingText: lastOutputText,
          summary: currentQC.internalSummary,
          artifacts: maestroResult,
          qcResult: currentQC,
        };
      }
    }

    verifyRepairPackets(maestroResult, ctx);
    // Judge this pass with the runtime's workspace evidence and the receipts of
    // every earlier pass, so a reproduction run before the first fix still counts.
    ctx.lifecycle?.transition("VERIFYING", `repair pass ${pass} complete; Pappy evaluates`);
    const nextQC = pappy.evaluate(buildPappyInput(originalTask, maestroResult, await ctx.collectWorkspaceEvidence?.(), [...(ctx.verificationReceipts ?? [])]));
    ctx.verificationReceipts?.push(...(maestroResult.toolEvents ?? []));
    ctx.recordTrace?.("repair.pass.qc_result", {
      pass,
      verdict: nextQC.verdict,
      confidence: nextQC.confidence,
      issues: nextQC.issues,
      repairTask: nextQC.repairTask,
      internalSummary: nextQC.internalSummary,
    });

    // Miranda: after_qc gate diagnostics only. Pappy remains the quality verifier.
    const afterQcContext = buildQCGateContext({
      taskId: ctx.runId,
      outputText: maestroResult.outputText ?? "",
      qcResult: nextQC,
      qcStage: "repair",
      attempt: pass,
      maestroResult,
    });
    const afterQcGate = ctx.gate?.afterQC(
      afterQcContext,
      nextQC.verdict,
      nextQC.issues.length,
    );
    if (afterQcGate) {
      recordAfterQCGateDiagnostic(ctx, afterQcGate, afterQcContext);
      emitter.emit({
        type: "miranda:checkpoint",
        taskId: ctx.runId,
        gate: "after_qc",
        allowed: afterQcGate.allowed,
        verdict: afterQcGate.verdict,
        reason: afterQcGate.reason,
      });
    }

    emitter.emit({
      type: "qc:result",
      taskId: ctx.runId,
      attempt: pass,
      isRepair: true,
      verdict: nextQC.verdict,
      issueCount: nextQC.issues.length,
      issues: nextQC.issues.map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        description: issue.description,
      })),
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
        qcResult: nextQC,
      };
    }

    if (!hasRepairPath(nextQC, currentArtifacts, ahpPacket)) {
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
    : '';
  return {
    status: "FAIL",
    userFacingText: lastOutputText,
    summary: `Still failing after ${maxPasses} repair pass(es).${failureSuffix}`,
  };
}
