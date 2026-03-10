/**
 * Miranda Core — Pipeline Types
 * All core interfaces, config, and type definitions.
 */

// ---------------------------------------------------------------------------
// Stage Kinds
// ---------------------------------------------------------------------------

export type StageKind = "plan" | "answer" | "critique" | "rewrite";

export const STAGE_ORDER: readonly StageKind[] = [
  "plan",
  "answer",
  "critique",
  "rewrite",
] as const;

export type StageFormat = "json" | "text";

export const STAGE_FORMAT: Record<StageKind, StageFormat> = {
  plan: "json",
  answer: "text",
  critique: "json",
  rewrite: "text",
};

// ---------------------------------------------------------------------------
// LLM types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  data?: unknown;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Stage Result
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Run Record (observability)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** Cost per 1M input tokens in USD */
  inputPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputPer1M: number;
}

/** Default pricing table (approximate, config-overridable) */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "deepseek/deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek/deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  "qwen/qwen-2.5-72b-instruct": { inputPer1M: 0.36, outputPer1M: 0.36 },
  "anthropic/claude-3.5-haiku": { inputPer1M: 0.80, outputPer1M: 4.00 },
  "anthropic/claude-3.5-sonnet": { inputPer1M: 3.00, outputPer1M: 15.00 },
  "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60 },
  "openai/gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00 },
  "google/gemini-2.0-flash-001": { inputPer1M: 0.10, outputPer1M: 0.40 },
};

// ---------------------------------------------------------------------------
// Circuit Breaker Config
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /** Max failures before tripping the breaker */
  failureThreshold: number;
  /** Window in ms to count failures */
  windowMs: number;
  /** Cooldown in ms after tripping before retrying */
  cooldownMs: number;
}

// ---------------------------------------------------------------------------
// Miranda Config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default Models (matching VS Code Maestro settings)
// ---------------------------------------------------------------------------

export const DEFAULT_MODELS: Record<StageKind, ModelSpec[]> = {
  plan: [
    { id: "openai/gpt-4o-mini", label: "OpenAI: GPT-4o-mini (2024-07-18) $0.150/M" },
    { id: "qwen/qwen3-coder-next", label: "Qwen: Qwen3 Coder Next $0.120/M" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek: DeepSeek V3 0324 $0.200/M" },
  ],
  answer: [
    { id: "qwen/qwen3-coder-next", label: "Qwen: Qwen3 Coder Next $0.120/M" },
    { id: "openai/gpt-4o-mini", label: "OpenAI: GPT-4o-mini (2024-07-18) $0.150/M" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek: DeepSeek V3 0324 $0.200/M" },
  ],
  critique: [
    { id: "deepseek/deepseek-chat", label: "DeepSeek: DeepSeek V3 0324 $0.200/M" },
    { id: "openai/gpt-4o-mini", label: "OpenAI: GPT-4o-mini (2024-07-18) $0.150/M" },
  ],
  rewrite: [
    { id: "qwen/qwen2.5-7b-instruct", label: "Qwen: Qwen2.5 7B Instruct $0.040/M" },
    { id: "openai/gpt-4o-mini", label: "OpenAI: GPT-4o-mini (2024-07-18) $0.150/M" },
  ],
};

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

function defaultStageConfig(stage: StageKind): StageConfig {
  return {
    models: DEFAULT_MODELS[stage],
    maxRetriesPerModel: 3,
    maxTotalAttempts: 6,
    baseTemperature: 0.4,
    maxTokens: stage === "plan" || stage === "critique" ? 2048 : 4096,
    timeoutMs: 60_000,
  };
}

export function createDefaultConfig(overrides?: Partial<MirandaConfig>): MirandaConfig {
  const base: MirandaConfig = {
    stages: {
      plan: defaultStageConfig("plan"),
      answer: defaultStageConfig("answer"),
      critique: defaultStageConfig("critique"),
      rewrite: defaultStageConfig("rewrite"),
    },
    budgetUsd: 0.10,
    pricing: { ...DEFAULT_PRICING },
    circuitBreaker: {
      failureThreshold: 3,
      windowMs: 5 * 60 * 1000,
      cooldownMs: 2 * 60 * 1000,
    },
    logPath: "miranda-runs.jsonl",
    verbose: false,
  };

  if (overrides) {
    return { ...base, ...overrides };
  }
  return base;
}
