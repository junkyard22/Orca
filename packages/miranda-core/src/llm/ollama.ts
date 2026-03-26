/**
 * Miranda Core — Ollama LLM Adapter
 * Implements LLMAdapter using Ollama's OpenAI-compatible chat completions API.
 *
 * Ollama runs locally (or on a remote host) and exposes:
 *   POST http://localhost:11434/v1/chat/completions
 *
 * No API key is required for local usage. For remote/cloud Ollama instances
 * an optional apiKey can be provided and will be sent as a Bearer token.
 */

import type { LLMAdapter } from "./adapter.js";
import type { LLMRequest, LLMResponse, TokenUsage } from "../pipeline/types.js";
import { createRequestSignal, throwIfAborted } from "./requestSignal.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export interface OllamaConfig {
  /**
   * Model name as registered in Ollama, e.g. "llama3.2", "mistral", "deepseek-r1:14b".
   * This becomes the default when no model is specified on a per-request basis.
   */
  defaultModel?: string;
  /**
   * Base URL of the Ollama instance.
   * @default "http://localhost:11434"
   */
  baseUrl?: string;
  /**
   * Optional Bearer token — only needed for remote/secured Ollama instances.
   */
  apiKey?: string;
}

interface OllamaChatResponse {
  id?: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OllamaAdapter implements LLMAdapter {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly apiKey?: string;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
    this.defaultModel = config.defaultModel ?? "llama3.2";
    this.apiKey = config.apiKey;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    throwIfAborted(request.signal);
    const startMs = Date.now();
    const model = request.model || this.defaultModel;
    const url = `${this.baseUrl}/v1/chat/completions`;

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 180_000 : 90_000,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const durationMs = Date.now() - startMs;

      const firstChoice = data.choices[0];
      if (!firstChoice) {
        throw new Error("Ollama returned no choices");
      }

      let usage: TokenUsage | null = null;
      if (data.usage) {
        usage = {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        };
      }

      return {
        content: firstChoice.message.content,
        model: data.model ?? model,
        usage,
        durationMs,
      };
    } finally {
      cleanup();
    }
  }

  async stream(
    request: LLMRequest,
    onToken: (chunk: string) => void,
  ): Promise<LLMResponse> {
    throwIfAborted(request.signal);
    const startMs = Date.now();
    const model = request.model || this.defaultModel;
    const url = `${this.baseUrl}/v1/chat/completions`;

    const body = {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 180_000 : 90_000,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }
      if (!response.body) throw new Error("Response body is null");

      let fullContent = "";
      let finalModel = model;
      let completionTokens = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break;
          try {
            const chunk = JSON.parse(data) as {
              choices: Array<{ delta?: { content?: string } }>;
              model?: string;
            };
            const token = chunk.choices[0]?.delta?.content ?? "";
            if (token) { fullContent += token; completionTokens++; onToken(token); }
            if (chunk.model) finalModel = chunk.model;
          } catch { /* skip malformed chunks */ }
        }
      }
      return {
        content: fullContent,
        model: finalModel,
        usage: { promptTokens: 0, completionTokens, totalTokens: completionTokens },
        durationMs: Date.now() - startMs,
      };
    } finally {
      cleanup();
    }
  }
}
