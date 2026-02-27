/**
 * Cancellation Manager — First-class cancellation control plane.
 *
 * No direct dependencies on VS Code, Electron, child_process, or fs.
 * Git operations are abstracted via the GitRunner interface.
 * EventBus and Logger are injected at construction time.
 * Extracted from maestro-vscode/src/cancellationManager.ts.
 */

import {
  CancellationToken,
  CancelStatus,
  CancellationReceipt,
  RunContext,
  RunPhase,
} from './types/orchestration';
import { EventBus } from './eventBus';
import { Logger, GitRunner } from './interfaces';

// ============================================================================
// Helpers
// ============================================================================

function generateRunId(): string {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

// ============================================================================
// Cancellation Manager
// ============================================================================

export class CancellationManager {
  /** Active runs keyed by run_id */
  private runs: Map<string, RunContext> = new Map();

  /** Checkpoint metadata keyed by run_id */
  private checkpoints: Map<string, { method: 'git-stash' | 'branch' | 'none'; workspaceRoot: string }> = new Map();

  constructor(
    private eventBus: EventBus,
    private logger?: Logger,
    private gitRunner?: GitRunner,
  ) {}

  /**
   * Create a new orchestration run.
   */
  createRun(): RunContext {
    const run_id = generateRunId();
    const token = new CancellationToken();
    const ctx: RunContext = {
      run_id,
      cancellationToken: token,
      phase: 'PLAN',
      mutations: {
        files_modified: [],
        patches_applied: [],
        commands_started: [],
      },
    };
    this.runs.set(run_id, ctx);

    this.eventBus.emit('run:started', { run_id });
    this.logger?.info(`[CancellationManager] Run created: ${run_id}`);
    return ctx;
  }

  /**
   * Get an existing run context (or undefined).
   */
  getRun(runId: string): RunContext | undefined {
    return this.runs.get(runId);
  }

  /**
   * Create a safety checkpoint before mutations begin.
   *
   * Preferred: git stash (requires GitRunner)
   * Fallback: none (patch-artifact mode)
   */
  async createCheckpoint(runId: string, workspaceRoot: string): Promise<{ method: 'git-stash' | 'branch' | 'none' }> {
    if (this.gitRunner && this.gitRunner.isRepo(workspaceRoot)) {
      const stashMsg = `maestro-checkpoint:${runId}`;
      const result = await this.gitRunner.run(workspaceRoot, ['stash', 'push', '-u', '-m', stashMsg]);

      if (result.code === 0) {
        const method = 'git-stash' as const;
        this.checkpoints.set(runId, { method, workspaceRoot });
        this.eventBus.emit('checkpoint:created', { run_id: runId, method });
        this.logger?.info(`[CancellationManager] Checkpoint created (git stash): ${runId}`);
        return { method };
      } else {
        this.logger?.warn(`[CancellationManager] git stash failed: ${result.stderr}`);
      }
    }

    this.checkpoints.set(runId, { method: 'none', workspaceRoot });
    this.eventBus.emit('checkpoint:created', { run_id: runId, method: 'none' });
    this.logger?.info(`[CancellationManager] No git — using patch-artifact mode for ${runId}`);
    return { method: 'none' };
  }

  /**
   * Attempt rollback for a cancelled run.
   */
  async rollback(runId: string): Promise<{ result: 'OK' | 'FAILED' | 'NOT_NEEDED'; details: string }> {
    const checkpoint = this.checkpoints.get(runId);
    const ctx = this.runs.get(runId);

    if (!ctx || ctx.mutations.files_modified.length === 0) {
      return { result: 'NOT_NEEDED', details: 'No file mutations occurred.' };
    }

    if (!checkpoint || checkpoint.method === 'none' || !this.gitRunner) {
      return {
        result: 'FAILED',
        details: `No git checkpoint. Manual undo required. Modified files: ${ctx.mutations.files_modified.join(', ')}`,
      };
    }

    this.eventBus.emit('checkpoint:rollback_started', { run_id: runId });
    const cwd = checkpoint.workspaceRoot;

    try {
      const resetResult = await this.gitRunner.run(cwd, ['reset', '--hard']);
      if (resetResult.code !== 0) {
        this.eventBus.emit('checkpoint:rollback_completed', { run_id: runId, success: false });
        return { result: 'FAILED', details: `git reset --hard failed: ${resetResult.stderr}` };
      }

      const cleanResult = await this.gitRunner.run(cwd, ['clean', '-fd']);
      if (cleanResult.code !== 0) {
        this.logger?.warn(`[CancellationManager] git clean -fd failed: ${cleanResult.stderr}`);
      }

      const stashListResult = await this.gitRunner.run(cwd, ['stash', 'list']);
      const stashMsg = `maestro-checkpoint:${runId}`;
      const stashLines = stashListResult.stdout.split('\n');
      const matchLine = stashLines.find(l => l.includes(stashMsg));

      if (matchLine) {
        const stashRefMatch = matchLine.match(/^(stash@\{\d+\})/);
        if (stashRefMatch) {
          const popResult = await this.gitRunner.run(cwd, ['stash', 'pop', stashRefMatch[1]]);
          if (popResult.code !== 0) {
            this.logger?.warn(`[CancellationManager] git stash pop failed: ${popResult.stderr}`);
          }
        }
      }

      this.eventBus.emit('checkpoint:rollback_completed', { run_id: runId, success: true });
      this.logger?.info(`[CancellationManager] Rollback succeeded for ${runId}`);
      return { result: 'OK', details: 'Working tree restored to pre-run state via git reset + stash restore.' };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.eventBus.emit('checkpoint:rollback_completed', { run_id: runId, success: false });
      return { result: 'FAILED', details: `Rollback error: ${msg}` };
    }
  }

  /**
   * Cancel a run.
   */
  async cancelRun(runId: string): Promise<CancellationReceipt> {
    const ctx = this.runs.get(runId);

    if (!ctx) {
      return {
        status: CancelStatus.CANCELLED_SAFE,
        run_id: runId,
        phase: 'PLAN',
        in_progress: [],
        mutations: { files_modified: [], patches_applied: [], commands_started: [] },
        rollback: { attempted: false, result: 'NOT_NEEDED', details: 'Run not found.' },
        next_steps: [],
      };
    }

    ctx.cancellationToken.cancel();
    this.eventBus.emit('run:cancel_requested', { run_id: runId });
    this.eventBus.emit('run:cancel_acknowledged', { run_id: runId });

    const hasMutations = ctx.mutations.files_modified.length > 0;

    let rollbackInfo: CancellationReceipt['rollback'];
    let status: CancelStatus;

    if (!hasMutations) {
      status = CancelStatus.CANCELLED_SAFE;
      rollbackInfo = { attempted: false, result: 'NOT_NEEDED', details: 'No mutations occurred.' };
    } else {
      const rb = await this.rollback(runId);
      rollbackInfo = {
        attempted: true,
        result: rb.result,
        details: rb.details,
      };

      if (rb.result === 'OK') {
        status = CancelStatus.CANCELLED_ROLLBACK_OK;
      } else if (rb.result === 'NOT_NEEDED') {
        status = CancelStatus.CANCELLED_SAFE;
      } else {
        const checkpoint = this.checkpoints.get(runId);
        if (checkpoint && checkpoint.method === 'none') {
          status = CancelStatus.CANCELLED_PARTIAL;
        } else {
          status = CancelStatus.CANCELLED_ROLLBACK_FAILED;
        }
      }
    }

    const nextSteps: string[] = [];
    if (status === CancelStatus.CANCELLED_PARTIAL) {
      nextSteps.push(`Manual undo required for files: ${ctx.mutations.files_modified.join(', ')}`);
    } else if (status === CancelStatus.CANCELLED_ROLLBACK_FAILED) {
      nextSteps.push('Rollback failed. Inspect working tree and restore manually.');
      nextSteps.push(`Affected files: ${ctx.mutations.files_modified.join(', ')}`);
    }

    const receipt: CancellationReceipt = {
      status,
      run_id: runId,
      phase: ctx.phase,
      in_progress: [],
      mutations: { ...ctx.mutations },
      rollback: rollbackInfo,
      next_steps: nextSteps,
    };

    this.eventBus.emit('run:cancel_completed', { run_id: runId, receipt });
    this.logger?.info(`[CancellationManager] Run ${runId} cancelled with status: ${status}`);

    this.runs.delete(runId);
    this.checkpoints.delete(runId);

    return receipt;
  }

  /**
   * Mark a run as complete and clean up.
   */
  completeRun(runId: string): void {
    this.runs.delete(runId);
    this.checkpoints.delete(runId);
    this.logger?.info(`[CancellationManager] Run ${runId} completed and cleaned up`);
  }

  /**
   * Record a file mutation for the active run.
   */
  recordMutation(runId: string, filePath: string): void {
    const ctx = this.runs.get(runId);
    if (ctx && !ctx.mutations.files_modified.includes(filePath)) {
      ctx.mutations.files_modified.push(filePath);
    }
  }

  /**
   * Record a command execution for the active run.
   */
  recordCommand(runId: string, command: string): void {
    const ctx = this.runs.get(runId);
    if (ctx) {
      ctx.mutations.commands_started.push(command);
    }
  }

  /**
   * Update the current phase of a run.
   */
  setPhase(runId: string, phase: RunPhase): void {
    const ctx = this.runs.get(runId);
    if (ctx) {
      ctx.phase = phase;
    }
  }
}
