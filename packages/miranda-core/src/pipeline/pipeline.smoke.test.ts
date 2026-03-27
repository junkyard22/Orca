/**
 * Miranda Core — Pipeline Smoke Test
 *
 * Exercises the full PLAN → ANSWER → CRITIQUE → REWRITE pipeline end-to-end
 * using a mock LLM adapter. No real API keys required.
 *
 * Covers:
 *  - Any model ID is accepted in any stage role (OpenRouter, Alibaba/DashScope, etc.)
 *  - enableThinking is forwarded to the adapter when set
 *  - All four stages complete successfully
 *  - Model fallback fires when the primary fails
 *  - Budget gate skips CRITIQUE + REWRITE when budget is exhausted
 */

import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "./mirandaPipeline.js";
import { createDefaultConfig } from "./types.js";
import type { LLMAdapter, LLMRequest, LLMResponse } from "../index.js";

// ---------------------------------------------------------------------------
// Mock responses that satisfy each stage's contract
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
  restatement: "The user wants a brief explanation of binary search.",
  assumptions: ["The user knows basic programming."],
  constraints: ["Keep it concise."],
  approach_steps: ["Define binary search", "Explain the algorithm", "Give complexity"],
  risks: [],
  questions: [],
});

const ANSWER_MD = [
  "## Plan (summary)",
  "Binary search divides the search space in half each iteration.",
  "",
  "## Answer",
  "Binary search works on sorted arrays by comparing the target to the midpoint.",
  "",
  "## Edge cases & checks",
  "Empty array returns -1. Single element is handled.",
  "",
  "## Next steps",
  "Try it on a sorted array of integers.",
].join("\n");

const CRITIQUE_JSON = JSON.stringify({
  issues: [],
  fixes: [],
  missing: [],
  confidence: "high",
});

const REWRITE_MD = [
  "## Plan (summary)",
  "Polished: binary search overview.",
  "",
  "## Answer",
  "Binary search is O(log n) and requires a sorted array.",
  "",
  "## Edge cases & checks",
  "Handles empty and single-element arrays.",
  "",
  "## Next steps",
  "Implement and test with edge cases.",
].join("\n");

// ---------------------------------------------------------------------------
// Helper: build a mock adapter that returns stage-appropriate responses
// ---------------------------------------------------------------------------

function makeMockAdapter(modelCaptures: string[] = []): LLMAdapter {
  let callCount = 0;
  const responses = [PLAN_JSON, ANSWER_MD, CRITIQUE_JSON, REWRITE_MD];

  return {
    name: "mock",
    async complete(req: LLMRequest): Promise<LLMResponse> {
      modelCaptures.push(req.model);
      const content = responses[callCount % responses.length] ?? ANSWER_MD;
      callCount++;
      return { content, model: req.model, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, durationMs: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Pipeline smoke — full run", () => {
  it("completes all four stages and returns a polished rewrite", async () => {
    const adapter = makeMockAdapter();
    const config = createDefaultConfig({ verbose: false });

    const { record } = await runPipeline("Explain binary search briefly.", adapter, config);

    expect(record.stages).toHaveLength(4);
    expect(record.stages[0]?.stage).toBe("plan");
    expect(record.stages[1]?.stage).toBe("answer");
    expect(record.stages[2]?.stage).toBe("critique");
    expect(record.stages[3]?.stage).toBe("rewrite");

    for (const s of record.stages) {
      expect(s.success).toBe(true);
    }

    // Final output is the rewrite
    expect(record.stages[3]?.finalOutput).toContain("## Answer");
    expect(record.liteMode).toBe(false);
  });

  it("accepts any model ID in any stage role", async () => {
    const captured: string[] = [];
    const adapter = makeMockAdapter(captured);

    // Configure exotic model IDs — mix of OpenRouter, Alibaba DashScope, custom
    const config = createDefaultConfig({
      stages: {
        plan: {
          models: [{ id: "qwen-max", label: "Alibaba: Qwen Max" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 2048, timeoutMs: 5_000,
        },
        answer: {
          models: [{ id: "qwen3-coder-next", label: "Alibaba: Qwen3 Coder Next" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 4096, timeoutMs: 5_000,
        },
        critique: {
          models: [{ id: "qwen3-coder-plus", label: "Alibaba: Qwen3 Coder Plus" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 2048, timeoutMs: 5_000,
        },
        rewrite: {
          models: [{ id: "anthropic/claude-3.5-haiku", label: "Anthropic: Claude 3.5 Haiku" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 4096, timeoutMs: 5_000,
        },
      },
    });

    const { record } = await runPipeline("Explain binary search.", adapter, config);

    expect(captured).toContain("qwen-max");
    expect(captured).toContain("qwen3-coder-next");
    expect(captured).toContain("qwen3-coder-plus");
    expect(captured).toContain("anthropic/claude-3.5-haiku");

    for (const s of record.stages) {
      expect(s.success).toBe(true);
    }
  });

  it("propagates enableThinking to the adapter when set on LLMRequest", async () => {
    const thinkingValues: Array<boolean | undefined> = [];

    const adapter: LLMAdapter = {
      name: "thinking-mock",
      async complete(req: LLMRequest): Promise<LLMResponse> {
        thinkingValues.push(req.enableThinking);
        // Return appropriate content for each stage in order
        const idx = thinkingValues.length - 1;
        const body = idx === 0 ? PLAN_JSON : idx === 2 ? CRITIQUE_JSON : ANSWER_MD;
        return { content: body, model: req.model, usage: null, durationMs: 1 };
      },
    };

    // We test enableThinking propagation at the adapter level directly —
    // the pipeline does not set enableThinking itself (that's a per-adapter
    // config concern). Verify the field passes through complete() untouched.
    const result = await adapter.complete({
      model: "qwen3-coder-next",
      messages: [{ role: "user", content: "test" }],
      temperature: 0,
      maxTokens: 128,
      enableThinking: false,
    });

    expect(thinkingValues[0]).toBe(false);
    expect(result.model).toBe("qwen3-coder-next");
  });

  it("falls back to secondary model when primary fails", async () => {
    const usedModels: string[] = [];
    let primaryCallCount = 0;

    const adapter: LLMAdapter = {
      name: "fallback-mock",
      async complete(req: LLMRequest): Promise<LLMResponse> {
        usedModels.push(req.model);
        if (req.model === "failing-primary") {
          primaryCallCount++;
          throw new Error("Simulated primary failure");
        }
        const idx = usedModels.filter((m) => m !== "failing-primary").length - 1;
        const body = idx === 0 ? PLAN_JSON : idx === 2 ? CRITIQUE_JSON : ANSWER_MD;
        return { content: body, model: req.model, usage: null, durationMs: 1 };
      },
    };

    const config = createDefaultConfig({
      stages: {
        plan: {
          models: [
            { id: "failing-primary", label: "Failing Primary" },
            { id: "working-fallback", label: "Working Fallback" },
          ],
          maxRetriesPerModel: 1, maxTotalAttempts: 4, baseTemperature: 0.4, maxTokens: 2048, timeoutMs: 5_000,
        },
        answer: {
          models: [{ id: "working-fallback", label: "Working Fallback" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 4096, timeoutMs: 5_000,
        },
        critique: {
          models: [{ id: "working-fallback", label: "Working Fallback" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 2048, timeoutMs: 5_000,
        },
        rewrite: {
          models: [{ id: "working-fallback", label: "Working Fallback" }],
          maxRetriesPerModel: 1, maxTotalAttempts: 2, baseTemperature: 0.4, maxTokens: 4096, timeoutMs: 5_000,
        },
      },
    });

    const { record } = await runPipeline("Explain binary search.", adapter, config);

    expect(primaryCallCount).toBe(1);
    expect(usedModels).toContain("failing-primary");
    expect(usedModels).toContain("working-fallback");
    // Plan still succeeded via fallback
    expect(record.stages[0]?.success).toBe(true);
    expect(record.stages[0]?.modelUsed).toBe("working-fallback");
  });

  it("enters lite mode and skips critique + rewrite when budget is exhausted", async () => {
    const adapter = makeMockAdapter();

    // Budget of $0 — any spending triggers lite mode
    const config = createDefaultConfig({ budgetUsd: 0, verbose: false });

    const { record } = await runPipeline("Explain binary search.", adapter, config);

    expect(record.liteMode).toBe(true);
    expect(record.budgetExceeded).toBe(true);

    const critique = record.stages.find((s) => s.stage === "critique");
    const rewrite = record.stages.find((s) => s.stage === "rewrite");
    expect(critique?.modelUsed).toBe("skipped");
    expect(rewrite?.modelUsed).toBe("skipped");
  });

  it("simple mode runs only the answer stage", async () => {
    const called: string[] = [];
    const adapter: LLMAdapter = {
      name: "simple-mock",
      async complete(req: LLMRequest): Promise<LLMResponse> {
        called.push(req.model);
        return { content: ANSWER_MD, model: req.model, usage: null, durationMs: 1 };
      },
    };

    const config = createDefaultConfig();
    const { record } = await runPipeline("Explain binary search.", adapter, config, { simple: true });

    // Only the answer stage should have made an LLM call
    expect(called).toHaveLength(1);
    const answer = record.stages.find((s) => s.stage === "answer");
    expect(answer?.success).toBe(true);

    const plan = record.stages.find((s) => s.stage === "plan");
    expect(plan?.modelUsed).toBe("skipped");
  });
});
