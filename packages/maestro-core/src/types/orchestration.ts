/**
 * Orchestration Types — Shared interfaces for the Smart Confirmation,
 * Risk-Based Plan Gate, Strict DONE Policy, and Cancellation system.
 *
 * This file is pure TypeScript — no external dependencies.
 * Extracted from maestro-vscode/src/types/orchestration.ts.
 */

// ============================================================================
// Task Classification
// ============================================================================

export enum TaskType {
  SMALL_EDIT = "SMALL_EDIT",
  FEATURE = "FEATURE",
  REFACTOR = "REFACTOR",
  PACKAGING = "PACKAGING",
  INFRASTRUCTURE = "INFRASTRUCTURE",
  UNKNOWN = "UNKNOWN",
}

export interface TaskClassification {
  type: TaskType;
  /** 0–1 estimated breadth of impact */
  estimatedImpact: number;
  /** Whether the request contains multiple distinct instructions */
  multiStep: boolean;
}

// ============================================================================
// Risk Scoring
// ============================================================================

export interface RiskAssessment {
  /** 0–1 composite risk score */
  riskScore: number;
  /** Whether a structured plan must be approved before execution */
  requiresPlan: boolean;
}

// ============================================================================
// Plan Gate
// ============================================================================

export interface PlanStep {
  step: number;
  description: string;
  acceptance_criteria: string[];
}

export interface StructuredPlan {
  restatement: string;
  non_goals: string[];
  assumptions: string[];
  ambiguities: string[];
  affected_components: string[];
  plan_steps: PlanStep[];
  definition_of_done: string[];
}

export type PlanApprovalResult =
  | "approved"
  | "modified"
  | "rejected"
  | "clarification_needed";

// ============================================================================
// DONE Policy
// ============================================================================

export enum DoneStatus {
  DONE = "DONE",
  NEEDS_VERIFICATION = "NEEDS_VERIFICATION",
  BLOCKED = "BLOCKED",
}

export interface DoneEvidence {
  files_modified: string[];
  commands_executed: string[];
  exit_codes: number[];
  verification: string[];
}

export interface DoneResult {
  status: DoneStatus.DONE;
  evidence: DoneEvidence;
}

export interface NeedsVerificationResult {
  status: DoneStatus.NEEDS_VERIFICATION;
  reason: string;
  evidence: Partial<DoneEvidence>;
}

export interface BlockedResult {
  status: DoneStatus.BLOCKED;
  needs: string[];
}

export type CompletionResult =
  | DoneResult
  | NeedsVerificationResult
  | BlockedResult;

// ============================================================================
// Cancellation
// ============================================================================

export enum CancelStatus {
  /** No repo mutations occurred OR changes were never applied */
  CANCELLED_SAFE = "CANCELLED_SAFE",
  /** Some mutations occurred and rollback was NOT performed */
  CANCELLED_PARTIAL = "CANCELLED_PARTIAL",
  /** Mutations occurred but were fully reverted */
  CANCELLED_ROLLBACK_OK = "CANCELLED_ROLLBACK_OK",
  /** Rollback attempted but failed */
  CANCELLED_ROLLBACK_FAILED = "CANCELLED_ROLLBACK_FAILED",
}

export type RunPhase = "PLAN" | "EXECUTE" | "VERIFY";

export interface CancellationReceipt {
  status: CancelStatus;
  run_id: string;
  phase: RunPhase;
  in_progress: string[];
  mutations: {
    files_modified: string[];
    patches_applied: string[];
    commands_started: string[];
  };
  rollback: {
    attempted: boolean;
    result: "OK" | "FAILED" | "NOT_NEEDED";
    details: string;
  };
  next_steps: string[];
}

/**
 * Cooperative cancellation token. Shared across all roles and subagents
 * within a single orchestration run.
 */
export class CancellationToken {
  private _cancelled = false;

  get isCancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
  }
}

export interface RunContext {
  run_id: string;
  cancellationToken: CancellationToken;
  phase: RunPhase;
  mutations: {
    files_modified: string[];
    patches_applied: string[];
    commands_started: string[];
  };
}

// ============================================================================
// EventBus Event Names
// ============================================================================

export type OrchestrationEvent =
  | "plan:generated"
  | "plan:approved"
  | "plan:rejected"
  | "task:blocked"
  | "task:done"
  | "task:needs_verification"
  | "run:started"
  | "run:cancel_requested"
  | "run:cancel_acknowledged"
  | "run:cancel_completed"
  | "checkpoint:created"
  | "checkpoint:rollback_started"
  | "checkpoint:rollback_completed"
  | "tool:terminated"
  | "subagent:spawned"
  | "subagent:done"
  | "subagent:failed";

export interface OrchestrationEventPayload {
  run_id: string;
  [key: string]: unknown;
}
