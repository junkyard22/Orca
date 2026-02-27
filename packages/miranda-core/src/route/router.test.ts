/**
 * Miranda Core — Router Fallback Logic Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Router } from "./router.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { HealthTracker } from "./health.js";
import type { StageConfig, ModelSpec } from "../pipeline/types.js";

function createTestStageConfig(models: ModelSpec[]): StageConfig {
  return {
    models,
    maxRetriesPerModel: 3,
    maxTotalAttempts: 6,
    baseTemperature: 0.4,
    maxTokens: 2048,
    timeoutMs: 60_000,
  };
}

const MODEL_A: ModelSpec = { id: "model-a", label: "Model A" };
const MODEL_B: ModelSpec = { id: "model-b", label: "Model B" };
const MODEL_C: ModelSpec = { id: "model-c", label: "Model C" };

describe("Router", () => {
  let circuitBreaker: CircuitBreaker;
  let healthTracker: HealthTracker;
  let router: Router;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 300_000,
      cooldownMs: 60_000,
    });
    healthTracker = new HealthTracker();
    router = new Router(circuitBreaker, healthTracker);
  });

  it("selects the primary model first", () => {
    const config = createTestStageConfig([MODEL_A, MODEL_B, MODEL_C]);
    const result = router.selectModel("plan", config);

    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("model-a");
    expect(result!.isEscalation).toBe(false);
  });

  it("skips circuit-broken models", () => {
    // Trip the circuit breaker for model-a
    circuitBreaker.recordFailure("model-a");
    circuitBreaker.recordFailure("model-a");
    circuitBreaker.recordFailure("model-a");

    const config = createTestStageConfig([MODEL_A, MODEL_B, MODEL_C]);
    const result = router.selectModel("plan", config);

    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("model-b");
    expect(result!.isEscalation).toBe(true);
  });

  it("traverses the full fallback ladder", () => {
    const config = createTestStageConfig([MODEL_A, MODEL_B, MODEL_C]);

    // Select model-a first
    const r1 = router.selectModel("plan", config);
    expect(r1!.model.id).toBe("model-a");

    // Exclude model-a, should get model-b
    const r2 = router.selectModel("plan", config, new Set(["model-a"]));
    expect(r2!.model.id).toBe("model-b");
    expect(r2!.isEscalation).toBe(true);

    // Exclude model-a and model-b, should get model-c
    const r3 = router.selectModel(
      "plan",
      config,
      new Set(["model-a", "model-b"])
    );
    expect(r3!.model.id).toBe("model-c");
    expect(r3!.isEscalation).toBe(true);
  });

  it("returns null when all models are exhausted", () => {
    const config = createTestStageConfig([MODEL_A, MODEL_B]);
    const result = router.selectModel(
      "plan",
      config,
      new Set(["model-a", "model-b"])
    );

    expect(result).toBeNull();
  });

  it("returns null when all models are circuit-broken", () => {
    // Trip breakers for all models
    for (let i = 0; i < 3; i++) {
      circuitBreaker.recordFailure("model-a");
      circuitBreaker.recordFailure("model-b");
    }

    const config = createTestStageConfig([MODEL_A, MODEL_B]);
    const result = router.selectModel("plan", config);

    expect(result).toBeNull();
  });

  it("records success and resets circuit breaker", () => {
    // Trip breaker
    circuitBreaker.recordFailure("model-a");
    circuitBreaker.recordFailure("model-a");
    circuitBreaker.recordFailure("model-a");
    expect(circuitBreaker.isAvailable("model-a")).toBe(false);

    // Record success resets it
    router.recordSuccess("model-a");
    expect(circuitBreaker.isAvailable("model-a")).toBe(true);
  });

  it("records failure in both circuit breaker and health tracker", () => {
    router.recordFailure("model-a", "timeout");

    expect(circuitBreaker.getFailureCount("model-a")).toBe(1);
    const health = healthTracker.getStatus("model-a");
    expect(health.failures).toBe(1);
    expect(health.lastError).toBe("timeout");
  });
});

describe("CircuitBreaker", () => {
  it("allows calls when under threshold", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 300_000,
      cooldownMs: 60_000,
    });

    cb.recordFailure("model-a");
    cb.recordFailure("model-a");
    expect(cb.isAvailable("model-a")).toBe(true);
  });

  it("trips when threshold is reached", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 300_000,
      cooldownMs: 60_000,
    });

    cb.recordFailure("model-a");
    cb.recordFailure("model-a");
    cb.recordFailure("model-a");
    expect(cb.isAvailable("model-a")).toBe(false);
  });

  it("resets after cooldown", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      windowMs: 300_000,
      cooldownMs: 10, // 10ms cooldown for testing
    });

    cb.recordFailure("model-a");
    cb.recordFailure("model-a");
    expect(cb.isAvailable("model-a")).toBe(false);

    // Wait for cooldown
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.isAvailable("model-a")).toBe(true);
        resolve();
      }, 20);
    });
  });

  it("reports unknown models as available", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 300_000,
      cooldownMs: 60_000,
    });

    expect(cb.isAvailable("never-seen-model")).toBe(true);
  });
});
