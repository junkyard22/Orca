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

// Live LLM contracts. Same names and shapes as before, sourced from the module
// that owns them rather than through the frozen pipeline's re-export.
export type {
  ModelSpec,
  LLMRequest,
  LLMMessage,
  LLMResponse,
  TokenUsage,
} from "./llm/types.js";

export type {
  StageKind,
  StageFormat,
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

// Gate (Miranda's 6-checkpoint validation layer)
export {
  createMirandaGate,
  classifyToolPermissionRequirement,
  composeMirandaGates,
  transitionAHPLifecycle,
} from "./gate/mirandaGate.js";
export type {
  MirandaGate,
  MirandaGateConfig,
  GateVerdict,
  GateResult,
  GateName,
  ProtectedPathMaintenanceMode,
  ProtectedPathPolicyConfig,
  LLMCallGateContext,
  ToolGateContext,
  QCGateContext,
  TaskToolPermissions,
  ToolPermissionRequirement,
} from "./gate/mirandaGate.js";

// AHP — Agent Handoff Protocol types
export { AHPLifecycle, AHPVerdict, AHPPacketRole } from "./ahp/types.js";
export type {
  AHPInput,
  AHPConstraint,
  AHPExpectedOutput,
  AHPTraceEntry,
  AHPMeta,
  AHPEvalMeta,
  AHPPacket,
} from "./ahp/types.js";
// AHP helpers — packet mutation utilities
export {
  appendAHPTrace,
  isTerminalAHPLifecycle,
  createRootPacket,
  createChildPacket,
  registerChildOnRoot,
  deriveRootLifecycleFromChildren,
} from "./ahp/helpers.js";
export type { CreatePacketOptions } from "./ahp/helpers.js";
export { OpenRouterAdapter } from "./llm/openrouter.js";
export type { OpenRouterConfig } from "./llm/openrouter.js";
export { OllamaAdapter } from "./llm/ollama.js";
export type { OllamaConfig } from "./llm/ollama.js";
export { OpenAICompatAdapter } from "./llm/openaiCompat.js";
export type { OpenAICompatConfig } from "./llm/openaiCompat.js";
export { STREAM_USAGE_OPTIONS, toTokenUsage } from "./llm/usage.js";
export type { OpenAIUsagePayload } from "./llm/usage.js";

// Metrics
export { estimateTokens, resolveTokenUsage } from "./metrics/tokens.js";
export { calculateCost, formatCost } from "./metrics/costs.js";
export { appendRunLog, getRunSummary } from "./metrics/runStore.js";
