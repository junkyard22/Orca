/**
 * Miranda Core — Pipeline Types
 * All core interfaces, config, and type definitions.
 */
export type StageKind = "plan" | "answer" | "critique" | "rewrite";
export declare const STAGE_ORDER: readonly StageKind[];
export type StageFormat = "json" | "text";
export declare const STAGE_FORMAT: Record<StageKind, StageFormat>;
export interface ModelSpec {
    /** OpenRouter model ID, e.g. "deepseek/deepseek-chat" */
    id: string;
    /** Display name for logs */
    label: string;
}
export interface LLMRequest {
    model: string;
    messages: LLMMessage[];
    temperature: number;
    maxTokens: number;
}
export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface LLMResponse {
    content: string;
    model: string;
    usage: TokenUsage | null;
    durationMs: number;
}
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
export interface ValidationResult {
    valid: boolean;
    data?: unknown;
    errors?: string[];
}
export interface StageAttempt {
    attemptNumber: number;
    model: string;
    rawOutput: string;
    validation: ValidationResult;
    usage: TokenUsage | null;
    durationMs: number;
    costEstimate: number;
}
export interface StageResult {
    stage: StageKind;
    success: boolean;
    finalOutput: string;
    parsedData: unknown | null;
    attempts: StageAttempt[];
    modelUsed: string;
    totalCost: number;
}
export interface RunRecord {
    runId: string;
    timestamp: string;
    userPrompt: string;
    stages: StageResult[];
    totalCost: number;
    totalDurationMs: number;
    budgetExceeded: boolean;
    liteMode: boolean;
}
export interface RunSummary {
    runId: string;
    timestamp: string;
    prompt: string;
    stages: Array<{
        stage: StageKind;
        model: string;
        retries: number;
        cost: number;
        success: boolean;
    }>;
    totalCost: number;
    totalDurationMs: number;
    budgetExceeded: boolean;
    liteMode: boolean;
}
export interface ModelPricing {
    /** Cost per 1M input tokens in USD */
    inputPer1M: number;
    /** Cost per 1M output tokens in USD */
    outputPer1M: number;
}
/** Default pricing table (approximate, config-overridable) */
export declare const DEFAULT_PRICING: Record<string, ModelPricing>;
export interface CircuitBreakerConfig {
    /** Max failures before tripping the breaker */
    failureThreshold: number;
    /** Window in ms to count failures */
    windowMs: number;
    /** Cooldown in ms after tripping before retrying */
    cooldownMs: number;
}
export interface StageConfig {
    /** Ordered list of models to try for this stage (fallback ladder) */
    models: ModelSpec[];
    /** Max retries per model before escalating */
    maxRetriesPerModel: number;
    /** Max total attempts across all models for this stage */
    maxTotalAttempts: number;
    /** Base temperature (reduced on repair attempts) */
    baseTemperature: number;
    /** Max tokens for output */
    maxTokens: number;
    /** Timeout in ms per LLM call */
    timeoutMs: number;
}
export interface MirandaConfig {
    /** Config per stage */
    stages: Record<StageKind, StageConfig>;
    /** Budget per user request in USD */
    budgetUsd: number;
    /** Pricing table: model ID → pricing */
    pricing: Record<string, ModelPricing>;
    /** Circuit breaker settings */
    circuitBreaker: CircuitBreakerConfig;
    /** Path to JSONL log file */
    logPath: string;
    /** Whether to log to console */
    verbose: boolean;
}
export declare const DEFAULT_MODELS: Record<StageKind, ModelSpec[]>;
export declare function createDefaultConfig(overrides?: Partial<MirandaConfig>): MirandaConfig;
//# sourceMappingURL=types.d.ts.map