import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPipelineMock } = vi.hoisted(() => ({
  runPipelineMock: vi.fn(),
}));

vi.mock("@clawde/miranda-core", () => ({
  runPipeline: runPipelineMock,
}));

import { createMirandaLLMService } from "./mirandaLLM.js";

describe("createMirandaLLMService", () => {
  beforeEach(() => {
    runPipelineMock.mockReset();
  });

  it("falls back to the last non-empty stage output when validation failed", async () => {
    runPipelineMock.mockResolvedValue({
      record: {
        stages: [
          {
            stage: "plan",
            success: false,
            finalOutput: "## Plan\nOutline",
          },
          {
            stage: "answer",
            success: false,
            finalOutput: "## Answer\nRecovered answer",
          },
          {
            stage: "rewrite",
            success: false,
            finalOutput: "",
          },
        ],
      },
    });

    const service = createMirandaLLMService({} as never, {
      stages: {
        answer: { maxTokens: 256 },
        rewrite: { maxTokens: 256 },
      },
    } as never);

    const result = await service.complete("prompt");

    expect(result.text).toBe("Recovered answer");
  });

  it("still prefers successful stages over fallback output", async () => {
    runPipelineMock.mockResolvedValue({
      record: {
        stages: [
          {
            stage: "answer",
            success: false,
            finalOutput: "## Answer\nDraft answer",
          },
          {
            stage: "rewrite",
            success: true,
            finalOutput: "## Answer\nFinal answer",
          },
        ],
      },
    });

    const service = createMirandaLLMService({} as never, {
      stages: {
        answer: { maxTokens: 256 },
        rewrite: { maxTokens: 256 },
      },
    } as never);

    const result = await service.complete("prompt");

    expect(result.text).toBe("Final answer");
  });
});
