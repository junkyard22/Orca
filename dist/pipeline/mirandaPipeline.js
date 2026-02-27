/**
 * Miranda Core — Miranda Pipeline
 * Sequential orchestrator: PLAN → ANSWER → CRITIQUE → REWRITE
 * with budget controls and JSONL logging.
 */
import { randomUUID } from "node:crypto";
import { STAGE_ORDER } from "../pipeline/types.js";
import { buildPlanSystemPrompt } from "../contracts/plan.js";
import { buildAnswerSystemPrompt } from "../contracts/answer.js";
import { buildCritiqueSystemPrompt } from "../contracts/critique.js";
import { buildRewriteSystemPrompt } from "../contracts/rewrite.js";
import { executeStage } from "./stage.js";
import { Router } from "../route/router.js";
import { CircuitBreaker } from "../route/circuitBreaker.js";
import { HealthTracker } from "../route/health.js";
import { appendRunLog, getRunSummary } from "../metrics/runStore.js";
/**
 * Build the initial LLM messages for a given stage.
 */
function buildStageMessages(stage, userPrompt, stageOutputs) {
    switch (stage) {
        case "plan":
            return [
                { role: "system", content: buildPlanSystemPrompt(userPrompt) },
                { role: "user", content: userPrompt },
            ];
        case "answer": {
            const planOutput = stageOutputs.get("plan") ?? "{}";
            return [
                { role: "system", content: buildAnswerSystemPrompt(userPrompt, planOutput) },
                { role: "user", content: userPrompt },
            ];
        }
        case "critique": {
            const answerOutput = stageOutputs.get("answer") ?? "";
            return [
                {
                    role: "system",
                    content: buildCritiqueSystemPrompt(userPrompt, answerOutput),
                },
                { role: "user", content: "Critique the answer above." },
            ];
        }
        case "rewrite": {
            const answerOutput = stageOutputs.get("answer") ?? "";
            const critiqueOutput = stageOutputs.get("critique") ?? "{}";
            return [
                {
                    role: "system",
                    content: buildRewriteSystemPrompt(userPrompt, answerOutput, critiqueOutput),
                },
                { role: "user", content: "Rewrite and improve the answer based on the critique." },
            ];
        }
        default:
            throw new Error(`Unknown stage: ${stage}`);
    }
}
/**
 * Run the full Miranda pipeline for a user prompt.
 *
 * Stages run sequentially: PLAN → ANSWER → CRITIQUE → REWRITE.
 * Budget is tracked across stages. If exceeded, CRITIQUE + REWRITE are skipped (lite mode).
 */
export async function runPipeline(userPrompt, adapter, config) {
    const runId = randomUUID();
    const startTime = Date.now();
    if (config.verbose) {
        console.error(`\n[Miranda] Run ${runId} started`);
        console.error(`[Miranda] Prompt: "${userPrompt.slice(0, 80)}..."`);
    }
    const circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    const healthTracker = new HealthTracker();
    const router = new Router(circuitBreaker, healthTracker);
    const stageResults = [];
    const stageOutputs = new Map();
    let totalCost = 0;
    let budgetExceeded = false;
    let liteMode = false;
    for (const stage of STAGE_ORDER) {
        // Budget check before CRITIQUE and REWRITE
        if ((stage === "critique" || stage === "rewrite") && totalCost >= config.budgetUsd) {
            budgetExceeded = true;
            liteMode = true;
            if (config.verbose) {
                console.error(`[Miranda] Budget exceeded ($${totalCost.toFixed(6)} >= $${config.budgetUsd}). Skipping ${stage}.`);
            }
            // Add a skipped stage result
            stageResults.push({
                stage,
                success: false,
                finalOutput: "",
                parsedData: null,
                attempts: [],
                modelUsed: "skipped",
                totalCost: 0,
            });
            continue;
        }
        const stageConfig = config.stages[stage];
        const messages = buildStageMessages(stage, userPrompt, stageOutputs);
        const ctx = {
            adapter,
            router,
            stageConfig,
            pricingTable: config.pricing,
            verbose: config.verbose,
        };
        if (config.verbose) {
            console.error(`\n[Miranda] === Stage: ${stage.toUpperCase()} ===`);
        }
        const result = await executeStage(stage, messages, ctx);
        stageResults.push(result);
        totalCost += result.totalCost;
        if (result.success) {
            stageOutputs.set(stage, result.finalOutput);
        }
        else {
            if (config.verbose) {
                console.error(`[Miranda] Stage "${stage}" failed after all attempts.`);
            }
            // Store whatever we got so downstream stages have something
            stageOutputs.set(stage, result.finalOutput || "(stage failed)");
        }
    }
    const totalDurationMs = Date.now() - startTime;
    const record = {
        runId,
        timestamp: new Date().toISOString(),
        userPrompt,
        stages: stageResults,
        totalCost,
        totalDurationMs,
        budgetExceeded,
        liteMode,
    };
    // Persist to JSONL log
    try {
        appendRunLog(record, config.logPath);
    }
    catch (err) {
        if (config.verbose) {
            console.error(`[Miranda] Failed to write run log: ${err}`);
        }
    }
    const summary = getRunSummary(record);
    if (config.verbose) {
        console.error(`\n[Miranda] Run complete. Cost: $${totalCost.toFixed(6)}, Duration: ${totalDurationMs}ms`);
    }
    return { record, summary };
}
//# sourceMappingURL=mirandaPipeline.js.map