/**
 * Miranda Core — input token bounds and estimates.
 *
 * Two different numbers, kept apart:
 *
 * - `inputTokenBound` is an *upper bound* used to reserve budget before a
 *   request is sent. Every tokenizer Orca's providers use (Claude, GPT, Qwen,
 *   DeepSeek, Llama) is a byte-level BPE: no token covers less than one byte,
 *   so a request's input tokens cannot exceed its UTF-8 byte length. Framing
 *   overhead per message and per request plus a margin are added on top. It is
 *   derived from the request actually being sent, never from the model's
 *   context window.
 * - a display estimate (about four characters per token, `estimateTokens` in
 *   metrics/tokens.ts) is a different number and is never used to reserve or settle.
 */
import type { LLMMessage } from "../llm/types.js";

/** Allowance for role markers and separators the API adds per message. */
export const MESSAGE_OVERHEAD_TOKENS = 32;
/** Allowance for request-level framing (system wrapping, turn markers, tool schemas the provider adds). */
export const REQUEST_OVERHEAD_TOKENS = 512;
/** Margin on top of the byte bound. */
export const INPUT_BOUND_MARGIN = 1.1;

/**
 * Upper bound on the input tokens of a request, or null when a message's
 * content is not plain text (nothing can be bounded for it).
 */
export function inputTokenBound(messages: readonly LLMMessage[] | undefined): number | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let bytes = 0;
  for (const message of messages) {
    if (!message || typeof message.content !== "string" || typeof message.role !== "string") return null;
    bytes += Buffer.byteLength(message.content, "utf8") + Buffer.byteLength(message.role, "utf8");
  }
  const raw = bytes + messages.length * MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS;
  return Math.ceil(raw * INPUT_BOUND_MARGIN);
}

