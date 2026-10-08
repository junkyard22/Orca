import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdapterForProvider } from "./providerAdapter";
import {
  anthropicModelAcceptsTemperature,
  claudeGeneration,
  providerAcceptsTemperature,
} from "./samplingPolicy";
import type { ProviderEntry } from "./settings";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

interface CapturedCall { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function captureRequests(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const isStream = (JSON.parse(String(init?.body)) as { stream?: boolean }).stream;
    if (isStream) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}

// Same shape as the Summit laptop's provider.
const anthropic: ProviderEntry = {
  id: "prov_d833", name: "anthropic", type: "anthropic",
  baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key",
};
const openrouter: ProviderEntry = {
  id: "prov_or", name: "openrouter", type: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key",
};

// Worker request as ReactAgentAdapter issues it (temperature from role defaults).
const workerRequest = {
  model: "",
  messages: [{ role: "user" as const, content: "Find and fix the bug" }],
  temperature: 0.7,
  maxTokens: 8192,
};

describe("Anthropic request bodies — temperature", () => {
  // Regression: the Find & Fix debugger worker failed with
  // "API error 400: temperature is deprecated for this model."
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])(
    "omits temperature for %s (complete and stream)",
    async (model) => {
      const calls = captureRequests();
      const adapter = buildAdapterForProvider(anthropic, model, true);
      await adapter.complete(workerRequest);
      await adapter.stream!(workerRequest, () => {});

      expect(calls).toHaveLength(2);
      for (const { body, headers, url } of calls) {
        expect(body).not.toHaveProperty("temperature");
        // Everything else about the request is preserved.
        expect(body.model).toBe(model);
        expect(body.max_tokens).toBe(8192);
        expect(body.enable_thinking).toBe(true);
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
    const custom: ProviderEntry = { ...anthropic, id: "prov_c", type: "custom" };
    await buildAdapterForProvider(custom, "claude-opus-5-5").complete(workerRequest);
    expect(calls[0].body).not.toHaveProperty("temperature");
  });
});

describe("Other providers — request bodies unchanged", () => {
  it("still sends temperature to OpenRouter, even for Claude model IDs", async () => {
    const calls = captureRequests();
    await buildAdapterForProvider(openrouter, "anthropic/claude-opus-5-5").complete(workerRequest);
    await buildAdapterForProvider(openrouter, "openai/gpt-4o-mini").stream!(workerRequest, () => {});
    expect(calls.map((c) => c.body.temperature)).toEqual([0.7, 0.7]);
  });
});

describe("samplingPolicy", () => {
  it.each([
    ["claude-opus-5-5", [5, 5]],
    ["claude-sonnet-4-6", [4, 6]],
    ["claude-opus-4-1-20250805", [4, 1]],
    ["claude-sonnet-4-20250514", [4, 0]],
    ["claude-3-5-sonnet-20241022", [3, 5]],
    ["claude-3-opus-latest", [3, 0]],
    ["claude-fable-5-1", [5, 1]],
    ["claude-opus-4-6@20260101", [4, 6]],
  ] as const)("parses %s", (model, expected) => {
    expect(claudeGeneration(model)).toEqual(expected);
  });

  it("only sends temperature to Claude generations up to 4.6", () => {
    for (const model of ["claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(anthropicModelAcceptsTemperature(model)).toBe(true);
    }
    for (const model of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "not-a-claude-id"]) {
      expect(anthropicModelAcceptsTemperature(model)).toBe(false);
    }
  });

  it("does not affect non-Anthropic providers", () => {
    expect(providerAcceptsTemperature({ type: "openai", baseUrl: "https://api.openai.com/v1" }, "claude-opus-5-5")).toBe(true);
    expect(providerAcceptsTemperature({ type: "custom", baseUrl: "not a url" }, "anything")).toBe(true);
  });
});
