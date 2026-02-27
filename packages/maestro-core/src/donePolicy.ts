/**
 * DONE Policy — Validates whether an orchestration run can legitimately
 * claim DONE status.
 *
 * No direct dependencies on VS Code, Electron, or global singletons.
 * EventBus and Logger are injected at construction time.
 * Extracted from maestro-vscode/src/donePolicy.ts.
 */

import {
  StructuredPlan,
  DoneStatus,
  DoneEvidence,
  DoneResult,
  NeedsVerificationResult,
  BlockedResult,
  CompletionResult,
  CancellationToken,
} from './types/orchestration';
import { EventBus } from './eventBus';
import { Logger } from './interfaces';

// ============================================================================
// Execution Evidence (collected during a run)
// ============================================================================

export interface ExecutionEvidence {
  /** Files that were actually modified */
  files_modified: string[];
  /** Shell commands that were executed */
  commands_executed: string[];
  /** Exit codes of executed commands */
  exit_codes: number[];
  /** Free-form verification notes (test output, lint results, etc.) */
  verification: string[];
  /** Which plan steps (by step number) were completed */
  completed_steps: number[];
  /** Whether any role scope violations were detected */
  role_violations: string[];
  /** Whether the run was cancelled */
  cancelled: boolean;
}

/**
 * Create an empty evidence object (for pre-population).
 */
export function createEmptyEvidence(): ExecutionEvidence {
  return {
    files_modified: [],
    commands_executed: [],
    exit_codes: [],
    verification: [],
    completed_steps: [],
    role_violations: [],
    cancelled: false,
  };
}

// ============================================================================
// DONE Policy
// ============================================================================

export class DonePolicy {
  constructor(
    private eventBus: EventBus,
    private logger?: Logger,
  ) {}

  /**
   * Validate completion of a run.
   */
  validate(
    plan: StructuredPlan | null,
    evidence: ExecutionEvidence,
    runId: string,
    token?: CancellationToken,
  ): CompletionResult {
    // ── Hard block: cancellation ──────────────────────────────────────────
    if (token?.isCancelled || evidence.cancelled) {
      this.logger?.warn('[DonePolicy] Cannot return DONE after cancellation');
      const result: BlockedResult = {
        status: DoneStatus.BLOCKED,
        needs: ['Run was cancelled — DONE is not a valid terminal state after cancellation.'],
      };
      this.eventBus.emit('task:blocked', { run_id: runId, result });
      return result;
    }

    // ── Check role scope violations ──────────────────────────────────────
    if (evidence.role_violations.length > 0) {
      const result: BlockedResult = {
        status: DoneStatus.BLOCKED,
        needs: evidence.role_violations.map(v => `Role violation: ${v}`),
      };
      this.eventBus.emit('task:blocked', { run_id: runId, result });
      return result;
    }

    // ── If a plan exists, check all steps completed ─────────────────────
    if (plan) {
      const expectedSteps = plan.plan_steps.map(s => s.step);
      const missing = expectedSteps.filter(s => !evidence.completed_steps.includes(s));

      if (missing.length > 0) {
        const result: BlockedResult = {
          status: DoneStatus.BLOCKED,
          needs: missing.map(s => {
            const stepDef = plan.plan_steps.find(ps => ps.step === s);
            return `Incomplete step ${s}: ${stepDef?.description ?? 'unknown'}`;
          }),
        };
        this.eventBus.emit('task:blocked', { run_id: runId, result });
        return result;
      }
    }

    // ── Verification evidence required for code changes ──────────────────
    if (evidence.files_modified.length > 0) {
      const hasVerification =
        evidence.verification.length > 0 ||
        evidence.commands_executed.some(cmd =>
          /\b(test|build|lint|tsc|typecheck|jest|mocha|vitest|pytest)\b/i.test(cmd)
        );

      if (!hasVerification) {
        const result: NeedsVerificationResult = {
          status: DoneStatus.NEEDS_VERIFICATION,
          reason: 'Code changes detected but no verification evidence (test/build/lint). Run at least one verification step.',
          evidence: {
            files_modified: evidence.files_modified,
            commands_executed: evidence.commands_executed,
            exit_codes: evidence.exit_codes,
          },
        };
        this.eventBus.emit('task:needs_verification', { run_id: runId, result });
        return result;
      }
    }

    // ── Cosmetic-only detection (rename without functional change) ───────
    if (evidence.files_modified.length === 0 && plan && plan.plan_steps.length > 0) {
      const result: NeedsVerificationResult = {
        status: DoneStatus.NEEDS_VERIFICATION,
        reason: 'Plan steps marked complete but no files were modified. Possible cosmetic-only completion.',
        evidence: {
          files_modified: [],
          commands_executed: evidence.commands_executed,
        },
      };
      this.eventBus.emit('task:needs_verification', { run_id: runId, result });
      return result;
    }

    // ── All checks passed → DONE ────────────────────────────────────────
    const doneEvidence: DoneEvidence = {
      files_modified: evidence.files_modified,
      commands_executed: evidence.commands_executed,
      exit_codes: evidence.exit_codes,
      verification: evidence.verification,
    };

    const result: DoneResult = {
      status: DoneStatus.DONE,
      evidence: doneEvidence,
    };

    this.eventBus.emit('task:done', { run_id: runId, result });
    return result;
  }
}
