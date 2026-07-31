/**
 * analyze.ts — Orca profile run analyzer.
 *
 * Reads a JSONL profile run and produces a markdown report with:
 *   - Total wall-clock time
 *   - Per-phase breakdown (LLM, Pappy, SQLite, AHP, trace writes, other)
 *   - Per-LLM-call breakdown sorted by duration
 *   - Prompt-cache hit rate, split by call method
 *   - Trace write stats (count, total, mean, p95)
 *   - AHP validation stats
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings scripts/profiling/analyze.ts profile-runs/run-XXX.jsonl
 *   node --experimental-strip-types --no-warnings scripts/profiling/analyze.ts --all   (analyze all runs in profile-runs/)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

interface ProfileEvent {
  phase: string;
  _ts: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function sum(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0);
}

function mean(arr: number[]): number {
  return arr.length > 0 ? sum(arr) / arr.length : 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

function pct(ms: number, total: number): string {
  return total > 0 ? (ms / total * 100).toFixed(1) + "%" : "n/a";
}

function fmtMs(ms: number): string {
  return ms.toFixed(1);
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Prompt-cache accounting over a run's llm_call events.
 *
 * Only calls where the provider actually reported `cachedPromptTokens` count
 * towards the ratio. A provider that never reports the field is not a 0% hit
 * rate — it is an unmeasured call, and folding it in would understate caching.
 */
interface CacheStats {
  /** Calls whose provider reported cached_tokens. */
  reportingCalls: number;
  /** Calls with no cache figure — provider silent, or usage never requested. */
  silentCalls: number;
  /** Prompt tokens across reporting calls. */
  promptTokens: number;
  /** Cached prompt tokens across reporting calls. */
  cachedTokens: number;
  /** Reporting-call counts per method, e.g. { stream: 6, complete: 1 }. */
  byMethod: Record<string, number>;
}

interface RunAnalysis {
  filePath: string;
  runId: string;
  totalMs: number;
  llmMs: number;
  pappyMs: number;
  sqliteMs: number;
  ahpMs: number;
  traceMs: number;
  otherMs: number;
  llmCalls: ProfileEvent[];
  cache: CacheStats;
  traceWriteTimes: number[];
  validationTimes: number[];
  pappyCalls: ProfileEvent[];
  notes: string[];
}

function collectCacheStats(llmCalls: ProfileEvent[]): CacheStats {
  const stats: CacheStats = {
    reportingCalls: 0,
    silentCalls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    byMethod: {},
  };

  for (const call of llmCalls) {
    const cached = call["cachedPromptTokens"];
    if (typeof cached !== "number") {
      stats.silentCalls++;
      continue;
    }
    const method = (call["method"] as string) ?? "unknown";
    stats.reportingCalls++;
    stats.cachedTokens += cached;
    stats.promptTokens += (call["promptTokens"] as number) ?? 0;
    stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
  }

  return stats;
}

function analyzeRun(jsonlPath: string): RunAnalysis {
  const text = readFileSync(jsonlPath, "utf8");
  const events: ProfileEvent[] = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProfileEvent);

  const notes: string[] = [];

  const runStart = events.find((e) => e.phase === "run:start");
  const runEnd = events.find((e) => e.phase === "run:end");
  const runId = (runStart?.runId as string) ?? basename(jsonlPath, ".jsonl");

  // Total wall-clock: use run:start → run:end if present, else span of all events
  let totalMs = 0;
  if (runStart && runEnd) {
    totalMs = runEnd._ts - runStart._ts;
  } else if (events.length > 1) {
    totalMs = events[events.length - 1]!._ts - events[0]!._ts;
    notes.push("run:start/run:end markers absent — total derived from event span");
  }
  if (runStart?.totalMs) {
    totalMs = runStart.totalMs as number;
    notes.push("totalMs taken from run:end event metadata");
  }
  if (runEnd?.totalMs) {
    totalMs = runEnd.totalMs as number;
  }

  // Phase buckets
  const llmCalls = events.filter((e) => e.phase === "llm_call");
  const llmMs = sum(llmCalls.map((e) => (e.durationMs as number) ?? 0));

  const pappyCalls = events.filter((e) => e.phase === "pappy_eval");
  const pappyMs = sum(pappyCalls.map((e) => (e.durationMs as number) ?? 0));

  const sqliteEvents = events.filter((e) => e.phase === "sqlite_save");
  const sqliteMs = sum(sqliteEvents.map((e) => (e.durationMs as number) ?? 0));

  const ahpCreateEvents = events.filter((e) => e.phase === "ahp_packet_create");
  const ahpValidateEvents = events.filter((e) => e.phase === "ahp_validation");
  const ahpMs =
    sum(ahpCreateEvents.map((e) => (e.durationMs as number) ?? 0)) +
    sum(ahpValidateEvents.map((e) => (e.durationMs as number) ?? 0));

  const traceEvents = events.filter((e) => e.phase === "trace_write");
  const traceMs = sum(traceEvents.map((e) => (e.durationMs as number) ?? 0));

  const measuredMs = llmMs + pappyMs + sqliteMs + ahpMs + traceMs;
  const otherMs = Math.max(0, totalMs - measuredMs);

  if (llmMs === 0) {
    notes.push(
      "WARNING: no llm_call events found — run may predate instrumentation or was produced from legacy log data",
    );
  }
  if (pappyMs === 0 && pappyCalls.length === 0) {
    notes.push("pappy_eval not instrumented — Pappy time included in 'other'");
  }
  if (sqliteMs === 0 && sqliteEvents.length === 0) {
    notes.push("sqlite_save not instrumented — SQLite time included in 'other'");
  }

  const traceWriteTimes = traceEvents
    .map((e) => (e.durationMs as number) ?? 0)
    .sort((a, b) => a - b);

  const validationTimes = ahpValidateEvents
    .map((e) => (e.durationMs as number) ?? 0)
    .sort((a, b) => a - b);

  return {
    filePath: jsonlPath,
    runId,
    totalMs,
    llmMs,
    pappyMs,
    sqliteMs,
    ahpMs,
    traceMs,
    otherMs,
    llmCalls: [...llmCalls].sort(
      (a, b) => (b.durationMs as number) - (a.durationMs as number),
    ),
    cache: collectCacheStats(llmCalls),
    traceWriteTimes,
    validationTimes,
    pappyCalls,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderCacheSection(c: CacheStats): string[] {
  const lines = ["## Prompt Cache", ""];

  if (c.reportingCalls === 0) {
    lines.push(
      `No LLM call reported cached prompt tokens (${c.silentCalls} call(s) silent).`,
      "",
      "Either the provider has no context cache, or it reported no usage at all —",
      "a streamed call only carries usage when the adapter requests it via",
      "`stream_options.include_usage`.",
      "",
    );
    return lines;
  }

  const ratio = c.promptTokens > 0
    ? (c.cachedTokens / c.promptTokens * 100).toFixed(1) + "%"
    : "n/a";
  const methods = Object.entries(c.byMethod)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([method, count]) => `${method} × ${count}`)
    .join(", ");

  lines.push(
    "| Metric | Value |",
    "|--------|-------|",
    `| **Cache hit rate** | **${ratio}** |`,
    `| Cached prompt tokens | ${c.cachedTokens} |`,
    `| Prompt tokens (reporting calls) | ${c.promptTokens} |`,
    `| Calls reporting cache data | ${c.reportingCalls} (${methods}) |`,
    `| Calls with no cache data | ${c.silentCalls} |`,
    "",
  );

  if (c.silentCalls > 0) {
    lines.push(
      `Hit rate covers the ${c.reportingCalls} reporting call(s) only. Silent calls are`,
      "excluded rather than counted as misses — an unmeasured call is not a miss.",
      "",
    );
  }

  return lines;
}

function renderReport(a: RunAnalysis): string {
  const lines: string[] = [
    `# Orca Profile Analysis — ${a.runId}`,
    "",
    `**Source:** \`${a.filePath}\`  `,
    `**Total wall-clock:** ${fmtMs(a.totalMs)} ms (${(a.totalMs / 1000).toFixed(2)} s)  `,
    `**LLM calls:** ${a.llmCalls.length}  `,
    "",
  ];

  if (a.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of a.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push(
    "## Phase Breakdown",
    "",
    "| Phase | Time (ms) | % of Total |",
    "|-------|-----------|------------|",
    `| **LLM inference (total)** | **${fmtMs(a.llmMs)}** | **${pct(a.llmMs, a.totalMs)}** |`,
    `| Pappy evaluation | ${fmtMs(a.pappyMs)} | ${pct(a.pappyMs, a.totalMs)} |`,
    `| SQLite persistence | ${fmtMs(a.sqliteMs)} | ${pct(a.sqliteMs, a.totalMs)} |`,
    `| AHP packet ops | ${fmtMs(a.ahpMs)} | ${pct(a.ahpMs, a.totalMs)} |`,
    `| Trace writes | ${fmtMs(a.traceMs)} | ${pct(a.traceMs, a.totalMs)} |`,
    `| Other / routing / overhead | ${fmtMs(a.otherMs)} | ${pct(a.otherMs, a.totalMs)} |`,
    "",
  );

  if (a.llmCalls.length > 0) {
    lines.push(
      "## Per-LLM Call Breakdown (descending by duration)",
      "",
      "| # | Agent / Stage | Model | Duration (ms) | Tokens |",
      "|---|--------------|-------|---------------|--------|",
    );
    for (let i = 0; i < a.llmCalls.length; i++) {
      const e = a.llmCalls[i]!;
      const role = (e.role ?? e.stage ?? "unknown") as string;
      const model = (e.model ?? "unknown") as string;
      const dur = fmtMs((e.durationMs as number) ?? 0);
      const tokens = e.totalTokens ?? e.completionTokens ?? "n/a";
      lines.push(`| ${i + 1} | ${role} | ${model} | ${dur} | ${tokens} |`);
    }
    lines.push("");
  }

  lines.push(...renderCacheSection(a.cache));

  lines.push(
    "## Trace Write Stats",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Count | ${a.traceWriteTimes.length} |`,
    `| Total (ms) | ${fmtMs(a.traceMs)} |`,
    `| Mean (ms) | ${fmtMs(mean(a.traceWriteTimes))} |`,
    `| P95 (ms) | ${fmtMs(percentile(a.traceWriteTimes, 95))} |`,
    "",
    "## AHP Validation Stats",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Count | ${a.validationTimes.length} |`,
    `| Total (ms) | ${fmtMs(sum(a.validationTimes))} |`,
    `| Mean (ms) | ${fmtMs(mean(a.validationTimes))} |`,
    `| P95 (ms) | ${fmtMs(percentile(a.validationTimes, 95))} |`,
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  let paths: string[] = [];

  if (args[0] === "--all") {
    const dir = args[1] ?? "./profile-runs";
    paths = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
    if (paths.length === 0) {
      console.error(`No .jsonl files found in ${dir}`);
      process.exit(1);
    }
  } else if (args.length > 0) {
    paths = args;
  } else {
    console.error(
      "Usage:\n" +
        "  analyze.ts <run.jsonl>              — analyze one run\n" +
        "  analyze.ts run1.jsonl run2.jsonl    — analyze multiple\n" +
        "  analyze.ts --all [dir]              — analyze all in profile-runs/",
    );
    process.exit(1);
  }

  for (const p of paths) {
    const analysis = analyzeRun(p);
    const report = renderReport(analysis);

    const reportPath = p.replace(/\.jsonl$/, "-report.md");
    writeFileSync(reportPath, report, "utf8");
    console.log(`\n${report}`);
    console.log(`\nReport saved → ${reportPath}`);
  }
}

main();
