/**
 * Persistence types — everything orca-core needs to record a run.
 *
 * The concrete implementation (SQLite, Postgres, JSONL, …) lives in the
 * app shell and is injected via OrcaRuntimeDeps.store.
 * orca-core stays storage-agnostic.
 */

export interface RunRecord {
  id: string;
  createdAt: string;
  intent: string;
  role?: string;
  status: 'SUCCESS' | 'FAIL';
  stoppedBecause?: 'done' | 'max_iterations' | 'loop_detected' | 'error';
  iterationCount?: number;
  outputText?: string;
  summary?: string;
  verdict?: 'PASS' | 'WARN' | 'FAIL';
  confidence?: number;
  issueCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  repairPasses?: number;
}

export interface ThoughtRecord {
  runId: string;
  iteration: number;
  thought?: string;
  observation?: string;
  next?: string;
}

export interface ToolEvent {
  runId: string;
  tool: string;
  ok: boolean;
  summary?: string;
  iteration?: number;
}

export interface FileChange {
  runId: string;
  path: string;
  changeType: string;
}

export interface OrcaStore {
  saveRun(
    run: RunRecord,
    thoughts: ThoughtRecord[],
    toolEvents: ToolEvent[],
    filesChanged: FileChange[]
  ): void | Promise<void>;
  getRecentRuns(limit?: number): RunRecord[] | Promise<RunRecord[]>;
  getRun(id: string): RunRecord | null | Promise<RunRecord | null>;
  getRunThoughts(runId: string): ThoughtRecord[] | Promise<ThoughtRecord[]>;
  getRunToolEvents(runId: string): ToolEvent[] | Promise<ToolEvent[]>;
  searchRuns(query: string, limit?: number): RunRecord[] | Promise<RunRecord[]>;
  getStats(): {
    totalRuns: number;
    passRate: number;
    avgIterations: number;
    totalCostUsd: number;
  } | Promise<{
    totalRuns: number;
    passRate: number;
    avgIterations: number;
    totalCostUsd: number;
  }>;
  close(): void;
}
