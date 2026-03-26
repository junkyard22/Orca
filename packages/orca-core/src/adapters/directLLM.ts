import type { LLMAdapter } from "@clawde/miranda-core";
import type { LLMRequest, LLMMessage } from "@clawde/miranda-core";
import type { OrcaLLMService } from "../types.js";

/**
 * createDirectLLMService — bypasses Miranda's pipeline entirely.
 *
 * Makes a single LLM call per prompt.  Used during Phase 1 (Maestro-only)
 * before Miranda gates and Pappy QC are wired back in.
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

  return {
    async complete(prompt, opts) {
      const sepIdx = prompt.indexOf(SEP);

      const messages: LLMMessage[] = sepIdx !== -1
        ? [
            { role: "system", content: prompt.slice(0, sepIdx) },
            { role: "user",   content: prompt.slice(sepIdx + SEP.length) },
          ]
        : [{ role: "user", content: prompt }];

      const request = {
        model:          modelId,
        messages,
        temperature:    opts?.temperature ?? defaults?.temperature ?? 0.7,
        maxTokens:      opts?.maxTokens   ?? defaults?.maxTokens   ?? 4096,
        signal:         opts?.abortSignal,
        ...(opts?.enableThinking !== undefined && { enableThinking: opts.enableThinking }),
      } as LLMRequest;

      if (opts?.onToken && adapter.stream) {
        const response = await adapter.stream(request, opts.onToken);
        return { text: response.content };
      }

      const response = await adapter.complete(request);
      return { text: response.content };
    },
  };
}
