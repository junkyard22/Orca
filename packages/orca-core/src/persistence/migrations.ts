/**
 * SQLite schema migrations for orca-core persistence.
 * 
 * This module defines the database schema and runs migrations on startup.
 * All tables use TEXT for dates to maintain ISO 8601 format compatibility.
 */

import Database from "better-sqlite3";

/**
 * Run all migrations to set up the database schema.
 * This is called automatically by SqliteStore on construction.
 */
export function runMigrations(db: Database.Database): void {
  // Create runs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      intent TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL,
      stopped_because TEXT,
      iteration_count INTEGER,
      output_text TEXT,
      summary TEXT,
      verdict TEXT,
      confidence REAL,
      issue_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL
    );
  `);

  // Create thoughts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      iteration INTEGER NOT NULL,
      thought TEXT,
      observation TEXT,
      next TEXT
    );
  `);

  // Create tool_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      tool TEXT NOT NULL,
      ok INTEGER NOT NULL,
      summary TEXT,
      iteration INTEGER
    );
  `);

  // Create files_changed table
  db.exec(`
    CREATE TABLE IF NOT EXISTS files_changed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      path TEXT NOT NULL,
      change_type TEXT NOT NULL
    );
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_intent ON runs(intent);
    CREATE INDEX IF NOT EXISTS idx_thoughts_run_id ON thoughts(run_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_run_id ON tool_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_files_changed_run_id ON files_changed(run_id);
  `);
}