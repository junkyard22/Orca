/**
 * @deprecated LEGACY MULTI-STAGE PIPELINE — DO NOT EXTEND.
 *
 * Architectural boundary:
 *   Miranda is a compliance gate, not a response pipeline.
 *   The live Orca path uses createDirectLLMService + agent-loop-core.
 *   Do not extend the Miranda plan/answer/critique/rewrite pipeline.
 *   Future Miranda work must be gate-shaped: PASS / WARN / BLOCK / CONFIRM_REQUIRED.
 *
 * This file is preserved for reference and existing tests only. It is not on
 * the live Orca task path. New compliance/budget/permission logic belongs in
 * `gate/mirandaGate.ts`, not here.
 *
 * Miranda Core — Miranda Pipeline (legacy)
 * Sequential orchestrator: PLAN → ANSWER → CRITIQUE → REWRITE
 * with budget controls and JSONL logging.
 */

import { randomUUID } from "node:crypto";
import type { LLMAdapter } from "../llm/adapter.js";
import type {
  MirandaConfig,
  RunRecord,
  StageResult,
  LLMMessage,
} from "../pipeline/types.js";
import { STAGE_ORDER } from "../pipeline/types.js";
import { buildPlanSystemPrompt } from "../contracts/plan.js";
import { buildAnswerSystemPrompt } from "../contracts/answer.js";
import { buildCritiqueSystemPrompt } from "../contracts/critique.js";
import { buildRewriteSystemPrompt } from "../contracts/rewrite.js";
import { executeStage, type StageExecutionContext } from "./stage.js";
import { Router } from "../route/router.js";
import { CircuitBreaker } from "../route/circuitBreaker.js";
import { HealthTracker } from "../route/health.js";
import { appendRunLog, getRunSummary } from "../metrics/runStore.js";
import type { RunSummary } from "../pipeline/types.js";

export interface PipelineResult {
  record: RunRecord;
  summary: RunSummary;
}

/**
 * Build the initial LLM messages for a given stage.
 */
function buildStageMessages(
  stage: string,
  userPrompt: string,
  stageOutputs: Map<string, string>,
): LLMMessage[] {
  switch (stage) {
    case "plan":
      return [
        { role: "system", content: buildPlanSystemPrompt(userPrompt) },
        { role: "user", content: userPrompt },
      ];

    case "answer": {
      const planOutput = stageOutputs.get("plan") ?? "{}";
      return [
        {
          role: "system",
          content: buildAnswerSystemPrompt(userPrompt, planOutput),
        },
        { role: "user", content: userPrompt },
      ];
    }

    case "critique": {
      const answerOutput = stageOutputs.get("answer") ?? "";
      return [
        {
          role: "system",
          content: buildCritiqueSystemPrompt(userPrompt, answerOutput),
        },
        { role: "user", content: "Critique the answer above." },
      ];
    }

    case "rewrite": {
      const answerOutput = stageOutputs.get("answer") ?? "";
      const critiqueOutput = stageOutputs.get("critique") ?? "{}";
      return [
        {
          role: "system",
          content: buildRewriteSystemPrompt(
            userPrompt,
            answerOutput,
            critiqueOutput,
          ),
        },
        {
          role: "user",
          content: "Rewrite and improve the answer based on the critique.",
        },
      ];
    }

    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

/**
 * Run the full Miranda pipeline for a user prompt.
 *
 * Stages run sequentially: PLAN → ANSWER → CRITIQUE → REWRITE.
 * Budget is tracked across stages. If exceeded, CRITIQUE + REWRITE are skipped (lite mode).
 */
export async function runPipeline(
  userPrompt: string,
  adapter: LLMAdapter,
  config: MirandaConfig,
  callbacks?: {
    onToken?: (chunk: string) => void;
    onStreamReset?: () => void;
    /** Miranda gate — validates each LLM call before it fires and after it returns. */
    gate?: import("../gate/mirandaGate.js").MirandaGate;
    /**
     * When true, run only the ANSWER stage (skip PLAN, CRITIQUE, REWRITE).
     * Use for low-risk single-step tasks where the overhead of the full
     * pipeline isn't justified.
     */
    simple?: boolean;
  },
): Promise<PipelineResult> {
  const runId = randomUUID();
  const startTime = Date.now();

  if (config.verbose) {
    console.error(`\n[Pipeline] Run ${runId} started`);
    console.error(`[Pipeline] Prompt: "${userPrompt.slice(0, 80)}..."`);
  }

  const circuitBreaker = new CircuitBreaker(config.circuitBreaker);
  const healthTracker = new HealthTracker();
  const router = new Router(circuitBreaker, healthTracker);

  const stageResults: StageResult[] = [];
  const stageOutputs = new Map<string, string>();
  let totalCost = 0;
  let budgetExceeded = false;
  let liteMode = false;

  const SIMPLE_SKIP = new Set<string>(["plan", "critique", "rewrite"]);

  for (const stage of STAGE_ORDER) {
    // Simple mode: only run ANSWER, skip everything else.
    if (callbacks?.simple && SIMPLE_SKIP.has(stage)) {
      stageResults.push({
        stage,
        success: false,
        finalOutput: "",
        parsedData: null,
        attempts: [],
        modelUsed: "skipped",
        totalCost: 0,
      });
      continue;
    }

    // Budget check before CRITIQUE and REWRITE
    if (
      (stage === "critique" || stage === "rewrite") &&
      totalCost >= config.budgetUsd
    ) {
      budgetExceeded = true;
      liteMode = true;
      if (config.verbose) {
        console.error(
          `[Pipeline] Budget exceeded ($${totalCost.toFixed(6)} >= $${config.budgetUsd}). Skipping ${stage}.`,
        );
      }
      // Add a skipped stage result
      stageResults.push({
        stage,
        success: false,
        finalOutput: "",
        parsedData: null,
        attempts: [],
        modelUsed: "skipped",
        totalCost: 0,
      });
      continue;
    }

    const stageConfig = config.stages[stage];
    const messages = buildStageMessages(stage, userPrompt, stageOutputs);

    // Stream both answer (instant feedback) and rewrite (polished version).
    // Before rewrite starts, fire onStreamReset so the UI clears the answer
    // bubble and replaces it with the polished output.
    const shouldStream = stage === "answer" || stage === "rewrite";
    if (stage === "rewrite" && callbacks?.onStreamReset) {
      callbacks.onStreamReset();
    }

    const ctx: StageExecutionContext = {
      adapter,
      router,
      stageConfig,
      pricingTable: config.pricing,
      verbose: config.verbose,
      onToken: shouldStream ? callbacks?.onToken : undefined,
      gate: callbacks?.gate,
      budgetUsed: totalCost,
      budgetLimit: config.budgetUsd,
    };

    if (config.verbose) {
      console.error(`\n[Pipeline] === Stage: ${stage.toUpperCase()} ===`);
    }

    const result = await executeStage(stage, messages, ctx);
    stageResults.push(result);
    totalCost += result.totalCost;

    if (result.success) {
      stageOutputs.set(stage, result.finalOutput);
    } else {
      if (config.verbose) {
        console.error(`[Pipeline] Stage "${stage}" failed after all attempts.`);
      }
      // Store whatever we got so downstream stages have something
      stageOutputs.set(stage, result.finalOutput || "(stage failed)");
    }
  }

  const totalDurationMs = Date.now() - startTime;

  const record: RunRecord = {
    runId,
    timestamp: new Date().toISOString(),
    userPrompt,
    stages: stageResults,
    totalCost,
    totalDurationMs,
    budgetExceeded,
    liteMode,
  };

  // Persist to JSONL log
  try {
    appendRunLog(record, config.logPath);
  } catch (err) {
    if (config.verbose) {
      console.error(`[Pipeline] Failed to write run log: ${err}`);
    }
  }

  const summary = getRunSummary(record);

  if (config.verbose) {
    console.error(
      `\n[Pipeline] Run complete. Cost: $${totalCost.toFixed(6)}, Duration: ${totalDurationMs}ms`,
    );
  }

  return { record, summary };
}
