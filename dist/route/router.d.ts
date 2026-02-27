/**
 * Miranda Core — Router
 * Selects models for stages respecting circuit breaker state and fallback ladder.
 */
import type { StageKind, StageConfig, ModelSpec } from "../pipeline/types.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { HealthTracker } from "./health.js";
export interface RouterResult {
    model: ModelSpec;
    isEscalation: boolean;
}
export declare class Router {
    private readonly circuitBreaker;
    private readonly healthTracker;
    constructor(circuitBreaker: CircuitBreaker, healthTracker: HealthTracker);
    /**
     * Get the circuit breaker instance (for external recording).
     */
    getCircuitBreaker(): CircuitBreaker;
    /**
     * Get the health tracker instance (for external recording).
     */
    getHealthTracker(): HealthTracker;
    /**
     * Select the next available model for a stage.
     * Walks through the fallback ladder, skipping circuit-broken models.
     *
     * @param stage - The stage kind
     * @param stageConfig - Config for this stage (contains model list)
     * @param excludeModels - Models to skip (already tried and failed for this stage)
     * @returns RouterResult with model and whether it's an escalation, or null if all exhausted
     */
    selectModel(_stage: StageKind, stageConfig: StageConfig, excludeModels?: Set<string>): RouterResult | null;
    /**
     * Record a successful call result for this model.
     */
    recordSuccess(modelId: string): void;
    /**
     * Record a failed call result for this model.
     */
    recordFailure(modelId: string, error: string): void;
}
//# sourceMappingURL=router.d.ts.map