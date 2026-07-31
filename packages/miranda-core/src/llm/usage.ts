/**
 * Miranda Core — OpenAI-compatible usage parsing.
 *
 * Every adapter in this directory speaks the OpenAI chat completions API and so
 * receives the same `usage` object, on both the buffered and the streaming path.
 * This module owns the one translation from that wire shape to `TokenUsage`, so
 * a provider field like `prompt_tokens_details.cached_tokens` is picked up
 * identically everywhere instead of being re-implemented per adapter.
 *
 * Streaming is the path that matters most here: every live agent-loop stage
 * streams, so a cache metric that only works on `complete()` measures the cold
 * path. `STREAM_USAGE_OPTIONS` asks the provider to append the usage chunk to
 * the SSE stream, which is the only way the streaming path can report real
 * prompt-token counts at all.
 */

import type { TokenUsage } from "./types.js";

/** The `usage` object OpenAI-compatible providers return. */
export interface OpenAIUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /**
   * Present when the provider serves part of the prompt from its context cache.
   * DashScope, OpenAI and OpenRouter all report cache hits here.
   */
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

/**
 * Request body fragment that makes an SSE stream terminate with a usage chunk.
 *
 * Without it a streamed response carries no token counts at all — the provider
 * sends content deltas and nothing else. The usage chunk arrives just before
 * `[DONE]` and has an empty `choices` array.
 */
export const STREAM_USAGE_OPTIONS = { include_usage: true } as const;

/**
 * Convert a provider `usage` payload to `TokenUsage`.
 *
 * Returns `null` when the provider reported no usage, matching
 * `LLMResponse.usage`'s "not reported" state. `cachedPromptTokens` is left off
 * entirely rather than defaulting to 0 when the provider omits it, so a cache
 * hit ratio is never computed against a provider that does not report the
 * field — 0 would be indistinguishable from a genuine cache miss.
 */
export function toTokenUsage(
  payload: OpenAIUsagePayload | null | undefined,
): TokenUsage | null {
  if (!payload) return null;

  const cachedTokens = payload.prompt_tokens_details?.cached_tokens;

  return {
    promptTokens: payload.prompt_tokens ?? 0,
    completionTokens: payload.completion_tokens ?? 0,
    totalTokens: payload.total_tokens ?? 0,
    ...(cachedTokens !== undefined && { cachedPromptTokens: cachedTokens }),
  };
}
