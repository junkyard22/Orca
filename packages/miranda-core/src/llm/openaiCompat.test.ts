import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatAdapter } from "./openaiCompat.js";

const originalFetch = globalThis.fetch;

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAICompatAdapter reasoning_content fallback", () => {
  it("uses reasoning_content when content is empty in complete()", async () => {
    globalThis.fetch = vi.fn(async () =>
      createJsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "Reasoned answer",
            },
            finish_reason: "stop",
          },
        ],
        model: "test-model",
      }),
    ) as typeof fetch;

    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
    });

    const result = await adapter.complete({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 128,
      temperature: 0,
    });

    expect(result.content).toBe("Reasoned answer");
  });

  it("uses streamed reasoning_content when content deltas are empty", async () => {
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Step one"}}],"model":"test-model"}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" and done"}}],"model":"test-model"}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as typeof fetch;

    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
    });
    const onToken = vi.fn();

    const result = await adapter.stream(
      {
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 128,
        temperature: 0,
      },
      onToken,
    );

    expect(result.content).toBe("Step one and done");
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, "Step one");
    expect(onToken).toHaveBeenNthCalledWith(2, " and done");
  });
});

describe("OpenAICompatAdapter context-cache usage reporting", () => {
  function completeWithUsage(usage: unknown) {
    globalThis.fetch = vi.fn(async () =>
      createJsonResponse({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        model: "test-model",
        usage,
      }),
    ) as typeof fetch;

    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
    });

    return adapter.complete({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 128,
      temperature: 0,
    });
  }

  it("reports cached prompt tokens when the provider returns prompt_tokens_details", async () => {
    const result = await completeWithUsage({
      prompt_tokens: 1500,
      completion_tokens: 20,
      total_tokens: 1520,
      prompt_tokens_details: { cached_tokens: 1024 },
    });

    expect(result.usage?.promptTokens).toBe(1500);
    expect(result.usage?.cachedPromptTokens).toBe(1024);
  });

  it("distinguishes a reported zero-token cache miss from an absent field", async () => {
    const miss = await completeWithUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(miss.usage?.cachedPromptTokens).toBe(0);

    // Providers without context caching omit the field entirely.  That must stay
    // undefined rather than collapsing to 0, so cache-hit ratios are not
    // computed against providers that never report the metric.
    const notReported = await completeWithUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
    });
    expect(notReported.usage?.cachedPromptTokens).toBeUndefined();
    expect("cachedPromptTokens" in (notReported.usage ?? {})).toBe(false);
  });
});
