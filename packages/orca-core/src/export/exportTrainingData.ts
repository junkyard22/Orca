/**
 * Training data export — reads completed runs from the OrcaStore and writes
 * them as JSONL in Moonshiner-compatible format.
 *
 * Usage:
 *   import { exportTrainingData } from '@clawde/orca-core';
 *   const summary = await exportTrainingData(store, {
 *     verdict: 'PASS',
 *     maxRepairPasses: 0,
 *     outputPath: 'moonshiner/data/orca_coding_prompts.jsonl',
 *   });
 */

import * as fs from "fs";
import * as path from "path";
import type { OrcaStore } from "../persistence/types.js";

export interface ExportOptions {
  /** Filter by Pappy verdict. Default: 'PASS'. */
  verdict?: 'PASS' | 'WARN' | 'FAIL';
  /** Filter by Brain's routing role (e.g. 'strong_model'). */
  taskType?: string;
  /** Exclude runs that needed fewer iterations than this. */
  minIterations?: number;
  /** Exclude runs that needed more than this many repair passes. Default: 0. */
  maxRepairPasses?: number;
  /** Path to write the JSONL output file. */
  outputPath: string;
  /** Maximum number of records to export. */
  limit?: number;
}

export interface TrainingRecord {
  /** Original user task. */
  prompt: string;
  /** Verified output text. */
  response: string;
  /** Model/role that produced it. */
  teacher: string;
  /** Role tag for Moonshiner filtering (e.g. 'strong_model', 'brain'). */
  role: string;
  /** Quality score: 10 for PASS, 7 for WARN. */
  score: number;
  metadata: {
    taskType: string;
    verdict: string;
    iterations: number;
    repairPasses: number;
    taskId: string;
    timestamp: string;
  };
}

export interface ExportSummary {
  exported: number;
  skipped: number;
  outputPath: string;
}

const MIN_OUTPUT_LENGTH = 50;
const SCORE_BY_VERDICT: Record<string, number> = { PASS: 10, WARN: 7 };

/**
 * Export runs from the store as a Moonshiner-compatible JSONL file.
 *
 * @param store  - An OrcaStore implementation (e.g. SqliteStore).
 * @param opts   - Export filter and output options.
 * @returns      Summary of records exported and skipped.
 */
export async function exportTrainingData(
  store: OrcaStore,
  opts: ExportOptions,
): Promise<ExportSummary> {
  const targetVerdict = opts.verdict ?? 'PASS';
  const maxRepairs = opts.maxRepairPasses ?? 0;

  // Read all runs — getRecentRuns(undefined) uses the store's default cap.
  // We pass a very large limit so we get everything available.
  const runs = await store.getRecentRuns(1_000_000);

  let exported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  const records: TrainingRecord[] = [];

  for (const run of runs) {
    // 1. Verdict filter
    if (run.verdict !== targetVerdict) {
      skipReasons['wrong_verdict'] = (skipReasons['wrong_verdict'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 2. Repair pass filter — default 0 means first-attempt-only
    const repairPasses = run.repairPasses ?? 0;
    if (repairPasses > maxRepairs) {
      skipReasons['too_many_repairs'] = (skipReasons['too_many_repairs'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 3. Task type filter
    if (opts.taskType !== undefined && run.role !== opts.taskType) {
      skipReasons['wrong_task_type'] = (skipReasons['wrong_task_type'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 4. Minimum iterations filter
    const iterations = run.iterationCount ?? 1;
    if (opts.minIterations !== undefined && iterations < opts.minIterations) {
      skipReasons['too_few_iterations'] = (skipReasons['too_few_iterations'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 5. Output quality check — skip empty or suspiciously short outputs
    const outputText = run.outputText ?? '';
    if (outputText.length < MIN_OUTPUT_LENGTH) {
      skipReasons['output_too_short'] = (skipReasons['output_too_short'] ?? 0) + 1;
      skipped++;
      continue;
    }

    const score = SCORE_BY_VERDICT[run.verdict] ?? 7;
    const teacherRole = run.role ?? 'unknown';

    records.push({
      prompt: run.intent,
      response: outputText,
      teacher: teacherRole,
      role: teacherRole,
      score,
      metadata: {
        taskType: teacherRole,
        verdict: run.verdict,
        iterations,
        repairPasses,
        taskId: run.id,
        timestamp: run.createdAt,
      },
    });

    // ── Moonshiner brain signal ──────────────────────────────────────────────
    // When Brain routed successfully (brainDecision is populated) and the task
    // earned a full PASS, emit a second record tagged role:"brain".  This lets
    // Moonshiner distil Brain's routing prompt separately from the worker roles.
    // We only do this for PASS (not WARN) to keep the brain training set clean.
    if (
      run.brainDecision &&
      run.brainDecision.trim().length >= 20 &&
      targetVerdict === 'PASS'
    ) {
      records.push({
        prompt: run.intent,
        response: run.brainDecision.trim(),
        teacher: 'brain',
        role: 'brain',
        score: 10,
        metadata: {
          taskType: 'brain',
          verdict: 'PASS',
          iterations: 1,
          repairPasses: 0,
          taskId: run.id,
          timestamp: run.createdAt,
        },
      });
    }

    // Apply limit after building the record
    if (opts.limit !== undefined && records.length >= opts.limit) {
      break;
    }
  }

  exported = records.length;
  // Runs that were read but not included in records are skipped (already counted above).
  // Recalculate skipped to be the total minus exported (handles limit truncation).
  skipped = runs.length - exported;

  // Ensure output directory exists
  const outputDir = path.dirname(path.resolve(opts.outputPath));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write JSONL
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  fs.writeFileSync(opts.outputPath, lines, 'utf8');

  // Log summary
  console.log(`[export] wrote ${exported} records to ${opts.outputPath}`);
  if (skipped > 0) {
    const reasons = Object.entries(skipReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(`[export] skipped ${skipped} records (${reasons})`);
  }

  return { exported, skipped, outputPath: opts.outputPath };
}
