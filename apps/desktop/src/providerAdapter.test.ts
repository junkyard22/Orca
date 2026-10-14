import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdapterForProvider } from "./providerAdapter";
import type { ProviderEntry } from "./settings";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

interface CapturedCall { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function captureRequests(status = 200): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    const isStream = (JSON.parse(String(init?.body)) as { stream?: boolean }).stream;
    if (isStream) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}

const anthropic: ProviderEntry = { id: "prov_a", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" };
const openrouter: ProviderEntry = { id: "prov_or", name: "OpenRouter", type: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key" };
const openai: ProviderEntry = { id: "prov_oa", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "oa-key" };
const alibaba: ProviderEntry = { id: "prov_ali", name: "DashScope", type: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "ali-key" };
const custom: ProviderEntry = { id: "prov_c", name: "Local", type: "custom", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "" };
const ollama: ProviderEntry = { id: "prov_ol", name: "Ollama", type: "ollama", baseUrl: "http://localhost:11434", apiKey: "" };

// Worker request as ReactAgentAdapter issues it (temperature from role defaults).
const workerRequest = {
  model: "",
  messages: [{ role: "user" as const, content: "Find and fix the bug" }],
  temperature: 0.7,
  maxTokens: 8192,
};

describe("Anthropic request bodies", () => {
  // Regression: the Find & Fix debugger worker failed with
  // "API error 400: temperature is deprecated for this model."
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-4-7"])(
    "omits temperature for %s (complete and stream) and keeps everything else",
    async (model) => {
      const calls = captureRequests();
      const adapter = buildAdapterForProvider(anthropic, model, true);
      await adapter.complete(workerRequest);
      await adapter.stream!(workerRequest, () => {});

      expect(calls).toHaveLength(2);
      for (const { body, headers, url } of calls) {
        expect(body).not.toHaveProperty("temperature");
        expect(body.model).toBe(model);
        expect(body.max_tokens).toBe(8192);
        expect(body).not.toHaveProperty("enable_thinking");
        expect(headers.Authorization).toBe("Bearer test-key");
        expect(url).toBe("https://api.anthropic.com/v1/chat/completions");
      }
    },
  );

  it("keeps temperature for Claude models that still accept it", async () => {
    const calls = captureRequests();
    await buildAdapterForProvider(anthropic, "claude-sonnet-4-6").complete(workerRequest);
    await buildAdapterForProvider(anthropic, "claude-haiku-4-5").complete(workerRequest);
    expect(calls.map((c) => c.body.temperature)).toEqual([0.7, 0.7]);
  });

  it("applies the rule to a custom provider pointed at api.anthropic.com", async () => {
    const calls = captureRequests();
    await buildAdapterForProvider({ ...anthropic, id: "prov_c", type: "custom" }, "claude-opus-5-5").complete(workerRequest);
    expect(calls[0].body).not.toHaveProperty("temperature");
  });

  it("never sends enable_thinking to Anthropic, whatever the role or request asks", async () => {
    const calls = captureRequests();
    for (const enableThinking of [true, false, undefined]) {
      const adapter = buildAdapterForProvider(anthropic, "claude-sonnet-4-6", enableThinking);
      await adapter.complete({ ...workerRequest, enableThinking: true });
      await adapter.stream!({ ...workerRequest, enableThinking: true }, () => {});
    }
    expect(calls).toHaveLength(6);
    for (const { body } of calls) {
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("thinking");
    }
  });

  it("uses the model exactly as configured — no silent downgrade for unknown IDs", async () => {
    const calls = captureRequests();
    await buildAdapterForProvider(anthropic, "claude-haiku-5-5").complete(workerRequest);
    expect(calls[0].body.model).toBe("claude-haiku-5-5");
  });

  it("surfaces a provider error with provider, model and hint, without the key", async () => {
    captureRequests(401);
    const error = await buildAdapterForProvider(anthropic, "claude-opus-5-5").complete(workerRequest).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/401 from Anthropic \(model claude-opus-5-5\)/);
    expect(error.message).toMatch(/authentication failed/);
    expect(error.message).not.toContain("test-key");
  });
});

describe("Other providers — request bodies unchanged", () => {
  it.each([
    ["OpenRouter", openrouter, "anthropic/claude-opus-5-5"],
    ["OpenAI", openai, "gpt-4o-mini"],
    ["DashScope", alibaba, "qwen3.5-plus"],
    ["custom local endpoint", custom, "llama-3.1-8b"],
  ])("still sends temperature to %s", async (_label, provider, model) => {
    const calls = captureRequests();
    const adapter = buildAdapterForProvider(provider, model, undefined);
    await adapter.complete(workerRequest);
    await adapter.stream!(workerRequest, () => {});
    expect(calls.map((c) => c.body.temperature)).toEqual([0.7, 0.7]);
    expect(calls.map((c) => c.body.model)).toEqual([model, model]);
  });

  it.each([true, false])("preserves other providers' enable_thinking=%s", async (enableThinking) => {
    const calls = captureRequests();
    const adapter = buildAdapterForProvider(alibaba, "qwen3.5-plus", enableThinking);
    await adapter.complete(workerRequest);
    await adapter.stream!(workerRequest, () => {});
    expect(calls.map(({ body }) => body.enable_thinking)).toEqual([enableThinking, enableThinking]);
  });

  it("sends no Authorization header when the custom endpoint has no key", async () => {
    const calls = captureRequests();
    await buildAdapterForProvider(custom, "llama-3.1-8b").complete(workerRequest);
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });

  it("routes Ollama through its own adapter at /v1/chat/completions", async () => {
    const calls = captureRequests();
    const adapter = buildAdapterForProvider(ollama, "qwen2.5-coder");
    expect(adapter.name).toBe("ollama");
    await adapter.complete(workerRequest);
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].body.temperature).toBe(0.7);
  });

  it("reports provider usage on both paths and never invents counts", async () => {
    captureRequests();
    const adapter = buildAdapterForProvider(openai, "gpt-4o-mini");
    expect((await adapter.complete(workerRequest)).usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
    expect((await adapter.stream!(workerRequest, () => {})).usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
  });
});
