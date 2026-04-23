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
import { throwIfAborted } from "./abort.js";

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
  initialGateBlockReason?: string,
  ahpPacket?: AHPPacket,
  initialArtifacts?: OrcaMaestroResult,
): Promise<OrcaExecutionResult> {
  let currentQC = initialQCResult;
  // Seed with the initial output so we always have something to show
  let lastOutputText: string | undefined = initialOutputText;
  let spentUsd = spentSoFarUsd ?? 0;
  let currentArtifacts = initialArtifacts;

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
        `You MUST use your available tools (read_file, write_file, list_directory, etc.) ` +
        `to actually perform the work. Do NOT just describe what you would do — ` +
        `call the tools and do it. Use <tool_call> blocks to invoke tools.`
      : '';

    const repairSpec: OrcaTaskSpec = {
      originalUserMessage: `${repairInstruction}${roleHint}${toolNudge}`,
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
                repairInstruction,
                originalRequest: originalTask.originalUserMessage,
              }
            : {}),
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
      repairPacketId: repairPacket?.id,
      repairRole,
      repairSpec,
    });

    emitter.emit({ type: "maestro:start", taskId: ctx.runId, attempt: pass, isRepair: true });
    const maestroResult = normalizeMaestroResult(await maestro.run(repairSpec, ctx));
    currentArtifacts = maestroResult;
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

    verifyRepairPackets(maestroResult, ctx);
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
    : initialGateBlockReason
      ? ` ${initialGateBlockReason}`
      : '';
  return {
    status: "FAIL",
    userFacingText: lastOutputText,
    summary: `Still failing after ${maxPasses} repair pass(es).${failureSuffix}`,
  };
}
