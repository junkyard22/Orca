/**
 * Miranda Core — Token Estimation
 * Helpers for estimating token counts when the API doesn't return them.
 */

import type { TokenUsage } from "../pipeline/types.js";

/**
 * Rough average characters-per-token for English text.
 * OpenAI tokenizers average about 4 chars/token; this is a conservative approximation.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Approximate token count from character count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build a TokenUsage from either the API response or an approximation.
 */
export function resolveTokenUsage(
  apiUsage: TokenUsage | null,
  promptText: string,
  completionText: string
): TokenUsage {
  if (apiUsage) {
    return apiUsage;
  }

  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
