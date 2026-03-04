/**
 * Persistence port — everything orca-core needs to record a run.
 *
 * The concrete implementation (SQLite, Postgres, JSONL, …) lives in the
 * app shell and is injected via OrcaRuntimeDeps.store.
 * orca-core stays storage-agnostic.
 */

export interface PersistedRun {
  /** Stable run identifier — same as OrcaRunCtx.runId. */
  runId: string;
  /** Unix epoch ms at task start. */
  timestamp: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Final verdict — mirrors OrcaExecutionResult.status. */
  status: "SUCCESS" | "FAIL";
  /** Raw user message that triggered this run. */
  originalMessage: string;
  /** Parsed intent string. */
  intent: string;
  /** JSON-serialised goals array. */
  goals: string;
  /** User-facing reply text (may be undefined on FAIL). */
  outputText?: string;
  /** Internal QC summary. */
  summary?: string;
  /** How many subagents were spawned (0 = single-agent). */
  subagentCount: number;
  /** Total tool call events across all agents. */
  toolEventCount: number;
  /** Number of repair passes needed (0 = passed on first try). */
  repairPasses: number;
  /** Working directory captured at task start. */
  workspaceCwd?: string;
  /** Git branch at task start. */
  gitBranch?: string;
  /** Short git commit SHA at task start. */
  gitCommit?: string;
}

export interface RunStore {
  /** Persist a completed run record. Implementations should be synchronous-friendly. */
  saveRun(run: PersistedRun): void;
  /** Return the most-recent runs, newest first. */
  getRecentRuns(limit?: number): PersistedRun[];
  /** Graceful teardown (flush buffers, close handles, etc.). */
  close(): void;
}
