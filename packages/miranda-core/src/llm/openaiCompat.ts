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
import type { LLMRequest, LLMResponse, TokenUsage } from "./types.js";
import { createRequestSignal, throwIfAborted } from "./requestSignal.js";

type OrcaProfileEvent = Record<string, unknown>;
type OrcaProfileEmitter = (event: OrcaProfileEvent) => void;

function emitOrcaProfileEvent(event: OrcaProfileEvent): void {
  const emitter = (globalThis as typeof globalThis & {
    __orcaProfileEmit?: OrcaProfileEmitter;
  }).__orcaProfileEmit;
  emitter?.(event);
}

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
  /**
   * Adapter-level default for `enable_thinking`.
   * Individual requests can override via `LLMRequest.enableThinking`.
   * Set to `false` to suppress chain-of-thought on models like qwen3.5-plus
   * that default to deep thinking. Omit to leave provider default unchanged.
   */
  enableThinking?: boolean;
}

interface OpenAIChatResponse {
  id?: string;
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * Present when the provider serves part of the prompt from its context
     * cache.  DashScope, OpenAI and OpenRouter all report cache hits here.
     */
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

export class OpenAICompatAdapter implements LLMAdapter {
  readonly name = "openai-compat";
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly defaultEnableThinking?: boolean;

  constructor(config: OpenAICompatConfig) {
    if (!config.baseUrl) {
      throw new Error("OpenAICompatAdapter: baseUrl is required");
    }
    const base = config.baseUrl.replace(/\/+$/, "");
    this.url                  = `${base}/chat/completions`;
    this.apiKey               = config.apiKey;
    this.defaultModel         = config.defaultModel ?? "";
    this.extraHeaders         = config.extraHeaders ?? {};
    this.defaultEnableThinking = config.enableThinking;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    throwIfAborted(request.signal);
    const startMs = Date.now();
    const model = request.model || this.defaultModel;

    const resolvedThinking = request.enableThinking ?? this.defaultEnableThinking;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };

    if (resolvedThinking !== undefined) {
      body["enable_thinking"] = resolvedThinking;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 120_000 : 60_000,
    );
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as OpenAIChatResponse;
      const durationMs = Date.now() - startMs;

      if (process.env["ORCA_PROFILE"] === "1") {
        emitOrcaProfileEvent({
          phase: "llm_call",
          method: "complete",
          model: data.model ?? model,
          durationMs,
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
          cachedPromptTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        });
      }

      const firstChoice = data.choices[0];
      if (!firstChoice) {
        throw new Error("API returned no choices");
      }

      let usage: TokenUsage | null = null;
      if (data.usage) {
        const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens;
        usage = {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
          ...(cachedTokens !== undefined && { cachedPromptTokens: cachedTokens }),
        };
      }

      // Some thinking models (e.g. Alibaba qwen3.5-plus on DashScope) return the
      // actual response in `reasoning_content` while `content` is null/empty.
      // Fall back to reasoning_content so we don't return an empty string.
      const rawContent = firstChoice.message.content;
      const rawReasoning = (firstChoice.message as Record<string, unknown>)["reasoning_content"] as string | undefined;
      const content = (rawContent && rawContent.trim()) ? rawContent : (rawReasoning ?? "");

      return {
        content,
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

    const resolvedThinking = request.enableThinking ?? this.defaultEnableThinking;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    };

    if (resolvedThinking !== undefined) {
      body["enable_thinking"] = resolvedThinking;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 120_000 : 60_000,
    );
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
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
                choices: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
                model?: string;
              };
              // Some thinking models (e.g. Alibaba qwen3.5-plus) stream actual
              // output via `reasoning_content` while `content` is empty/null.
              const delta = chunk.choices[0]?.delta;
              const token = delta?.content || delta?.reasoning_content || "";
              if (token) { fullContent += token; completionTokens++; onToken(token); }
              if (chunk.model) finalModel = chunk.model;
            } catch { /* skip malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const streamDurationMs = Date.now() - startMs;
      if (process.env["ORCA_PROFILE"] === "1") {
        emitOrcaProfileEvent({
          phase: "llm_call",
          method: "stream",
          model: finalModel,
          durationMs: streamDurationMs,
          completionTokens,
          totalTokens: completionTokens,
        });
      }
      return {
        content: fullContent,
        model: finalModel,
        usage: { promptTokens: 0, completionTokens, totalTokens: completionTokens },
        durationMs: streamDurationMs,
      };
    } finally {
      cleanup();
    }
  }
}
