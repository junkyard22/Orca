/**
 * Miranda Core — LLM Adapter Interface
 * Provider-agnostic interface for LLM calls.
 */

import type { LLMRequest, LLMResponse } from "../pipeline/types.js";

export interface LLMAdapter {
  /** Unique identifier for this adapter (e.g. "openrouter") */
  readonly name: string;

  /**
   * Send a completion request and return the response.
   * Must throw on network/timeout errors so the pipeline can handle retry.
   */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Optional SSE streaming variant.
   * Calls `onToken` for each incremental chunk and resolves with the full
   * assembled LLMResponse when the stream closes.
   * Falls back to complete() when not implemented.
   */
  stream?(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse>;
}
