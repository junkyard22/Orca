/**
 * Miranda Core — Repair Engine
 * Orchestrates repair attempts with escalating prompts and reduced temperature.
 */

import type { LLMAdapter } from "../llm/adapter.js";
import type {
  LLMMessage,
  StageKind,
  StageConfig,
  ValidationResult,
} from "../pipeline/types.js";
import { STAGE_FORMAT } from "../pipeline/types.js";
import { PlanSchema, PLAN_EXAMPLE } from "../contracts/plan.js";
import { CritiqueSchema, CRITIQUE_EXAMPLE } from "../contracts/critique.js";
import { ANSWER_REQUIRED_HEADINGS } from "../contracts/answer.js";
import { REWRITE_REQUIRED_HEADINGS } from "../contracts/rewrite.js";
import { validateJson } from "../validate/validateJson.js";
import { validateTextSections } from "../validate/validateTextSections.js";
import { buildJsonRepairPrompt, buildTextRepairPrompt } from "./repairPrompts.js";

export interface RepairAttemptResult {
  rawOutput: string;
  validation: ValidationResult;
  model: string;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

/**
 * Get the temperature for a repair attempt (reduces with each attempt).
 */
export function getRepairTemperature(
  baseTemperature: number,
  attemptNumber: number
): number {
  // Attempt 1: base temp. Attempt 2: base * 0.5. Attempt 3+: 0
  if (attemptNumber <= 1) return baseTemperature;
  if (attemptNumber === 2) return Math.max(0, baseTemperature * 0.5);
  return 0;
}

/**
 * Build repair messages for a failed attempt.
 */
export function buildRepairMessages(
  stage: StageKind,
  attemptNumber: number,
  originalMessages: LLMMessage[],
  previousOutput: string,
  validationErrors: string[]
): LLMMessage[] {
  const format = STAGE_FORMAT[stage];
  const messages: LLMMessage[] = [...originalMessages];

  // Add the failed assistant response
  messages.push({ role: "assistant", content: previousOutput });

  // Add the repair prompt
  let repairContent: string;

  if (format === "json") {
    const schemaDesc =
      stage === "plan"
        ? '{ restatement, assumptions[], constraints[], approach_steps[], risks[], questions[] }'
        : '{ issues[{severity,issue,impact}], fixes[{fix,reason}], missing[], confidence }';
    const example =
      stage === "plan"
        ? JSON.stringify(PLAN_EXAMPLE, null, 2)
        : JSON.stringify(CRITIQUE_EXAMPLE, null, 2);

    repairContent = buildJsonRepairPrompt(
      attemptNumber,
      schemaDesc,
      example,
      previousOutput,
      validationErrors
    );
  } else {
    const headings =
      stage === "answer" ? ANSWER_REQUIRED_HEADINGS : REWRITE_REQUIRED_HEADINGS;
    repairContent = buildTextRepairPrompt(
      attemptNumber,
      headings,
      previousOutput,
      validationErrors
    );
  }

  messages.push({ role: "user", content: repairContent });
  return messages;
}

/**
 * Validate stage output based on stage kind.
 */
export function validateStageOutput(
  stage: StageKind,
  rawOutput: string
): ValidationResult {
  const format = STAGE_FORMAT[stage];

  if (format === "json") {
    if (stage === "plan") {
      return validateJson(rawOutput, PlanSchema);
    }
    return validateJson(rawOutput, CritiqueSchema);
  }

  const headings =
    stage === "answer" ? ANSWER_REQUIRED_HEADINGS : REWRITE_REQUIRED_HEADINGS;
  return validateTextSections(rawOutput, headings);
}

/**
 * Execute a single repair attempt.
 */
export async function executeRepairAttempt(
  adapter: LLMAdapter,
  model: string,
  messages: LLMMessage[],
  stage: StageKind,
  stageConfig: StageConfig,
  attemptNumber: number
): Promise<RepairAttemptResult> {
  const temperature = getRepairTemperature(
    stageConfig.baseTemperature,
    attemptNumber
  );

  const response = await adapter.complete({
    model,
    messages,
    temperature,
    maxTokens: stageConfig.maxTokens,
  });

  const validation = validateStageOutput(stage, response.content);

  return {
    rawOutput: response.content,
    validation,
    model: response.model,
    durationMs: response.durationMs,
    usage: response.usage,
  };
}
