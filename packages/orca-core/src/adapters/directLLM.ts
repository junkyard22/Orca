import type { LLMAdapter } from "@clawde/miranda-core";
import type { LLMRequest, LLMMessage, LLMResponse } from "@clawde/miranda-core";
import type { OrcaLLMResult, OrcaLLMService } from "../types.js";

/**
 * createDirectLLMService — single-call LLM transport.
 *
 * This is the current live LLM service used by the runner. It makes a
 * single model call per prompt without Miranda's multi-stage pipeline
 * (PLAN→ANSWER→CRITIQUE→REWRITE). This transport has no run context, so
 * every live call site must wrap it with Miranda's before/after LLM gates.
 *
 * Prompt format: Maestro joins systemPrompt and taskPrompt with "\n\n---\n\n".
 * This adapter splits on that separator so the model receives a proper
 * system + user message pair.  Falls back to a plain user message when the
 * separator is absent.
 */
export function createDirectLLMService(
  adapter: LLMAdapter,
  modelId: string,
  defaults?: { maxTokens?: number; temperature?: number },
): OrcaLLMService {
  const SEP = "\n\n---\n\n";

  function buildRequest(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; enableThinking?: boolean; abortSignal?: AbortSignal },
  ): LLMRequest {
    const sepIdx = prompt.indexOf(SEP);
    const messages: LLMMessage[] = sepIdx !== -1
      ? [
          { role: "system", content: prompt.slice(0, sepIdx) },
          { role: "user",   content: prompt.slice(sepIdx + SEP.length) },
        ]
      : [{ role: "user", content: prompt }];

    return {
      model:       modelId,
      messages,
      temperature: opts?.temperature ?? defaults?.temperature ?? 0.7,
      maxTokens:   opts?.maxTokens   ?? defaults?.maxTokens   ?? 4096,
      signal:      opts?.abortSignal,
      ...(opts?.enableThinking !== undefined && { enableThinking: opts.enableThinking }),
    } as LLMRequest;
  }

  // Provider-reported usage, model and timing travel with the text so callers
  // can report real token counts instead of estimates.
  const result = (response: LLMResponse): OrcaLLMResult => ({
    text: response.content,
    usage: response.usage ?? null,
    model: response.model,
    durationMs: response.durationMs,
  });

  return {
    async complete(prompt, opts) {
      const request = buildRequest(prompt, opts);

      if (opts?.onToken && adapter.stream) {
        return result(await adapter.stream(request, opts.onToken));
      }

      return result(await adapter.complete(request));
    },

    async stream(prompt, options, onChunk) {
      const request = buildRequest(prompt, options);

      if (adapter.stream) {
        return result(await adapter.stream(request, onChunk));
      }

      // Adapter does not support SSE — fall back to a single buffered call
      // and fire onChunk once with the full response.
      const response = await adapter.complete(request);
      onChunk(response.content);
      return result(response);
    },
  };
}
