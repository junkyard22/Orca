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

describe("OpenAICompatAdapter streaming usage reporting", () => {
  function makeAdapter(config: { includeStreamUsage?: boolean } = {}) {
    return new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
      ...config,
    });
  }

  function streamRequest() {
    return {
      messages: [{ role: "user" as const, content: "hello" }],
      maxTokens: 128,
      temperature: 0,
    };
  }

  function lastRequestBody(): Record<string, unknown> {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = mock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it("asks the provider for a usage chunk by default", async () => {
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse(["data: [DONE]\n\n"]),
    ) as typeof fetch;

    await makeAdapter().stream(streamRequest(), vi.fn());

    expect(lastRequestBody()["stream_options"]).toEqual({ include_usage: true });
  });

  it("omits stream_options when the endpoint opts out", async () => {
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse(["data: [DONE]\n\n"]),
    ) as typeof fetch;

    await makeAdapter({ includeStreamUsage: false }).stream(streamRequest(), vi.fn());

    expect("stream_options" in lastRequestBody()).toBe(false);
  });

  it("reports cached prompt tokens from the terminal usage chunk", async () => {
    // The usage chunk arrives with an empty `choices` array, just before [DONE].
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}],"model":"test-model"}\n\n',
        'data: {"choices":[],"model":"test-model","usage":{"prompt_tokens":1500,' +
          '"completion_tokens":20,"total_tokens":1520,' +
          '"prompt_tokens_details":{"cached_tokens":1024}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as typeof fetch;

    const result = await makeAdapter().stream(streamRequest(), vi.fn());

    expect(result.content).toBe("hi");
    expect(result.usage?.promptTokens).toBe(1500);
    expect(result.usage?.completionTokens).toBe(20);
    expect(result.usage?.totalTokens).toBe(1520);
    expect(result.usage?.cachedPromptTokens).toBe(1024);
  });

  it("prefers reported completion tokens over the streamed delta count", async () => {
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse([
        'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" two"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":7,"total_tokens":47}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as typeof fetch;

    const result = await makeAdapter().stream(streamRequest(), vi.fn());

    // Two deltas arrived, but the provider counted seven completion tokens.
    expect(result.usage?.completionTokens).toBe(7);
    expect(result.usage?.cachedPromptTokens).toBeUndefined();
  });

  it("keeps usage unknown when no provider usage chunk arrives (SSE deltas are not tokens)", async () => {
    globalThis.fetch = vi.fn(async () =>
      createStreamResponse([
        'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" two"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as typeof fetch;

    const result = await makeAdapter().stream(streamRequest(), vi.fn());

    expect(result.usage).toBeNull();
  });

  it("emits streamed cache metrics on the ORCA_PROFILE llm_call event", async () => {
    // Every live agent-loop stage streams, so the profile run only sees cache
    // data at all if the stream path emits it.
    const events: Array<Record<string, unknown>> = [];
    const globals = globalThis as typeof globalThis & {
      __orcaProfileEmit?: (e: Record<string, unknown>) => void;
    };
    const previousEmit = globals.__orcaProfileEmit;
    const previousFlag = process.env["ORCA_PROFILE"];
    globals.__orcaProfileEmit = (e) => { events.push(e); };
    process.env["ORCA_PROFILE"] = "1";

    try {
      globalThis.fetch = vi.fn(async () =>
        createStreamResponse([
          'data: {"choices":[{"delta":{"content":"hi"}}],"model":"test-model"}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":20,' +
            '"total_tokens":1520,"prompt_tokens_details":{"cached_tokens":1024}}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ) as typeof fetch;

      await makeAdapter().stream(streamRequest(), vi.fn());
    } finally {
      if (previousFlag === undefined) delete process.env["ORCA_PROFILE"];
      else process.env["ORCA_PROFILE"] = previousFlag;
      if (previousEmit === undefined) delete globals.__orcaProfileEmit;
      else globals.__orcaProfileEmit = previousEmit;
    }

    const llmCall = events.find((e) => e["phase"] === "llm_call");
    expect(llmCall?.["method"]).toBe("stream");
    expect(llmCall?.["promptTokens"]).toBe(1500);
    expect(llmCall?.["cachedPromptTokens"]).toBe(1024);
    expect(llmCall?.["usageReported"]).toBe(true);
  });
});

describe("OpenAICompatAdapter stream_options rejection fallback", () => {
  function makeAdapter() {
    return new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
    });
  }

  function streamRequest() {
    return {
      messages: [{ role: "user" as const, content: "hello" }],
      maxTokens: 128,
      temperature: 0,
    };
  }

  function bodyOfCall(n: number): Record<string, unknown> {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = mock.mock.calls[n]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  function streamOk(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  function badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: { message } }), { status: 400 });
  }

  it("retries without stream_options when the endpoint rejects it", async () => {
    // A strict endpoint 400s on the unknown field. Streaming is the live path,
    // so the call must still succeed — the cache metric is what gets dropped.
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? badRequest("unrecognized request argument: stream_options")
        : streamOk();
    }) as typeof fetch;

    const result = await makeAdapter().stream(streamRequest(), vi.fn());

    expect(call).toBe(2);
    expect(bodyOfCall(0)["stream_options"]).toEqual({ include_usage: true });
    expect("stream_options" in bodyOfCall(1)).toBe(false);
    expect(result.content).toBe("hi");
  });

  it("remembers the rejection so it costs one wasted request, not one per call", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? badRequest("unrecognized request argument: stream_options")
        : streamOk();
    }) as typeof fetch;

    const adapter = makeAdapter();
    await adapter.stream(streamRequest(), vi.fn());
    expect(call).toBe(2);

    // Second call must go straight out without the field — no second retry.
    await adapter.stream(streamRequest(), vi.fn());
    expect(call).toBe(3);
    expect("stream_options" in bodyOfCall(2)).toBe(false);
  });

  it("still surfaces a 400 that was not about stream_options", async () => {
    // The retry is a guess. When it was the wrong guess the error must still
    // reach the caller rather than being swallowed by the fallback.
    globalThis.fetch = vi.fn(async () =>
      badRequest("model not found"),
    ) as typeof fetch;

    await expect(makeAdapter().stream(streamRequest(), vi.fn())).rejects.toThrow(
      /model not found/,
    );
  });

  it("does not retry a non-400 failure", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return new Response("upstream exploded", { status: 500 });
    }) as typeof fetch;

    await expect(makeAdapter().stream(streamRequest(), vi.fn())).rejects.toThrow(
      /API error 500/,
    );
    expect(call).toBe(1);
  });
});

// ── Request-shape policy and error reporting (core reliability phase 3) ─────

function captureBodies(response: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return response();
  }) as typeof fetch;
  return calls;
}
const okJson = () => createJsonResponse({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const okStream = () => createStreamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
const policyRequest = {
  model: "",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.7,
  maxTokens: 8192,
};

describe("OpenAICompatAdapter temperature handling", () => {
  it("sends temperature by default (no supportsTemperature predicate)", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://example.test/v1", defaultModel: "m" });
    await adapter.complete(policyRequest);
    expect(calls[0].body.temperature).toBe(0.7);
  });

  it("omits temperature entirely in complete() when the model does not support it", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "no-temp-model",
      enableThinking: true,
      supportsTemperature: (model) => model !== "no-temp-model",
    });
    await adapter.complete(policyRequest);

    const { body, headers, url } = calls[0];
    expect("temperature" in body).toBe(false);
    expect(body.model).toBe("no-temp-model");
    expect(body.max_tokens).toBe(8192);
    expect(body.enable_thinking).toBe(true);
    expect(headers.Authorization).toBe("Bearer secret");
    expect(url).toBe("https://example.test/v1/chat/completions");
  });

  it("omits temperature in stream(), including on the stream_options retry", async () => {
    let first = true;
    const calls = captureBodies(() => {
      if (first) { first = false; return new Response("bad stream_options", { status: 400 }); }
      return okStream();
    });
    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "no-temp-model",
      supportsTemperature: () => false,
    });
    await adapter.stream(policyRequest, () => {});

    expect(calls).toHaveLength(2);
    for (const { body } of calls) {
      expect("temperature" in body).toBe(false);
      expect(body.max_tokens).toBe(8192);
      expect(body.stream).toBe(true);
    }
  });

  it("evaluates the predicate against the per-request model override", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({
      baseUrl: "https://example.test/v1",
      defaultModel: "temp-ok",
      supportsTemperature: (model) => model === "temp-ok",
    });
    await adapter.complete({ ...policyRequest, model: "no-temp-model" });
    await adapter.complete(policyRequest);
    expect("temperature" in calls[0].body).toBe(false);
    expect(calls[1].body.temperature).toBe(0.7);
  });

  it("streaming and completion send the same request shape apart from stream fields", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://example.test/v1", defaultModel: "m", enableThinking: false });
    await adapter.complete(policyRequest);
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { calls.push({ url: "", headers: {}, body: JSON.parse(String(init?.body)) }); return okStream(); }) as typeof fetch;
    await adapter.stream(policyRequest, () => {});
    const [c, s] = calls.map((x) => x.body);
    const { stream, stream_options, ...streamRest } = s as Record<string, unknown>;
    expect(stream).toBe(true);
    expect(stream_options).toEqual({ include_usage: true });
    expect(streamRest).toEqual(c);
  });
});

describe("OpenAICompatAdapter enable_thinking support flag", () => {
  it("omits enable_thinking for endpoints that do not support it, even when a request asks for it", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-6", enableThinking: true, supportsEnableThinking: false });
    await adapter.complete({ ...policyRequest, enableThinking: true });
    globalThis.fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => { calls.push({ url: "", headers: {}, body: JSON.parse(String(init?.body)) }); return okStream(); }) as typeof fetch;
    await adapter.stream({ ...policyRequest, enableThinking: true }, () => {});
    for (const { body } of calls) {
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("thinking");
    }
  });

  it("still sends enable_thinking to providers that support it", async () => {
    const calls = captureBodies(okJson);
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.5-plus", enableThinking: false });
    await adapter.complete(policyRequest);
    expect(calls[0].body.enable_thinking).toBe(false);
  });
});

describe("OpenAICompatAdapter error reporting", () => {
  it("reports an authentication failure with provider, model, status and a hint - and never the key", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key", type: "authentication_error" } }), { status: 401 })) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-secret-key-value", defaultModel: "claude-opus-5-5", providerName: "Anthropic" });
    const error = await adapter.complete(policyRequest).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderRequestError");
    expect(error.message).toContain("401");
    expect(error.message).toContain("Anthropic");
    expect(error.message).toContain("claude-opus-5-5");
    expect(error.message).toContain("invalid x-api-key");
    expect(error.message).toMatch(/authentication failed/);
    expect(error.message).not.toContain("sk-ant-secret-key-value");
  });

  it("explains an unknown model ID", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "model: claude-haiku-5-5", type: "not_found_error" } }), { status: 404 })) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", defaultModel: "claude-haiku-5-5", providerName: "Anthropic" });
    const error = await adapter.complete(policyRequest).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/model ID "claude-haiku-5-5" was not found/);
  });

  it("explains a rejected sampling parameter", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "temperature is deprecated for this model", type: "invalid_request_error" } }), { status: 400 })) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", defaultModel: "claude-opus-5-5" });
    const error = await adapter.complete(policyRequest).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/rejects sampling parameters/);
  });

  it("treats an invalid response body as an error, not as empty output", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://example.test/v1", defaultModel: "m" });
    await expect(adapter.complete(policyRequest)).rejects.toThrow(/not valid JSON/);
    globalThis.fetch = vi.fn(async () => createJsonResponse({ id: "x" })) as typeof fetch;
    await expect(adapter.complete(policyRequest)).rejects.toThrow(/no choices array/);
  });

  it("reports provider-reported usage and keeps an inconsistent usage object unknown", async () => {
    globalThis.fetch = vi.fn(async () => okJson()) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://example.test/v1", defaultModel: "m" });
    expect((await adapter.complete(policyRequest)).usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    globalThis.fetch = vi.fn(async () => createJsonResponse({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 99 } })) as typeof fetch;
    expect((await adapter.complete(policyRequest)).usage).toBeNull();
  });

  it("processes a final SSE line that has no trailing newline", async () => {
    globalThis.fetch = vi.fn(async () => createStreamResponse(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"b"}}]}'])) as typeof fetch;
    const adapter = new OpenAICompatAdapter({ baseUrl: "https://example.test/v1", defaultModel: "m" });
    const result = await adapter.stream(policyRequest, () => {});
    expect(result.content).toBe("ab");
  });
});
