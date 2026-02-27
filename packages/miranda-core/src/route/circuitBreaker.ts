/**
 * Miranda Core — Circuit Breaker
 * Tracks failure counts per model and disables models exceeding threshold.
 */

import type { CircuitBreakerConfig } from "../pipeline/types.js";

interface FailureRecord {
  timestamp: number;
}

interface BreakerState {
  failures: FailureRecord[];
  trippedAt: number | null;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly state: Map<string, BreakerState> = new Map();

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /**
   * Record a failure for a model.
   */
  recordFailure(modelId: string): void {
    const breaker = this.getOrCreateState(modelId);
    breaker.failures.push({ timestamp: Date.now() });

    // Prune old failures outside the window
    this.pruneOldFailures(breaker);

    // Check if we should trip the breaker
    if (breaker.failures.length >= this.config.failureThreshold) {
      breaker.trippedAt = Date.now();
    }
  }

  /**
   * Record a success for a model (resets failure count).
   */
  recordSuccess(modelId: string): void {
    const breaker = this.getOrCreateState(modelId);
    breaker.failures = [];
    breaker.trippedAt = null;
  }

  /**
   * Check if a model is currently available (not tripped or cooled down).
   */
  isAvailable(modelId: string): boolean {
    const breaker = this.state.get(modelId);
    if (!breaker) return true;

    if (breaker.trippedAt === null) return true;

    // Check if cooldown has elapsed
    const elapsed = Date.now() - breaker.trippedAt;
    if (elapsed >= this.config.cooldownMs) {
      // Reset breaker — allow a new attempt
      breaker.trippedAt = null;
      breaker.failures = [];
      return true;
    }

    return false;
  }

  /**
   * Get the current failure count for a model.
   */
  getFailureCount(modelId: string): number {
    const breaker = this.state.get(modelId);
    if (!breaker) return 0;
    this.pruneOldFailures(breaker);
    return breaker.failures.length;
  }

  /**
   * Reset all breaker state (useful for testing).
   */
  reset(): void {
    this.state.clear();
  }

  private getOrCreateState(modelId: string): BreakerState {
    let breaker = this.state.get(modelId);
    if (!breaker) {
      breaker = { failures: [], trippedAt: null };
      this.state.set(modelId, breaker);
    }
    return breaker;
  }

  private pruneOldFailures(breaker: BreakerState): void {
    const cutoff = Date.now() - this.config.windowMs;
    breaker.failures = breaker.failures.filter((f) => f.timestamp >= cutoff);
  }
}
