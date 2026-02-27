/**
 * Maestro Core — Main entry point for Orca pod integration.
 *
 * Exports:
 *   - MaestroCore class (implements PodMember)
 *   - createMaestroCore factory function
 *
 * Dependencies are injected — no VS Code, Electron, or global side-effects.
 */

import { Logger, GitRunner, Task, Context, Result, PodMember } from './interfaces';
import { EventBus } from './eventBus';
import { PlanGate } from './planGate';
import { DonePolicy, createEmptyEvidence, ExecutionEvidence } from './donePolicy';
import { CancellationManager } from './cancellationManager';
import { classifyTask } from './taskClassifier';
import { scoreRisk } from './riskScorer';
import {
  TaskClassification,
  RiskAssessment,
  RunContext,
  CancellationReceipt,
} from './types/orchestration';

// ============================================================================
// Dependency Configuration
// ============================================================================

export interface MaestroCoreConfig {
  /** Logger implementation (e.g., VS Code Output channel logger). */
  logger?: Logger;
  /** Git runner for checkpoint/rollback (e.g., child_process.spawn wrapper). */
  gitRunner?: GitRunner;
}

// ============================================================================
// Orchestration Result
// ============================================================================

export interface OrchestrationResult {
  run_id: string;
  classification: TaskClassification;
  risk: RiskAssessment;
  gated: boolean;
}

// ============================================================================
// MaestroCore
// ============================================================================

/**
 * MaestroCore — The portable logic pod for the Maestro orchestration system.
 *
 * Implements the Orca PodMember interface, allowing it to be registered in
 * the Orca platform as a first-class pod member.
 *
 * Capabilities:
 *   - task:classify      Task classification (SMALL_EDIT, FEATURE, REFACTOR, …)
 *   - task:score-risk    Risk scoring and plan-gate determination
 *   - orchestration:plan Plan-gate workflow (generate + approve plans)
 *   - orchestration:done DONE policy validation
 *   - orchestration:cancel Cancellation with optional git rollback
 */
export class MaestroCore implements PodMember {
  readonly id = 'maestro-core';
  readonly name = 'Maestro Core';
  readonly capabilities = [
    'task:classify',
    'task:score-risk',
    'orchestration:plan',
    'orchestration:done',
    'orchestration:cancel',
  ];

  private logger?: Logger;
  private eventBus: EventBus;
  private planGate: PlanGate;
  private donePolicy: DonePolicy;
  private cancellationManager: CancellationManager;

  constructor(config: MaestroCoreConfig = {}) {
    this.logger = config.logger;
    this.eventBus = new EventBus(config.logger);
    this.planGate = new PlanGate(this.eventBus, config.logger);
    this.donePolicy = new DonePolicy(this.eventBus, config.logger);
    this.cancellationManager = new CancellationManager(
      this.eventBus,
      config.logger,
      config.gitRunner,
    );
  }

  // ── PodMember contract ───────────────────────────────────────────────────

  canHandle(_task: Task): boolean {
    // MaestroCore handles all tasks — it is the general orchestration layer.
    return true;
  }

  async run(task: Task, context: Context): Promise<Result> {
    const classification = classifyTask(task.description);
    const risk = scoreRisk(classification);
    const runCtx = this.cancellationManager.createRun();

    this.logger?.info(
      `[MaestroCore] run_id=${runCtx.run_id} | type=${classification.type} | risk=${risk.riskScore.toFixed(2)} | requiresPlan=${risk.requiresPlan}`
    );

    return {
      success: true,
      output: task.description,
      metadata: {
        run_id: runCtx.run_id,
        classification,
        risk,
        gated: risk.requiresPlan,
        workspaceRoot: context.workspaceRoot,
      },
    };
  }

  // ── Orchestration helpers (for app layer integration) ────────────────────

  /**
   * Pre-execution orchestration: classify → score risk → check plan gate.
   * Returns orchestration metadata that the app layer can attach to results.
   */
  orchestrate(task: string): OrchestrationResult {
    const runCtx = this.cancellationManager.createRun();
    const classification = classifyTask(task);
    const risk = scoreRisk(classification);
    const gated = this.planGate.checkGate(risk);

    if (gated) {
      this.logger?.info(`[MaestroCore] Plan gate ACTIVE for run ${runCtx.run_id}`);
    }

    return { run_id: runCtx.run_id, classification, risk, gated };
  }

  /**
   * Generate a plan prompt for high-risk tasks.
   */
  generatePlanPrompt(task: string): string {
    return this.planGate.generatePlanPrompt(task);
  }

  /**
   * Parse a Brain response into a structured plan.
   */
  parsePlan(brainResponse: string) {
    return this.planGate.parsePlan(brainResponse);
  }

  /**
   * Cancel an active run.
   */
  async cancelRun(runId: string): Promise<CancellationReceipt> {
    return this.cancellationManager.cancelRun(runId);
  }

  /**
   * Get the underlying EventBus (for subscribing to orchestration events).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get the PlanGate instance (for advanced plan workflows).
   */
  getPlanGate(): PlanGate {
    return this.planGate;
  }

  /**
   * Get the DonePolicy instance (for completion validation).
   */
  getDonePolicy(): DonePolicy {
    return this.donePolicy;
  }

  /**
   * Get the CancellationManager (for run lifecycle management).
   */
  getCancellationManager(): CancellationManager {
    return this.cancellationManager;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Factory function to create a MaestroCore instance with injected dependencies.
 *
 * @example
 * const core = createMaestroCore({ logger: myLogger, gitRunner: myGitRunner });
 * core.getEventBus().on('task:done', payload => console.log('Done!', payload));
 *
 * const { run_id, classification, risk } = core.orchestrate('refactor the auth module');
 */
export function createMaestroCore(config: MaestroCoreConfig = {}): MaestroCore {
  return new MaestroCore(config);
}
