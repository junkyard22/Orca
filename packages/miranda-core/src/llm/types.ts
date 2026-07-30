/**
 * Miranda Core — Live LLM contracts.
 *
 * The request/response shapes every provider adapter in this directory speaks,
 * plus the model descriptor the router selects with.
 *
 * These lived in `../pipeline/types.js` until they were moved here. That file is
 * the frozen PLAN→ANSWER→CRITIQUE→REWRITE pipeline, so Contract Check rule 1
 * BLOCKS any change to it — correctly, but it meant every change to a *live*
 * adapter contract landed inside the freeze and had to be waved through. The
 * types are live code and now sit next to the adapters that use them; the frozen
 * pipeline re-exports them so its own definitions are unchanged.
 *
 * Nothing here may import from `../pipeline/`. The dependency runs one way:
 * frozen code may depend on live contracts, never the reverse.
 */

export interface ModelSpec {
  /** OpenRouter model ID, e.g. "deepseek/deepseek-chat" */
  id: string;
  /** Display name for logs */
  label: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  /**
   * When set, injects `enable_thinking` into the request body.
   * Use `false` to suppress chain-of-thought on models that default to deep
   * thinking (e.g. qwen3.5-plus). Use `true` to force it on. Omit to let the
   * provider use its own default.
   */
  enableThinking?: boolean;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage | null;
  durationMs: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens served from the provider's cache, when the provider reports
   * them (`usage.prompt_tokens_details.cached_tokens` on DashScope, OpenAI and
   * OpenRouter).
   *
   * A subset of `promptTokens`, not an addition to it. Cached tokens are billed
   * at a reduced rate, so a run's cache hit ratio is
   * `cachedPromptTokens / promptTokens`.
   *
   * Left `undefined` rather than defaulting to 0 when the provider says nothing,
   * so a hit ratio is never computed against a provider that simply does not
   * report the field — 0 would be indistinguishable from a genuine cache miss.
   */
  cachedPromptTokens?: number;
}
