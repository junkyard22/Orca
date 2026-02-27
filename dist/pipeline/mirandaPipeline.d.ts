/**
 * Miranda Core — Miranda Pipeline
 * Sequential orchestrator: PLAN → ANSWER → CRITIQUE → REWRITE
 * with budget controls and JSONL logging.
 */
import type { LLMAdapter } from "../llm/adapter.js";
import type { MirandaConfig, RunRecord } from "../pipeline/types.js";
import type { RunSummary } from "../pipeline/types.js";
export interface PipelineResult {
    record: RunRecord;
    summary: RunSummary;
}
/**
 * Run the full Miranda pipeline for a user prompt.
 *
 * Stages run sequentially: PLAN → ANSWER → CRITIQUE → REWRITE.
 * Budget is tracked across stages. If exceeded, CRITIQUE + REWRITE are skipped (lite mode).
 */
export declare function runPipeline(userPrompt: string, adapter: LLMAdapter, config: MirandaConfig): Promise<PipelineResult>;
//# sourceMappingURL=mirandaPipeline.d.ts.map