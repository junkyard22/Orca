/**
 * Miranda Core — Repair Engine
 * Orchestrates repair attempts with escalating prompts and reduced temperature.
 */
import type { LLMAdapter } from "../llm/adapter.js";
import type { LLMMessage, StageKind, StageConfig, ValidationResult } from "../pipeline/types.js";
export interface RepairAttemptResult {
    rawOutput: string;
    validation: ValidationResult;
    model: string;
    durationMs: number;
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    } | null;
}
/**
 * Get the temperature for a repair attempt (reduces with each attempt).
 */
export declare function getRepairTemperature(baseTemperature: number, attemptNumber: number): number;
/**
 * Build repair messages for a failed attempt.
 */
export declare function buildRepairMessages(stage: StageKind, attemptNumber: number, originalMessages: LLMMessage[], previousOutput: string, validationErrors: string[]): LLMMessage[];
/**
 * Validate stage output based on stage kind.
 */
export declare function validateStageOutput(stage: StageKind, rawOutput: string): ValidationResult;
/**
 * Execute a single repair attempt.
 */
export declare function executeRepairAttempt(adapter: LLMAdapter, model: string, messages: LLMMessage[], stage: StageKind, stageConfig: StageConfig, attemptNumber: number): Promise<RepairAttemptResult>;
//# sourceMappingURL=repairEngine.d.ts.map