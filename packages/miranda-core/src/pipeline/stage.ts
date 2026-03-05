/**
 * Miranda Core — Stage Executor
 * Executes a single pipeline stage through the repair loop with model escalation.
 */

import type { LLMAdapter } from "../llm/adapter.js";
import type {
  StageKind,
  StageConfig,
  StageResult,
  StageAttempt,
  LLMMessage,
  TokenUsage,
} from "../pipeline/types.js";
import { Router } from "../route/router.js";
import { validateStageOutput, buildRepairMessages, getRepairTemperature } from "../repair/repairEngine.js";
import { resolveTokenUsage } from "../metrics/tokens.js";
import { calculateCost } from "../metrics/costs.js";
import type { MirandaGate } from "../gate/mirandaGate.js";

export interface StageExecutionContext {
  adapter: LLMAdapter;
  router: Router;
  stageConfig: StageConfig;
  pricingTable: Record<string, import("../pipeline/types.js").ModelPricing>;
  verbose: boolean;
  /**
   * Called for each streamed token on answer/rewrite stages.
   * Only fires on the first attempt (before any repair), using adapter.stream()
   * if the adapter supports it.
   */
  onToken?: (chunk: string) => void;
  /**
   * Miranda's gate — called before and after each LLM adapter call.
   * before_llm_call: validates model + budget.
   * after_llm_call:  validates output shape (informational; repair loop handles retries).
   */
  gate?: MirandaGate;
  /** USD spent in prior stages of this run — fed to before_llm_call gate. */
  budgetUsed?: number;
  /** USD budget cap for this run — fed to before_llm_call gate. */
  budgetLimit?: number;
}

/**
 * Execute a single stage through the full repair loop + model escalation.
 *
 * 1. Select model from router
 * 2. Send prompt, validate response
 * 3. If invalid: repair loop (up to maxRetriesPerModel)
 * 4. If still invalid: escalate to next model
 * 5. Cap total attempts at maxTotalAttempts
 */
export async function executeStage(
  stage: StageKind,
  initialMessages: LLMMessage[],
  ctx: StageExecutionContext
): Promise<StageResult> {
  const { adapter, router, stageConfig, pricingTable, verbose, onToken } = ctx;
  const attempts: StageAttempt[] = [];
  const triedModels = new Set<string>();

  let totalAttempts = 0;
  let lastValidOutput = "";
  let lastParsedData: unknown = null;

  while (totalAttempts < stageConfig.maxTotalAttempts) {
    // Select model (skip already-exhausted models)
    const selection = router.selectModel(stage, stageConfig, triedModels);
    if (!selection) {
      if (verbose) {
        console.error(`  [Miranda] All models exhausted for stage "${stage}"`);
      }
      break;
    }

    const { model, isEscalation } = selection;
    if (isEscalation && verbose) {
      console.error(`  [Miranda] Escalating to ${model.label} for "${stage}"`);
    }

    let currentMessages = [...initialMessages];
    let modelAttempts = 0;

    while (
      modelAttempts < stageConfig.maxRetriesPerModel &&
      totalAttempts < stageConfig.maxTotalAttempts
    ) {
      totalAttempts++;
      modelAttempts++;

      const temperature = getRepairTemperature(
        stageConfig.baseTemperature,
        modelAttempts
      );

      if (verbose) {
        console.error(
          `  [Miranda] ${stage} attempt ${totalAttempts} (model: ${model.label}, temp: ${temperature})`
        );
      }

      try {
        // ── before_llm_call gate ──────────────────────────────────────────
        if (ctx.gate) {
          const gateCtx = {
            stage,
            model: model.id,
            budgetUsed: ctx.budgetUsed ?? 0,
            budgetLimit: ctx.budgetLimit ?? Infinity,
          };
          const gateResult = ctx.gate.beforeLLMCall(gateCtx);
          if (!gateResult.allowed) {
            const blockedAttempt: StageAttempt = {
              attemptNumber: totalAttempts,
              model: model.id,
              rawOutput: "",
              validation: {
                valid: false,
                errors: gateResult.violations ?? [`Gate blocked: ${gateResult.reason}`],
              },
              usage: null,
              durationMs: 0,
              costEstimate: 0,
            };
            attempts.push(blockedAttempt);
            if (verbose) {
              console.error(`  [Miranda] before_llm_call gate blocked: ${gateResult.reason}`);
            }
            break; // Move to next model
          }
        }

        // Stream the first attempt if the adapter supports it and an onToken
        // callback is available (set only on answer/rewrite stages by the pipeline).
        const useStream = totalAttempts === 1 && onToken != null && adapter.stream != null;
        const response = useStream
          ? await adapter.stream!(
              { model: model.id, messages: currentMessages, temperature, maxTokens: stageConfig.maxTokens },
              onToken!,
            )
          : await adapter.complete({
              model: model.id,
              messages: currentMessages,
              temperature,
              maxTokens: stageConfig.maxTokens,
            });

        // Build prompt text for token estimation
        const promptText = currentMessages.map((m) => m.content).join("\n");
        const usage = resolveTokenUsage(
          response.usage,
          promptText,
          response.content
        );
        const cost = calculateCost(model.id, usage, pricingTable);

        const validation = validateStageOutput(stage, response.content);

        const attempt: StageAttempt = {
          attemptNumber: totalAttempts,
          model: response.model,
          rawOutput: response.content,
          validation,
          usage,
          durationMs: response.durationMs,
          costEstimate: cost,
        };
        attempts.push(attempt);

        // ── after_llm_call gate ───────────────────────────────────────────
        if (ctx.gate) {
          const gateCtx = {
            stage,
            model: model.id,
            budgetUsed: ctx.budgetUsed ?? 0,
            budgetLimit: ctx.budgetLimit ?? Infinity,
          };
          ctx.gate.afterLLMCall(gateCtx, response.content, validation);
          // Informational: gate records the result; repair loop drives retries.
        }

        if (validation.valid) {
          router.recordSuccess(model.id);
          return buildSuccessResult(stage, response.content, validation.data, attempts, model.id);
        }

        // Validation failed — build repair messages
        if (verbose) {
          console.error(
            `  [Miranda] Validation failed: ${(validation.errors ?? []).join(", ")}`
          );
        }

        currentMessages = buildRepairMessages(
          stage,
          modelAttempts,
          currentMessages,
          response.content,
          validation.errors ?? ["Unknown validation error"]
        );

        lastValidOutput = response.content;
        lastParsedData = validation.data ?? null;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (verbose) {
          console.error(`  [Miranda] LLM call failed: ${errorMsg}`);
        }

        router.recordFailure(model.id, errorMsg);

        const failAttempt: StageAttempt = {
          attemptNumber: totalAttempts,
          model: model.id,
          rawOutput: "",
          validation: { valid: false, errors: [`LLM error: ${errorMsg}`] },
          usage: null,
          durationMs: 0,
          costEstimate: 0,
        };
        attempts.push(failAttempt);
        break; // Move to next model
      }
    }

    // Mark this model as tried
    triedModels.add(model.id);
  }

  // All attempts exhausted — return failure
  return buildFailureResult(stage, lastValidOutput, lastParsedData, attempts);
}

function buildSuccessResult(
  stage: StageKind,
  finalOutput: string,
  parsedData: unknown,
  attempts: StageAttempt[],
  modelUsed: string
): StageResult {
  return {
    stage,
    success: true,
    finalOutput,
    parsedData,
    attempts,
    modelUsed,
    totalCost: sumCosts(attempts),
  };
}

function buildFailureResult(
  stage: StageKind,
  lastOutput: string,
  lastData: unknown,
  attempts: StageAttempt[]
): StageResult {
  const lastAttempt = attempts[attempts.length - 1];
  return {
    stage,
    success: false,
    finalOutput: lastOutput,
    parsedData: lastData,
    attempts,
    modelUsed: lastAttempt?.model ?? "unknown",
    totalCost: sumCosts(attempts),
  };
}

function sumCosts(attempts: StageAttempt[]): number {
  return attempts.reduce((sum, a) => sum + a.costEstimate, 0);
}
