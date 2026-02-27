/**
 * Miranda Core — Public API
 * Barrel export for embedding in other applications.
 */

// Pipeline
export { runPipeline } from "./pipeline/mirandaPipeline.js";
export type { PipelineResult } from "./pipeline/mirandaPipeline.js";

// Types
export {
  STAGE_ORDER,
  STAGE_FORMAT,
  DEFAULT_PRICING,
  DEFAULT_MODELS,
  createDefaultConfig,
} from "./pipeline/types.js";

export type {
  StageKind,
  StageFormat,
  ModelSpec,
  LLMRequest,
  LLMMessage,
  LLMResponse,
  TokenUsage,
  ValidationResult,
  StageAttempt,
  StageResult,
  RunRecord,
  RunSummary,
  ModelPricing,
  CircuitBreakerConfig,
  StageConfig,
  MirandaConfig,
} from "./pipeline/types.js";

// Contracts
export { PlanSchema, PLAN_EXAMPLE, buildPlanSystemPrompt } from "./contracts/plan.js";
export type { PlanOutput } from "./contracts/plan.js";
export { CritiqueSchema, CRITIQUE_EXAMPLE, buildCritiqueSystemPrompt } from "./contracts/critique.js";
export type { CritiqueOutput } from "./contracts/critique.js";
export { ANSWER_REQUIRED_HEADINGS, buildAnswerSystemPrompt } from "./contracts/answer.js";
export { REWRITE_REQUIRED_HEADINGS, buildRewriteSystemPrompt } from "./contracts/rewrite.js";

// Validation
export { validateJson } from "./validate/validateJson.js";
export { validateTextSections } from "./validate/validateTextSections.js";

// Repair
export { buildRepairMessages, validateStageOutput, getRepairTemperature } from "./repair/repairEngine.js";
export { buildJsonRepairPrompt, buildTextRepairPrompt } from "./repair/repairPrompts.js";

// Routing
export { Router } from "./route/router.js";
export { CircuitBreaker } from "./route/circuitBreaker.js";
export { HealthTracker } from "./route/health.js";

// LLM
export type { LLMAdapter } from "./llm/adapter.js";
export { OpenRouterAdapter } from "./llm/openrouter.js";
export type { OpenRouterConfig } from "./llm/openrouter.js";

// Metrics
export { estimateTokens, resolveTokenUsage } from "./metrics/tokens.js";
export { calculateCost, formatCost } from "./metrics/costs.js";
export { appendRunLog, getRunSummary } from "./metrics/runStore.js";
