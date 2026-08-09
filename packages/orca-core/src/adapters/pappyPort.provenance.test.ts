import { describe, expect, it } from "vitest";
import type { PappyInput } from "@clawde/pappy-core";
import { createPappyPort } from "./pappyPort.js";

function cleanInput(overrides: Partial<PappyInput> = {}): PappyInput {
  return {
    task: "Explain what recursion means.",
    outputText: "Recursion is a function calling itself. This is a detailed explanation of how recursion works in programming.",
    toolEvents: [{ tool: "read_file", ok: true, summary: "context read" }],
    ...overrides,
  };
}

describe("PappyPort — model review provenance", () => {
  it("marks deterministic-only Pappy verification as not applicable to model independence", () => {
    const result = createPappyPort().evaluate(cleanInput());

    expect(result.verdict).toBe("PASS");
    expect(result.trainingEligibility).toBe("eligible");
    expect(result.reviewIndependence).toMatchObject({
      status: "not_applicable",
      fallbackUsed: false,
      independentRequired: false,
    });
    expect(result.internalSummary).toContain("review_independence=not_applicable");
  });

  it("detects a reviewer that resolves to the producer's exact model", () => {
    const result = createPappyPort().evaluate(cleanInput({
      metadata: {
        modelReview: {
          producer: { role: "strong_model", provider: "openrouter", model: "qwen/qwen3-coder" },
          reviewer: { role: "reviewer", provider: "openrouter", model: "qwen/qwen3-coder" },
        },
      },
    }));

    expect(result.verdict).toBe("PASS");
    expect(result.reviewIndependence?.status).toBe("self_review");
    expect(result.trainingEligibility).toBe("accepted_but_not_trainable");
  });

  it("detects common provider aliases for the same underlying model", () => {
    const result = createPappyPort().evaluate(cleanInput({
      metadata: {
        modelReview: {
          producer: { provider: "openrouter", model: "openai/gpt-4o" },
          reviewer: { provider: "openai", model: "gpt-4o" },
        },
      },
    }));

    expect(result.reviewIndependence?.status).toBe("self_review");
    expect(result.trainingEligibility).toBe("accepted_but_not_trainable");
  });

  it("fails closed when fallback occurred but actual reviewer identity is missing", () => {
    const result = createPappyPort().evaluate(cleanInput({
      metadata: {
        modelReview: {
          producer: { provider: "openrouter", model: "qwen/qwen3-coder" },
          fallbackUsed: true,
          independentRequired: true,
        },
      },
    }));

    expect(result.verdict).toBe("PASS");
    expect(result.reviewIndependence?.status).toBe("unknown");
    expect(result.reviewIndependence?.fallbackUsed).toBe(true);
    expect(result.trainingEligibility).toBe("needs_human_review");
    expect(result.internalSummary).toContain("review_fallback=true");
  });

  it("allows a fallback that resolves to a different actual model", () => {
    const result = createPappyPort().evaluate(cleanInput({
      metadata: {
        modelReview: {
          producer: { provider: "openrouter", model: "qwen/qwen3-coder" },
          reviewer: { provider: "openrouter", model: "deepseek/deepseek-chat" },
          fallbackUsed: true,
          independentRequired: true,
        },
      },
    }));

    expect(result.reviewIndependence).toMatchObject({
      status: "independent",
      fallbackUsed: true,
      independentRequired: true,
    });
    expect(result.trainingEligibility).toBe("eligible");
  });

  it("never weakens an existing rejected training decision", () => {
    const result = createPappyPort().evaluate({
      task: "Update config.ts.",
      outputText: "I updated `config.ts` with the new setting.",
      metadata: {
        modelReview: {
          producer: { provider: "openrouter", model: "qwen/qwen3-coder" },
          reviewer: { provider: "openrouter", model: "qwen/qwen3-coder" },
        },
      },
    });

    expect(result.trainingEligibility).toBe("rejected");
    expect(result.reviewIndependence?.status).toBe("self_review");
  });
});
