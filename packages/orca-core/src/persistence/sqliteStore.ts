/**
 * SQLite implementation of the RunStore interface.
 * 
 * Uses better-sqlite3 for synchronous operations (by design).
 * All operations are atomic via transactions.
 */

import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import type { PersistedRun, RunStore } from "./types.js";

/**
 * SqliteStore - SQLite-backed implementation of RunStore.
 * 
 * Constructor takes a dbPath and automatically runs migrations on startup.
 * Default path: ~/.orca/runs.db (fallback) or app.getPath('userData')/orca-runs.db (Electron)
 */
export class SqliteStore implements RunStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");
    // Run migrations to set up schema
    runMigrations(this.db);
  }

  /**
   * Persist a completed run record with all related data.
   * Uses a transaction to ensure atomicity.
   */
  saveRun(run: PersistedRun): void {
    const insertRun = this.db.prepare(`
      INSERT INTO runs (
        id, created_at, intent, status, output_text, summary,
        subagent_count, tool_event_count, repair_passes,
        workspace_cwd, git_branch, git_commit, timestamp, duration_ms
      ) VALUES (
        @runId, @createdAt, @intent, @status, @outputText, @summary,
        @subagentCount, @toolEventCount, @repairPasses,
        @workspaceCwd, @gitBranch, @gitCommit, @timestamp, @durationMs
      )
    `);

    const transaction = this.db.transaction(() => {
      // Insert the main run record
      insertRun.run({
        runId: run.runId,
        createdAt: new Date(run.timestamp).toISOString(),
        intent: run.intent,
        status: run.status,
        outputText: run.outputText ?? null,
        summary: run.summary ?? null,
        subagentCount: run.subagentCount,
        toolEventCount: run.toolEventCount,
        repairPasses: run.repairPasses,
        workspaceCwd: run.workspaceCwd ?? null,
        gitBranch: run.gitBranch ?? null,
        gitCommit: run.gitCommit ?? null,
        timestamp: run.timestamp,
        durationMs: run.durationMs,
      });
    });

    transaction();
  }

  /**
   * Return the most-recent runs, newest first.
   * Defaults to last 50 runs if no limit specified.
   */
  getRecentRuns(limit: number = 50): PersistedRun[] {
    const stmt = this.db.prepare(`
      SELECT 
        id as runId,
        created_at as createdAt,
        intent,
        status,
        output_text as outputText,
        summary,
        subagent_count as subagentCount,
        tool_event_count as toolEventCount,
        repair_passes as repairPasses,
        workspace_cwd as workspaceCwd,
        git_branch as gitBranch,
        git_commit as gitCommit,
        timestamp,
        duration_ms as durationMs
      FROM runs
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as Array<{
      runId: string;
      createdAt: string;
      intent: string;
      status: "SUCCESS" | "FAIL";
      outputText?: string;
      summary?: string;
      subagentCount: number;
      toolEventCount: number;
      repairPasses: number;
      workspaceCwd?: string;
      gitBranch?: string;
      gitCommit?: string;
      timestamp: number;
      durationMs: number;
    }>;

    return rows.map((row) => ({
      runId: row.runId,
      timestamp: row.timestamp,
      durationMs: row.durationMs,
      status: row.status,
      originalMessage: "", // Not stored in new schema
      intent: row.intent,
      goals: "[]", // Not stored in new schema
      outputText: row.outputText,
      summary: row.summary,
      subagentCount: row.subagentCount,
      toolEventCount: row.toolEventCount,
      repairPasses: row.repairPasses,
      workspaceCwd: row.workspaceCwd,
      gitBranch: row.gitBranch,
      gitCommit: row.gitCommit,
    }));
  }

  /**
   * Graceful teardown - close database connection.
   */
  close(): void {
    this.db.close();
  }
}