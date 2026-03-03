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

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.maxTokens > 4096 ? 180_000 : 90_000),
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
  }
}
