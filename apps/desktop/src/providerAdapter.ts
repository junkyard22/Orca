import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import type { ProviderEntry } from "./settings";
import { providerAcceptsTemperature } from "./samplingPolicy";

/**
 * Build the LLM adapter for a configured provider. Every role (Brain, workers,
 * fallbacks) is constructed here, so provider/model request-shape rules live
 * in one place.
 */
export function buildAdapterForProvider(
  provider: ProviderEntry,
  model: string,
  enableThinking?: boolean,
): LLMAdapter {
  if (provider.type === 'ollama') {
    return new OllamaAdapter({
      baseUrl:      provider.baseUrl || 'http://localhost:11434',
      defaultModel: model,
    });
  }
  // openrouter, deepseek, siliconflow, openai, anthropic, zai, custom
  return new OpenAICompatAdapter({
    baseUrl:        provider.baseUrl,
    apiKey:         provider.apiKey || undefined,
    defaultModel:   model,
    enableThinking,
    supportsTemperature: (requestModel) => providerAcceptsTemperature(provider, requestModel),
  });
}
