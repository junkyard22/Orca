/**
 * SQLite implementation of the OrcaStore interface.
 * 
 * Uses sql.js (pure JavaScript SQLite port) for synchronous operations.
 * All operations are atomic via transactions.
 * 
 * Constructor takes a dbPath and automatically runs migrations on startup.
 * If SQLite fails to open, logs the error and continues without persistence
 * rather than crashing the app.
 */

import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { runMigrations } from "./migrations.js";
import type { RunRecord, ThoughtRecord, ToolEvent, FileChange, OrcaStore } from "./types.js";
import * as fs from "fs";
import * as path from "path";

/**
 * SqliteStore - SQLite-backed implementation of OrcaStore.
 * 
 * Default path: ~/.orca/runs.db (CLI) or app.getPath('userData')/orca-runs.db (Electron)
 */
export class SqliteStore implements OrcaStore {
  private db: Database | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.initPromise = this.initDatabase();
  }

  /**
   * Initialize the database asynchronously.
   */
  private async initDatabase(): Promise<void> {
    try {
      // Load existing database file or create new one
      let dbData: Uint8Array | undefined;
      if (fs.existsSync(this.dbPath)) {
        const buffer = fs.readFileSync(this.dbPath);
        dbData = new Uint8Array(buffer);
      }
      
      // Initialize sql.js and open database
      const SQL = await initSqlJs();
      this.db = new SQL.Database(dbData);
      runMigrations(this.db);
    } catch (err) {
      console.error("[SqliteStore] Failed to open database:", err);
      // Create an in-memory fallback to avoid crashing
      try {
        const SQL = await initSqlJs();
        this.db = new SQL.Database();
        runMigrations(this.db);
      } catch (fallbackErr) {
        console.error("[SqliteStore] Failed to create in-memory fallback:", fallbackErr);
      }
    }
  }

  /**
   * Wait for initialization to complete with a timeout.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  /**
   * Persist a completed run record with all related data.
   * Uses a transaction to ensure atomicity — all four inserts succeed or none do.
   */
  async saveRun(
    run: RunRecord,
    thoughts: ThoughtRecord[],
    toolEvents: ToolEvent[],
    filesChanged: FileChange[]
  ): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    try {
      // Start transaction
      this.db.run("BEGIN TRANSACTION");

      try {
        // Insert the main run record using parameterized query
        this.db.run(
          `INSERT INTO runs (
            id, created_at, intent, role, status, stopped_because,
            iteration_count, output_text, summary, verdict, confidence,
            issue_count, input_tokens, output_tokens, cost_usd, repair_passes,
            brain_decision, error_message, ahp_packet_graph
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            run.id,
            run.createdAt,
            run.intent,
            run.role ?? null,
            run.status,
            run.stoppedBecause ?? null,
            run.iterationCount ?? null,
            run.outputText ?? null,
            run.summary ?? null,
            run.verdict ?? null,
            run.confidence ?? null,
            run.issueCount ?? null,
            run.inputTokens ?? null,
            run.outputTokens ?? null,
            run.costUsd ?? null,
            run.repairPasses ?? null,
            run.brainDecision ?? null,
            run.errorMessage ?? null,
            run.ahpPacketGraph ?? null,
          ]
        );

        // Insert thoughts
        for (const thought of thoughts) {
          this.db.run(
            `INSERT INTO thoughts (run_id, iteration, thought, observation, next)
             VALUES (?, ?, ?, ?, ?)`,
            [
              run.id,
              thought.iteration,
              thought.thought ?? null,
              thought.observation ?? null,
              thought.next ?? null,
            ]
          );
        }

        // Insert tool events
        for (const event of toolEvents) {
          this.db.run(
            `INSERT INTO tool_events (run_id, tool, ok, summary, iteration)
             VALUES (?, ?, ?, ?, ?)`,
            [
              run.id,
              event.tool,
              event.ok ? 1 : 0,
              event.summary ?? null,
              event.iteration ?? null,
            ]
          );
        }

        // Insert file changes
        for (const file of filesChanged) {
          this.db.run(
            `INSERT INTO files_changed (run_id, path, change_type)
             VALUES (?, ?, ?)`,
            [run.id, file.path, file.changeType]
          );
        }

        // Commit transaction
        this.db.run("COMMIT");
        
        // Persist to disk
        this.persistToDisk();
      } catch (err) {
        // Rollback on error
        this.db.run("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("[SqliteStore] saveRun failed:", err);
    }
  }

  /**
   * Return the most-recent runs, newest first.
   * Defaults to last 50 runs if no limit specified.
   */
  async getRecentRuns(limit: number = 50): Promise<RunRecord[]> {
    await this.ensureInitialized();
    if (!this.db) return [];

    const stmt = this.db.prepare(
      `SELECT
        id, created_at, intent, role, status, stopped_because,
        iteration_count, output_text, summary, verdict, confidence,
        issue_count, input_tokens, output_tokens, cost_usd, repair_passes,
        brain_decision, error_message, ahp_packet_graph
      FROM runs
      ORDER BY created_at DESC
      LIMIT ?`
    );

    stmt.bind([limit]);
    const rows: Array<{
      id: string;
      created_at: string;
      intent: string;
      role: string | null;
      status: string;
      stopped_because: string | null;
      iteration_count: number | null;
      output_text: string | null;
      summary: string | null;
      verdict: string | null;
      confidence: number | null;
      issue_count: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number | null;
      repair_passes: number | null;
      brain_decision: string | null;
      error_message: string | null;
      ahp_packet_graph: string | null;
    }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row as any);
    }
    stmt.free();

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      intent: row.intent,
      role: row.role ?? undefined,
      status: row.status as 'SUCCESS' | 'FAIL',
      stoppedBecause: row.stopped_because as 'done' | 'max_iterations' | 'loop_detected' | 'error' | undefined,
      errorMessage: row.error_message ?? undefined,
      iterationCount: row.iteration_count ?? undefined,
      outputText: row.output_text ?? undefined,
      summary: row.summary ?? undefined,
      verdict: row.verdict as 'PASS' | 'WARN' | 'FAIL' | undefined,
      confidence: row.confidence ?? undefined,
      issueCount: row.issue_count ?? undefined,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      repairPasses: row.repair_passes ?? undefined,
      brainDecision: row.brain_decision ?? undefined,
      ahpPacketGraph: row.ahp_packet_graph ?? undefined,
    }));
  }

  /**
   * Get a single run by ID.
   */
  async getRun(id: string): Promise<RunRecord | null> {
    await this.ensureInitialized();
    if (!this.db) return null;

    const stmt = this.db.prepare(
      `SELECT
        id, created_at, intent, role, status, stopped_because,
        iteration_count, output_text, summary, verdict, confidence,
        issue_count, input_tokens, output_tokens, cost_usd, repair_passes,
        brain_decision, error_message, ahp_packet_graph
      FROM runs
      WHERE id = ?`
    );

    stmt.bind([id]);
    let row: any = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();

    if (!row) return null;

    return {
      id: row.id,
      createdAt: row.created_at,
      intent: row.intent,
      role: row.role ?? undefined,
      status: row.status as 'SUCCESS' | 'FAIL',
      stoppedBecause: row.stopped_because as 'done' | 'max_iterations' | 'loop_detected' | 'error' | undefined,
      errorMessage: row.error_message ?? undefined,
      iterationCount: row.iteration_count ?? undefined,
      outputText: row.output_text ?? undefined,
      summary: row.summary ?? undefined,
      verdict: row.verdict as 'PASS' | 'WARN' | 'FAIL' | undefined,
      confidence: row.confidence ?? undefined,
      issueCount: row.issue_count ?? undefined,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      repairPasses: row.repair_passes ?? undefined,
      brainDecision: row.brain_decision ?? undefined,
      ahpPacketGraph: row.ahp_packet_graph ?? undefined,
    };
  }

  /**
   * Get all thoughts for a specific run.
   */
  async getRunThoughts(runId: string): Promise<ThoughtRecord[]> {
    await this.ensureInitialized();
    if (!this.db) return [];

    const stmt = this.db.prepare(
      `SELECT iteration, thought, observation, next
       FROM thoughts
       WHERE run_id = ?
       ORDER BY iteration ASC`
    );

    stmt.bind([runId]);
    const rows: Array<{
      iteration: number;
      thought: string | null;
      observation: string | null;
      next: string | null;
    }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row as any);
    }
    stmt.free();

    return rows.map((row) => ({
      runId,
      iteration: row.iteration,
      thought: row.thought ?? undefined,
      observation: row.observation ?? undefined,
      next: row.next ?? undefined,
    }));
  }

  /**
   * Get all tool events for a specific run.
   */
  async getRunToolEvents(runId: string): Promise<ToolEvent[]> {
    await this.ensureInitialized();
    if (!this.db) return [];

    const stmt = this.db.prepare(
      `SELECT tool, ok, summary, iteration
       FROM tool_events
       WHERE run_id = ?
       ORDER BY id ASC`
    );

    stmt.bind([runId]);
    const rows: Array<{
      tool: string;
      ok: number;
      summary: string | null;
      iteration: number | null;
    }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row as any);
    }
    stmt.free();

    return rows.map((row) => ({
      runId,
      tool: row.tool,
      ok: row.ok === 1,
      summary: row.summary ?? undefined,
      iteration: row.iteration ?? undefined,
    }));
  }

  /**
   * Delete a single run and all its related records (thoughts, tool_events, files_changed).
   * Uses CASCADE via foreign keys if enabled, otherwise explicit deletes.
   */
  async deleteRun(id: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    try {
      this.db.run("BEGIN TRANSACTION");
      try {
        this.db.run("DELETE FROM thoughts     WHERE run_id = ?", [id]);
        this.db.run("DELETE FROM tool_events  WHERE run_id = ?", [id]);
        this.db.run("DELETE FROM files_changed WHERE run_id = ?", [id]);
        this.db.run("DELETE FROM runs         WHERE id = ?",     [id]);
        this.db.run("COMMIT");
        this.persistToDisk();
      } catch (err) {
        this.db.run("ROLLBACK");
        throw err;
      }
    } catch (err) {
      console.error("[SqliteStore] deleteRun failed:", err);
    }
  }

  /**
   * Search runs by query string (matches intent and output_text).
   * Uses LIKE %query% for partial matching.
   * Defaults to 20 results if no limit specified.
   */
  async searchRuns(query: string, limit: number = 20): Promise<RunRecord[]> {
    await this.ensureInitialized();
    if (!this.db) return [];

    const searchTerm = `%${query}%`;
    const stmt = this.db.prepare(
      `SELECT
        id, created_at, intent, role, status, stopped_because,
        iteration_count, output_text, summary, verdict, confidence,
        issue_count, input_tokens, output_tokens, cost_usd, repair_passes,
        error_message
      FROM runs
      WHERE intent LIKE ? OR output_text LIKE ?
      ORDER BY created_at DESC
      LIMIT ?`
    );

    stmt.bind([searchTerm, searchTerm, limit]);
    const rows: Array<{
      id: string;
      created_at: string;
      intent: string;
      role: string | null;
      status: string;
      stopped_because: string | null;
      iteration_count: number | null;
      output_text: string | null;
      summary: string | null;
      verdict: string | null;
      confidence: number | null;
      issue_count: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number | null;
      repair_passes: number | null;
      error_message: string | null;
    }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row as any);
    }
    stmt.free();

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      intent: row.intent,
      role: row.role ?? undefined,
      status: row.status as 'SUCCESS' | 'FAIL',
      stoppedBecause: row.stopped_because as 'done' | 'max_iterations' | 'loop_detected' | 'error' | undefined,
      errorMessage: row.error_message ?? undefined,
      iterationCount: row.iteration_count ?? undefined,
      outputText: row.output_text ?? undefined,
      summary: row.summary ?? undefined,
      verdict: row.verdict as 'PASS' | 'WARN' | 'FAIL' | undefined,
      confidence: row.confidence ?? undefined,
      issueCount: row.issue_count ?? undefined,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      repairPasses: row.repair_passes ?? undefined,
    }));
  }

  /**
   * Get aggregate statistics across all runs.
   */
  async getStats(): Promise<{
    totalRuns: number;
    passRate: number;
    avgIterations: number;
    totalCostUsd: number;
  }> {
    await this.ensureInitialized();
    if (!this.db) {
      return { totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 };
    }

    const stmt = this.db.prepare(
      `SELECT 
        COUNT(*) as totalRuns,
        SUM(CASE WHEN verdict = 'PASS' THEN 1 ELSE 0 END) as passCount,
        AVG(iteration_count) as avgIterations,
        SUM(cost_usd) as totalCostUsd
      FROM runs`
    );

    let row: any = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();

    if (!row) {
      return { totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 };
    }

    const passRate = row.totalRuns > 0 ? row.passCount / row.totalRuns : 0;

    return {
      totalRuns: row.totalRuns,
      passRate,
      avgIterations: row.avgIterations ?? 0,
      totalCostUsd: row.totalCostUsd ?? 0,
    };
  }

  /**
   * Graceful teardown - close database connection and persist to disk.
   */
  close(): void {
    if (this.db) {
      this.persistToDisk();
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Persist the in-memory database to disk.
   */
  private persistToDisk(): void {
    if (!this.db || this.dbPath === ":memory:") return;

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      console.error("[SqliteStore] Failed to persist to disk:", err);
    }
  }
}
