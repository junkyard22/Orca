/**
 * Miranda Core — OpenRouter LLM Adapter
 * Implements LLMAdapter using the OpenRouter chat completions API.
 */

import type { LLMAdapter } from "./adapter.js";
import type { LLMRequest, LLMResponse, TokenUsage } from "./types.js";
import { createRequestSignal, throwIfAborted } from "./requestSignal.js";
import {
  STREAM_USAGE_OPTIONS,
  toTokenUsage,
  type OpenAIUsagePayload,
} from "./usage.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterConfig {
  apiKey: string;
  /** Optional site URL for OpenRouter rankings */
  siteUrl?: string;
  /** Optional app name for OpenRouter rankings */
  appName?: string;
}

interface OpenRouterChatResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  model: string;
  usage?: OpenAIUsagePayload;
}

export class OpenRouterAdapter implements LLMAdapter {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly siteUrl: string;
  private readonly appName: string;

  constructor(config: OpenRouterConfig) {
    if (!config.apiKey) {
      throw new Error("OpenRouterAdapter: apiKey is required");
    }
    this.apiKey = config.apiKey;
    this.siteUrl = config.siteUrl ?? "https://github.com/clawde";
    this.appName = config.appName ?? "Miranda Core";
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    throwIfAborted(request.signal);
    const startMs = Date.now();

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };

    if (request.enableThinking !== undefined) {
      body["enable_thinking"] = request.enableThinking;
    }

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 120_000 : 60_000,
    );
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.appName,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(
          `OpenRouter API error ${response.status}: ${errorText}`
        );
      }

      const data = (await response.json()) as OpenRouterChatResponse;
      const durationMs = Date.now() - startMs;

      const firstChoice = data.choices[0];
      if (!firstChoice) {
        throw new Error("OpenRouter returned no choices");
      }

      const usage = toTokenUsage(data.usage);

      // Some thinking models return output via reasoning_content when content is empty
      const rawContent = firstChoice.message.content;
      const rawReasoning = (firstChoice.message as Record<string, unknown>)["reasoning_content"] as string | undefined;
      const content = (rawContent && rawContent.trim()) ? rawContent : (rawReasoning ?? "");

      return {
        content,
        model: data.model ?? request.model,
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

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: STREAM_USAGE_OPTIONS,
    };

    if (request.enableThinking !== undefined) {
      body["enable_thinking"] = request.enableThinking;
    }

    const { signal, cleanup } = createRequestSignal(
      request,
      request.maxTokens > 4096 ? 120_000 : 60_000,
    );
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.appName,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }
      if (!response.body) throw new Error("Response body is null");

      let fullContent = "";
      let finalModel = request.model;
      let deltaCount = 0;
      let reportedUsage: OpenAIUsagePayload | undefined;

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
                usage?: OpenAIUsagePayload;
              };
              const delta = chunk.choices[0]?.delta;
              const token = delta?.content || delta?.reasoning_content || "";
              if (token) { fullContent += token; deltaCount++; onToken(token); }
              if (chunk.model) finalModel = chunk.model;
              // stream_options.include_usage appends a final usage-only chunk.
              if (chunk.usage) reportedUsage = chunk.usage;
            } catch { /* skip malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Delta count only approximates completion tokens; it is the fallback for
      // a provider that sent no usage chunk, where the prompt side is unknown.
      const usage: TokenUsage = toTokenUsage(reportedUsage) ?? {
        promptTokens: 0,
        completionTokens: deltaCount,
        totalTokens: deltaCount,
      };

      return {
        content: fullContent,
        model: finalModel,
        usage,
        durationMs: Date.now() - startMs,
      };
    } finally {
      cleanup();
    }
  }
}
