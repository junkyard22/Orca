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
  /** Quality score: 10 for PASS, 7 for WARN, 0 for an honest FAIL (negative example). */
  score: number;
  metadata: {
    taskType: string;
    verdict: string;
    /** success (PASS) · partial_success (WARN) · honest_failure (FAIL, exported only on request): the training polarity. */
    outcome: "success" | "partial_success" | "honest_failure";
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
  skipReasons: Record<string, number>;
}

const MIN_OUTPUT_LENGTH = 50;
// Quality score by verdict. A FAIL record is only ever exported on explicit
// request (verdict: 'FAIL'); it is a negative example and must never carry a
// positive-looking score — before phase 6.6 it fell through to the WARN
// score of 7, which a score-based consumer could have read as a decent
// success example.
const SCORE_BY_VERDICT: Record<string, number> = { PASS: 10, WARN: 7, FAIL: 0 };

/** What the record teaches, stated outright so no consumer has to infer it from the score. */
function outcomeOf(verdict: string): "success" | "partial_success" | "honest_failure" {
  return verdict === "PASS" ? "success" : verdict === "WARN" ? "partial_success" : "honest_failure";
}

const SECRET_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: "aws_secret_access_key", pattern: /\baws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{32,}\b/i },
  { reason: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { reason: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { reason: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { reason: "stripe_secret_key", pattern: /\bsk_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { reason: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    reason: "env_secret_assignment",
    pattern: /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*['"]?[A-Za-z0-9_./+=:@-]{12,}/i,
  },
  {
    reason: "generic_secret_literal",
    pattern: /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_./+=:@-]{12,}["']/i,
  },
];

export function detectTrainingExportExclusion(text: string): string | undefined {
  for (const { reason, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

/**
 * PappyPort stamps the effective training decision into the persisted summary.
 * Keep this separate from the verdict filter: PASS/WARN/FAIL and trainability
 * intentionally answer different questions.
 *
 * A run is exportable only when the summary says so explicitly. A summary
 * without the tag — a run recorded before eligibility existed, or one that
 * never went through Pappy ("ok") — is not trustworthy legacy data: nothing
 * checked it against evidence, so it is excluded as `missing`.
 */
export function detectTrainingEligibilityExclusion(summary: string | undefined): string | undefined {
  const match = summary?.match(/\btraining_eligibility=(eligible|accepted_but_not_trainable|needs_human_review|rejected)\b/i);
  if (!match?.[1]) return 'missing';

  const eligibility = match[1].toLowerCase();
  return eligibility === 'eligible' ? undefined : eligibility;
}

/**
 * The export's own check on the evidence behind an eligible run, read from the
 * tags PappyPort writes beside the eligibility: the run must have been judged
 * against host evidence that either verified it or confirmed its honest
 * failure. The eligibility word is not trusted on its own; a summary that says
 * `eligible` without an evidence tag (or with evidence that was unavailable,
 * absent, insufficient or unreadable) is excluded, whatever produced it.
 */
export function detectEvidenceExclusion(summary: string | undefined): string | undefined {
  const match = summary?.match(/\bevidence=(verified|unverified|uninterpretable|contradicted|unavailable|not_applicable)\b/i);
  if (!match?.[1]) return 'evidence_tag_missing';
  const status = match[1].toLowerCase();
  return status === 'verified' || status === 'contradicted' ? undefined : status;
}

async function collectEvidenceText(store: OrcaStore, runId: string): Promise<string> {
  try {
    const events = await store.getRunToolEvents(runId);
    return events.map((event) => event.summary ?? "").join("\n");
  } catch {
    return "";
  }
}

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
    // 0. A run that stopped before it finished — the user pressed Stop, or
    // the process died — is not an example of anything. It is persisted as
    // status FAIL with stoppedBecause cancelled/interrupted and usually no
    // verdict; when Pappy had already judged a pass before the stop, that
    // verdict describes work that was then abandoned. Neither a positive nor a
    // negative example, whichever verdict is requested.
    if (run.stoppedBecause === 'cancelled' || run.stoppedBecause === 'interrupted') {
      const key = `stopped_before_completion:${run.stoppedBecause}`;
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 1. Verdict filter
    if (run.verdict !== targetVerdict) {
      skipReasons['wrong_verdict'] = (skipReasons['wrong_verdict'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 2. Pappy training-eligibility filter. A PASS is not automatically
    // trainable; verifier provenance and integrity checks may forbid export,
    // and a run with no recorded decision is never exported.
    const trainingExclusion = detectTrainingEligibilityExclusion(run.summary);
    if (trainingExclusion) {
      const key = `pappy_training_eligibility:${trainingExclusion}`;
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 2b. Independent evidence check: eligible is exported only when the run
    // was judged against host evidence. Missing runtime evidence is not
    // trustworthy legacy data.
    const evidenceExclusion = detectEvidenceExclusion(run.summary);
    if (evidenceExclusion) {
      const key = `pappy_evidence:${evidenceExclusion}`;
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 3. Repair pass filter — default 0 means first-attempt-only
    const repairPasses = run.repairPasses ?? 0;
    if (repairPasses > maxRepairs) {
      skipReasons['too_many_repairs'] = (skipReasons['too_many_repairs'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 4. Task type filter
    if (opts.taskType !== undefined && run.role !== opts.taskType) {
      skipReasons['wrong_task_type'] = (skipReasons['wrong_task_type'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 5. Minimum iterations filter
    const iterations = run.iterationCount ?? 1;
    if (opts.minIterations !== undefined && iterations < opts.minIterations) {
      skipReasons['too_few_iterations'] = (skipReasons['too_few_iterations'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 6. Output quality check — skip empty or suspiciously short outputs
    const outputText = run.outputText ?? '';
    if (outputText.length < MIN_OUTPUT_LENGTH) {
      skipReasons['output_too_short'] = (skipReasons['output_too_short'] ?? 0) + 1;
      skipped++;
      continue;
    }

    // 7. Training-safety filter - do not export poisoned or credential-bearing
    // examples even if Pappy returned PASS/WARN.
    const evidenceText = await collectEvidenceText(store, run.id);
    const exportCorpus = [
      run.intent,
      outputText,
      run.summary ?? "",
      run.brainDecision ?? "",
      evidenceText,
    ].join("\n");
    const exclusionReason = detectTrainingExportExclusion(exportCorpus);
    if (exclusionReason) {
      const key = `unsafe_artifact:${exclusionReason}`;
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
      skipped++;
      continue;
    }

    const score = SCORE_BY_VERDICT[run.verdict] ?? 0;
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
        outcome: outcomeOf(run.verdict),
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
          outcome: 'success',
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

  return { exported, skipped, outputPath: opts.outputPath, skipReasons };
}
