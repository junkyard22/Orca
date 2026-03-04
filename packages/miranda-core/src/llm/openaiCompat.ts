/**
 * Miranda Core — Generic OpenAI-Compatible LLM Adapter
 *
 * Handles any provider that speaks the OpenAI chat completions API:
 *   OpenRouter, DeepSeek, SiliconFlow, OpenAI, ZAI, Anthropic (via compat), and custom endpoints.
 *
 * Usage:
 *   new OpenAICompatAdapter({
 *     baseUrl:      "https://openrouter.ai/api/v1",
 *     apiKey:       "sk-or-v1-…",
 *     defaultModel: "anthropic/claude-3.5-sonnet",
 *   })
 *
 * The adapter appends /chat/completions to the baseUrl automatically.
 */

import type { LLMAdapter } from "./adapter.js";
import type { LLMRequest, LLMResponse, TokenUsage } from "../pipeline/types.js";

export interface OpenAICompatConfig {
  /**
   * API base URL — do NOT include /chat/completions.
   * e.g. "https://openrouter.ai/api/v1"
   *      "https://api.deepseek.com/v1"
   *      "https://api.openai.com/v1"
   */
  baseUrl: string;
  /** Bearer token for authentication. Omit for unauthenticated endpoints. */
  apiKey?: string;
  /** Default model when request.model is empty. */
  defaultModel?: string;
  /** Extra HTTP headers (e.g. OpenRouter's HTTP-Referer, X-Title). */
  extraHeaders?: Record<string, string>;
}

interface OpenAIChatResponse {
  id?: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatAdapter implements LLMAdapter {
  readonly name = "openai-compat";
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatConfig) {
    if (!config.baseUrl) {
      throw new Error("OpenAICompatAdapter: baseUrl is required");
    }
    const base = config.baseUrl.replace(/\/+$/, "");
    this.url          = `${base}/chat/completions`;
    this.apiKey       = config.apiKey;
    this.defaultModel = config.defaultModel ?? "";
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();
    const model = request.model || this.defaultModel;

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
      ...this.extraHeaders,
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.maxTokens > 4096 ? 120_000 : 60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const durationMs = Date.now() - startMs;

    const firstChoice = data.choices[0];
    if (!firstChoice) {
      throw new Error("API returned no choices");
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

  async stream(
    request: LLMRequest,
    onToken: (chunk: string) => void,
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    const model = request.model || this.defaultModel;

    const body = {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.maxTokens > 4096 ? 120_000 : 60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`API error ${response.status}: ${errorText}`);
    }
    if (!response.body) throw new Error("Response body is null");

    let fullContent = "";
    let finalModel = model;
    let completionTokens = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
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
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      model: finalModel,
      usage: { promptTokens: 0, completionTokens, totalTokens: completionTokens },
      durationMs: Date.now() - startMs,
    };
  }
}
