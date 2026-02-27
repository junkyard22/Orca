/**
 * Miranda Core — Stage Executor
 * Executes a single pipeline stage through the repair loop with model escalation.
 */
import type { LLMAdapter } from "../llm/adapter.js";
import type { StageKind, StageConfig, StageResult, LLMMessage } from "../pipeline/types.js";
import { Router } from "../route/router.js";
export interface StageExecutionContext {
    adapter: LLMAdapter;
    router: Router;
    stageConfig: StageConfig;
    pricingTable: Record<string, import("../pipeline/types.js").ModelPricing>;
    verbose: boolean;
}
/**
 * Execute a single stage through the full repair loop + model escalation.
 *
 * 1. Select model from router
 * 2. Send prompt, validate response
 * 3. If invalid: repair loop (up to maxRetriesPerModel)
 * 4. If still invalid: escalate to next model
 * 5. Cap total attempts at maxTotalAttempts
 */
export declare function executeStage(stage: StageKind, initialMessages: LLMMessage[], ctx: StageExecutionContext): Promise<StageResult>;
//# sourceMappingURL=stage.d.ts.map