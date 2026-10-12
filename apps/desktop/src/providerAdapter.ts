import { OllamaAdapter, OpenAICompatAdapter, budgetedAdapter, providerAcceptsEnableThinking, providerAcceptsTemperature } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import type { ProviderEntry } from "./settings";
import { getSessionBudget } from "./budgetContext";

/**
 * Build the LLM adapter for a configured provider. Every role (Brain, workers,
 * fallbacks) is constructed here, so provider/model request-shape rules live
 * in one place — the adapter layer — and never in individual roles.
 *
 * The provider and model are whatever Settings assigned; nothing here changes
 * them. The policies only shape the request: Anthropic endpoints receive
 * `temperature` only for Claude generations that accept it and never receive
 * the nonstandard `enable_thinking` field; every other provider keeps its
 * current request shape.
 *
 * Every adapter is budgeted: each request is reserved in the task ledger
 * active for the current message before it is sent and settled with the
 * provider's reported usage afterwards; outside a message the session ledger
 * accounts it. No request leaves the app unaccounted.
 */
export function buildAdapterForProvider(
  provider: ProviderEntry,
  model: string,
  enableThinking?: boolean,
): LLMAdapter {
  return budgetedAdapter(buildTransportAdapter(provider, model, enableThinking), {
    provider: { id: provider.id, type: provider.type, name: provider.name, baseUrl: provider.baseUrl },
    defaultModel: model,
    enableThinking,
    fallback: getSessionBudget,
  });
}

/** The provider transport alone, without budget accounting (tests of request shape). */
export function buildTransportAdapter(
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
  // openrouter, deepseek, siliconflow, openai, anthropic, zai, alibaba, custom
  return new OpenAICompatAdapter({
    baseUrl:        provider.baseUrl,
    apiKey:         provider.apiKey || undefined,
    defaultModel:   model,
    enableThinking,
    supportsEnableThinking: providerAcceptsEnableThinking(provider),
    supportsTemperature: (requestModel) => providerAcceptsTemperature(provider, requestModel),
    providerName: provider.name || provider.type,
  });
}
