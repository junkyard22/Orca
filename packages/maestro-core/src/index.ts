/**
 * maestro-core — Public API
 *
 * The portable orchestration logic layer for Maestro.
 * Designed for integration into the Orca pod platform.
 *
 * No VS Code, Electron, or UI dependencies.
 * No global/window usage.
 * No direct model calls.
 * No direct filesystem access (git abstracted via GitRunner interface).
 *
 * Usage:
 *   import { createMaestroCore } from 'maestro-core';
 *
 *   const core = createMaestroCore({ logger: myLogger });
 *   const result = await core.run(task, context);
 */

// ── Core Factory & Class ─────────────────────────────────────────────────────
export { MaestroCore, createMaestroCore } from './core';
export type { MaestroCoreConfig, OrchestrationResult } from './core';

// ── Pod Member Interface (Orca Contract) ─────────────────────────────────────
export type { PodMember, Task, Context, Result, Logger, GitRunner, GitResult } from './interfaces';

// ── Orchestration Types ──────────────────────────────────────────────────────
export {
  TaskType,
  DoneStatus,
  CancelStatus,
  CancellationToken,
} from './types/orchestration';
export type {
  TaskClassification,
  RiskAssessment,
  PlanStep,
  StructuredPlan,
  PlanApprovalResult,
  DoneEvidence,
  DoneResult,
  NeedsVerificationResult,
  BlockedResult,
  CompletionResult,
  CancellationReceipt,
  RunContext,
  RunPhase,
  OrchestrationEvent,
  OrchestrationEventPayload,
} from './types/orchestration';

// ── Task Classification ──────────────────────────────────────────────────────
export { classifyTask } from './taskClassifier';

// ── Risk Scoring ─────────────────────────────────────────────────────────────
export { scoreRisk } from './riskScorer';

// ── Event Bus ────────────────────────────────────────────────────────────────
export { EventBus, getEventBus, resetEventBus } from './eventBus';

// ── Plan Gate ────────────────────────────────────────────────────────────────
export { PlanGate } from './planGate';

// ── Done Policy ──────────────────────────────────────────────────────────────
export { DonePolicy, createEmptyEvidence } from './donePolicy';
export type { ExecutionEvidence } from './donePolicy';

// ── Cancellation Manager ─────────────────────────────────────────────────────
export { CancellationManager } from './cancellationManager';

// ── Role Selector ────────────────────────────────────────────────────────────
export {
  selectRole,
  pickCoreRole,
  getAvailableOptionalRoles,
  isOptionalRole,
  getCoreRoles,
  getOptionalRoles,
  getAllRoles,
  OPTIONAL_ROLE_METADATA,
} from './roleSelector';
export type {
  CoreRoleName,
  OptionalRoleName,
  RoleName,
  RoleMetadata,
  TaskContext,
} from './roleSelector';

// ── Input Validation ─────────────────────────────────────────────────────────
export { InputValidator, ValidationError } from './validation';

// ── Provider Types & Constants ───────────────────────────────────────────────
export { DEFAULT_BASE_URLS, generateProviderId } from './providerTypes';
export type {
  ProviderType,
  ProviderConfig,
  RoleConfig,
  ResolvedProvider,
} from './providerTypes';

// ── Model Utilities ──────────────────────────────────────────────────────────
export {
  normalizeModelId,
  shouldAttachConfigSnapshot,
  formatEffectiveConfigForBrain,
} from './modelUtils';

// ── Subagent Types (Phase 2) ─────────────────────────────────────────────────
export type {
  SubAgent,
  SubAgentResult,
  SubAgentStatus,
  SubAgentSpawner,
} from './subagent';

// ── Role Prompts ─────────────────────────────────────────────────────────────
export { ROLE_PROMPTS, getRolePrompt } from './prompts/rolePrompts';

// ── Brain Decompose ───────────────────────────────────────────────────────────
export { BRAIN_DECOMPOSE_SYSTEM, parseBrainDecision, buildSynthesisPrompt, BrainDecisionValidationError, VALID_HEAD_NAMES } from './decompose';
export type { HeadName, DirectRouting, DepartmentTask, DecomposeRouting, DecomposeDecision } from './decompose';
export type {
  NormalizedModelId,
  RoleEffectiveConfig,
  ConfigMode,
  EffectiveConfig,
} from './modelUtils';

// ── Model Fallback Pools ─────────────────────────────────────────────────────
export {
  ModelFallbackPoolManager,
  createSimpleFallbackPool,
  createFallbackPoolFromRoleConfigs,
  mergeFallbackModels,
} from './modelFallbackPool';
export type {
  PoolModelEntry,
  RoleFallbackPool,
  FallbackPoolConfig,
  PoolModelState,
  PoolRuntimeState,
} from './modelFallbackPool';
