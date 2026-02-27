/**
 * Miranda Core — Router
 * Selects models for stages respecting circuit breaker state and fallback ladder.
 */
export class Router {
    circuitBreaker;
    healthTracker;
    constructor(circuitBreaker, healthTracker) {
        this.circuitBreaker = circuitBreaker;
        this.healthTracker = healthTracker;
    }
    /**
     * Get the circuit breaker instance (for external recording).
     */
    getCircuitBreaker() {
        return this.circuitBreaker;
    }
    /**
     * Get the health tracker instance (for external recording).
     */
    getHealthTracker() {
        return this.healthTracker;
    }
    /**
     * Select the next available model for a stage.
     * Walks through the fallback ladder, skipping circuit-broken models.
     *
     * @param stage - The stage kind
     * @param stageConfig - Config for this stage (contains model list)
     * @param excludeModels - Models to skip (already tried and failed for this stage)
     * @returns RouterResult with model and whether it's an escalation, or null if all exhausted
     */
    selectModel(_stage, stageConfig, excludeModels = new Set()) {
        const models = stageConfig.models;
        for (let i = 0; i < models.length; i++) {
            const model = models[i];
            if (!model)
                continue;
            // Skip excluded models (already tried for this stage)
            if (excludeModels.has(model.id))
                continue;
            // Skip circuit-broken models
            if (!this.circuitBreaker.isAvailable(model.id))
                continue;
            return {
                model,
                isEscalation: i > 0,
            };
        }
        return null;
    }
    /**
     * Record a successful call result for this model.
     */
    recordSuccess(modelId) {
        this.circuitBreaker.recordSuccess(modelId);
        this.healthTracker.recordSuccess(modelId);
    }
    /**
     * Record a failed call result for this model.
     */
    recordFailure(modelId, error) {
        this.circuitBreaker.recordFailure(modelId);
        this.healthTracker.recordFailure(modelId, error);
    }
}
//# sourceMappingURL=router.js.map