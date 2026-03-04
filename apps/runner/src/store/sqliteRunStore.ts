/**
 * SQLite-backed RunStore — the production persistence implementation.
 *
 * Uses better-sqlite3 (synchronous, zero-infra, perfect for a desktop agent).
 * The DB file lives at ~/.orca/runs.db by default; override with ORCA_DB_PATH.
 *
 * Injected into createOrcaRuntime() via OrcaRuntimeDeps.store.
 */

import Database from "better-sqlite3";
import type { Database as BetterDB } from "better-sqlite3";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { PersistedRun, RunStore } from "@clawde/orca-core";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT    PRIMARY KEY,
  timestamp         INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL,
  original_message  TEXT    NOT NULL,
  intent            TEXT    NOT NULL,
  goals             TEXT    NOT NULL DEFAULT '[]',
  output_text       TEXT,
  summary           TEXT,
  subagent_count    INTEGER NOT NULL DEFAULT 0,
  tool_event_count  INTEGER NOT NULL DEFAULT 0,
  repair_passes     INTEGER NOT NULL DEFAULT 0,
  workspace_cwd     TEXT,
  git_branch        TEXT,
  git_commit        TEXT
)`;

const UPSERT_RUN = `
INSERT OR REPLACE INTO runs (
  run_id, timestamp, duration_ms, status,
  original_message, intent, goals, output_text, summary,
  subagent_count, tool_event_count, repair_passes,
  workspace_cwd, git_branch, git_commit
) VALUES (
  @runId, @timestamp, @durationMs, @status,
  @originalMessage, @intent, @goals, @outputText, @summary,
  @subagentCount, @toolEventCount, @repairPasses,
  @workspaceCwd, @gitBranch, @gitCommit
)`;

const SELECT_RECENT = `
SELECT * FROM runs ORDER BY timestamp DESC LIMIT ?
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSqliteRunStore(
  dbPath: string = process.env["ORCA_DB_PATH"]?.trim() ??
    path.join(os.homedir(), ".orca", "runs.db"),
): RunStore {
  // Ensure the directory exists (e.g. ~/.orca/)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db: BetterDB = new Database(dbPath);

  // WAL mode: faster writes, no reader/writer contention with the desktop UI
  db.pragma("journal_mode = WAL");

  db.prepare(CREATE_RUNS_TABLE).run();

  const upsert = db.prepare(UPSERT_RUN);
  const selectRecent = db.prepare(SELECT_RECENT);

  return {
    saveRun(run: PersistedRun): void {
      upsert.run({
        runId:           run.runId,
        timestamp:       run.timestamp,
        durationMs:      run.durationMs,
        status:          run.status,
        originalMessage: run.originalMessage,
        intent:          run.intent,
        goals:           run.goals,
        outputText:      run.outputText   ?? null,
        summary:         run.summary      ?? null,
        subagentCount:   run.subagentCount,
        toolEventCount:  run.toolEventCount,
        repairPasses:    run.repairPasses,
        workspaceCwd:    run.workspaceCwd  ?? null,
        gitBranch:       run.gitBranch    ?? null,
        gitCommit:       run.gitCommit    ?? null,
      });
    },

    getRecentRuns(limit = 20): PersistedRun[] {
      const rows = selectRecent.all(limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        runId:           row["run_id"]           as string,
        timestamp:       row["timestamp"]        as number,
        durationMs:      row["duration_ms"]      as number,
        status:          row["status"]           as "SUCCESS" | "FAIL",
        originalMessage: row["original_message"] as string,
        intent:          row["intent"]           as string,
        goals:           row["goals"]            as string,
        outputText:      row["output_text"]      as string | undefined,
        summary:         row["summary"]          as string | undefined,
        subagentCount:   row["subagent_count"]   as number,
        toolEventCount:  row["tool_event_count"] as number,
        repairPasses:    row["repair_passes"]    as number,
        workspaceCwd:    row["workspace_cwd"]    as string | undefined,
        gitBranch:       row["git_branch"]       as string | undefined,
        gitCommit:       row["git_commit"]       as string | undefined,
      }));
    },

    close(): void {
      db.close();
    },
  };
}
