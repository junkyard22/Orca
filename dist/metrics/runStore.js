/**
 * Miranda Core — Run Store
 * Persist RunRecords as JSONL and provide run summaries.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
/**
 * Append a RunRecord as a single JSONL line to the log file.
 */
export function appendRunLog(record, logPath) {
    try {
        mkdirSync(dirname(logPath), { recursive: true });
    }
    catch {
        // Directory may already exist
    }
    const line = JSON.stringify(record) + "\n";
    appendFileSync(logPath, line, "utf-8");
}
/**
 * Convert a RunRecord into a summary object suitable for display.
 */
export function getRunSummary(record) {
    return {
        runId: record.runId,
        timestamp: record.timestamp,
        prompt: record.userPrompt,
        stages: record.stages.map((s) => ({
            stage: s.stage,
            model: s.modelUsed,
            retries: s.attempts.length - 1,
            cost: s.totalCost,
            success: s.success,
        })),
        totalCost: record.totalCost,
        totalDurationMs: record.totalDurationMs,
        budgetExceeded: record.budgetExceeded,
        liteMode: record.liteMode,
    };
}
//# sourceMappingURL=runStore.js.map