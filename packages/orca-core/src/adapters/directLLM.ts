import type { LLMAdapter } from "@clawde/miranda-core";
import type { LLMRequest, LLMMessage } from "@clawde/miranda-core";
import type { OrcaLLMService } from "../types.js";

/**
 * createDirectLLMService — bypasses Miranda's LLM stage pipeline.
 *
 * This is the current live LLM service used by the runner. It makes a
 * single model call per prompt without Miranda's multi-stage pipeline
 * (PLAN→ANSWER→CRITIQUE→REWRITE). Miranda's gate (ctx.gate) still runs
 * at the tool-call and QC boundary — only the per-LLM-call staging is absent.
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

  return {
    async complete(prompt, opts) {
      const request = buildRequest(prompt, opts);

      if (opts?.onToken && adapter.stream) {
        const response = await adapter.stream(request, opts.onToken);
        return { text: response.content };
      }

      const response = await adapter.complete(request);
      return { text: response.content };
    },

    async stream(prompt, options, onChunk) {
      const request = buildRequest(prompt, options);

      if (adapter.stream) {
        const response = await adapter.stream(request, onChunk);
        return { text: response.content };
      }

      // Adapter does not support SSE — fall back to a single buffered call
      // and fire onChunk once with the full response.
      const response = await adapter.complete(request);
      onChunk(response.content);
      return { text: response.content };
    },
  };
}
