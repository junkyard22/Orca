/**
 * Miranda Core — Circuit Breaker
 * Tracks failure counts per model and disables models exceeding threshold.
 */
import type { CircuitBreakerConfig } from "../pipeline/types.js";
export declare class CircuitBreaker {
    private readonly config;
    private readonly state;
    constructor(config: CircuitBreakerConfig);
    /**
     * Record a failure for a model.
     */
    recordFailure(modelId: string): void;
    /**
     * Record a success for a model (resets failure count).
     */
    recordSuccess(modelId: string): void;
    /**
     * Check if a model is currently available (not tripped or cooled down).
     */
    isAvailable(modelId: string): boolean;
    /**
     * Get the current failure count for a model.
     */
    getFailureCount(modelId: string): number;
    /**
     * Reset all breaker state (useful for testing).
     */
    reset(): void;
    private getOrCreateState;
    private pruneOldFailures;
}
//# sourceMappingURL=circuitBreaker.d.ts.map