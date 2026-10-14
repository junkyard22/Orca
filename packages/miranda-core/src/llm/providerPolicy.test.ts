import { describe, expect, it } from "vitest";
import {
  anthropicModelAcceptsTemperature,
  claudeGeneration,
  isAnthropicEndpoint,
  providerAcceptsEnableThinking,
  providerAcceptsTemperature,
} from "./samplingPolicy.js";
import { ANTHROPIC_CATALOG_REVIEWED, KNOWN_ANTHROPIC_MODELS, anthropicModelIdStatus } from "./modelCatalog.js";
import { ProviderRequestError, extractProviderMessage, providerHint } from "./errors.js";

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
    ["anthropic/claude-haiku-4-5", [4, 5]],
  ] as const)("parses %s", (model, expected) => {
    expect(claudeGeneration(model)).toEqual(expected);
  });

  it("only sends temperature to Claude generations up to 4.6", () => {
    for (const model of ["claude-3-5-sonnet-20241022", "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(anthropicModelAcceptsTemperature(model), model).toBe(true);
    }
    for (const model of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-fable-5-1", "not-a-claude-id"]) {
      expect(anthropicModelAcceptsTemperature(model), model).toBe(false);
    }
  });

  it("recognises Anthropic by provider type or by host, and nothing else", () => {
    expect(isAnthropicEndpoint({ type: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe(true);
    expect(isAnthropicEndpoint({ type: "custom", baseUrl: "https://api.anthropic.com/v1/" })).toBe(true);
    expect(isAnthropicEndpoint({ type: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
    expect(isAnthropicEndpoint({ type: "custom", baseUrl: "not a url" })).toBe(false);
  });

  it("does not affect non-Anthropic providers, even for Claude model IDs", () => {
    expect(providerAcceptsTemperature({ type: "openai", baseUrl: "https://api.openai.com/v1" }, "claude-opus-5-5")).toBe(true);
    expect(providerAcceptsTemperature({ type: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "anthropic/claude-opus-5-5")).toBe(true);
    expect(providerAcceptsTemperature({ type: "ollama", baseUrl: "http://localhost:11434" }, "qwen2.5-coder")).toBe(true);
    expect(providerAcceptsTemperature({ type: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, "qwen3.5-plus")).toBe(true);
    expect(providerAcceptsTemperature({ type: "custom", baseUrl: "not a url" }, "anything")).toBe(true);
    expect(providerAcceptsEnableThinking({ type: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe(false);
    expect(providerAcceptsEnableThinking({ type: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })).toBe(true);
  });
});

describe("modelCatalog", () => {
  it("knows the documented current Anthropic IDs and dates the review", () => {
    expect(KNOWN_ANTHROPIC_MODELS).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"]));
    expect(ANTHROPIC_CATALOG_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("classifies known, legacy and unknown IDs without blocking any of them", () => {
    expect(anthropicModelIdStatus("claude-opus-5-5")).toBe("known");
    expect(anthropicModelIdStatus("claude-haiku-4-5-20251001")).toBe("legacy");
    expect(anthropicModelIdStatus("claude-3-5-sonnet-20241022")).toBe("legacy");
    expect(anthropicModelIdStatus("claude-haiku-5-5")).toBe("unknown");
    expect(anthropicModelIdStatus("gpt-4o")).toBe("unknown");
  });
});

describe("ProviderRequestError", () => {
  it("extracts the provider's message from OpenAI- and Anthropic-style bodies", () => {
    expect(extractProviderMessage(JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } }))).toBe("bad [invalid_request_error]");
    expect(extractProviderMessage(JSON.stringify({ error: "string form" }))).toBe("string form");
    expect(extractProviderMessage("plain text")).toBe("plain text");
    expect(extractProviderMessage("")).toBe("unknown error");
  });

  it("gives hints for the common statuses", () => {
    expect(providerHint(401, "x", "m")).toMatch(/authentication/);
    expect(providerHint(404, "x", "m")).toMatch(/not found/);
    expect(providerHint(400, "temperature is deprecated", "m")).toMatch(/sampling/);
    expect(providerHint(429, "x", "m")).toMatch(/rate limited/);
    expect(providerHint(503, "x", "m")).toMatch(/provider-side/);
    expect(providerHint(400, "something else", "m")).toBeUndefined();
  });

  it("carries structured fields", () => {
    const e = new ProviderRequestError({ provider: "P", model: "m", url: "https://x/v1/chat/completions", status: 404, body: "{}" });
    expect(e).toMatchObject({ name: "ProviderRequestError", provider: "P", model: "m", status: 404 });
    expect(e.message).toContain("API error 404 from P (model m)");
  });
});
