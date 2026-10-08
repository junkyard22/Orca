import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import type { ProviderEntry } from "./settings";
import { isAnthropicProvider, providerAcceptsTemperature } from "./samplingPolicy";
import { budgetedAdapter } from './executionBudget';

/**
 * Build the LLM adapter for a configured provider. Every role (Brain, workers,
 * fallbacks) is constructed here, so provider/model request-shape rules live
 * in one place.
 */
export function buildAdapterForProvider(
  provider: ProviderEntry,
  model: string,
  enableThinking?: boolean,
  requireBudget = false,
): LLMAdapter {
  if (provider.type === 'ollama') {
    const adapter = new OllamaAdapter({
      baseUrl:      provider.baseUrl || 'http://localhost:11434',
      defaultModel: model,
    });
    return requireBudget ? budgetedAdapter(adapter, { ...provider, baseUrl: provider.baseUrl || 'http://localhost:11434' }, model) : adapter;
  }
  // openrouter, deepseek, siliconflow, openai, anthropic, zai, custom
  const adapter = new OpenAICompatAdapter({
    baseUrl:        provider.baseUrl,
    apiKey:         provider.apiKey || undefined,
    defaultModel:   model,
    enableThinking,
    // Anthropic documents `thinking`, not `enable_thinking`. Leave its default
    // intact rather than inventing model-specific modes or token budgets.
    supportsEnableThinking: !isAnthropicProvider(provider),
    supportsTemperature: (requestModel) => providerAcceptsTemperature(provider, requestModel),
  });
  return requireBudget ? budgetedAdapter(adapter, provider, model) : adapter;
}
