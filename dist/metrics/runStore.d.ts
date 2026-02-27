/**
 * Miranda Core — Run Store
 * Persist RunRecords as JSONL and provide run summaries.
 */
import type { RunRecord, RunSummary } from "../pipeline/types.js";
/**
 * Append a RunRecord as a single JSONL line to the log file.
 */
export declare function appendRunLog(record: RunRecord, logPath: string): void;
/**
 * Convert a RunRecord into a summary object suitable for display.
 */
export declare function getRunSummary(record: RunRecord): RunSummary;
//# sourceMappingURL=runStore.d.ts.map