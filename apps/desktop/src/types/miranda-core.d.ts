/**
 * Type declarations for @clawde/miranda-core
 */
declare module '@clawde/miranda-core' {
  export interface LLMRequest {
    model: string;
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
    enableThinking?: boolean;
    signal?: AbortSignal;
  }

  export interface LLMResponse {
    content: string;
    model: string;
    usage: TokenUsage | null;
    durationMs: number;
  }

  export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }

  export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Subset of promptTokens served from the provider's cache, when reported. */
    cachedPromptTokens?: number;
  }

  export interface LLMAdapter {
    readonly name: string;
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream?(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse>;
  }

  export interface OllamaConfig {
    baseUrl?: string;
    defaultModel?: string;
  }

  export class OllamaAdapter implements LLMAdapter {
    constructor(config: OllamaConfig);
    readonly name: string;
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream?(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse>;
  }

  export interface OpenAICompatConfig {
    baseUrl: string;
    apiKey?: string;
    defaultModel?: string;
    extraHeaders?: Record<string, string>;
    enableThinking?: boolean;
    supportsEnableThinking?: boolean;
    includeStreamUsage?: boolean;
    supportsTemperature?: (model: string) => boolean;
    providerName?: string;
  }

  export interface SamplingProvider { type: string; baseUrl?: string }
  export function isAnthropicEndpoint(provider: SamplingProvider): boolean;
  export function claudeGeneration(model: string): [number, number] | null;
  export function anthropicModelAcceptsTemperature(model: string): boolean;
  export function providerAcceptsTemperature(provider: SamplingProvider, model: string): boolean;
  export function providerAcceptsEnableThinking(provider: SamplingProvider): boolean;
  export const KNOWN_ANTHROPIC_MODELS: readonly string[];
  export const ANTHROPIC_CATALOG_REVIEWED: string;
  export type ModelIdStatus = "known" | "legacy" | "unknown";
  export function anthropicModelIdStatus(model: string): ModelIdStatus;
  export class ProviderRequestError extends Error {
    readonly provider: string;
    readonly model: string;
    readonly url: string;
    readonly status: number;
    readonly providerMessage: string;
    readonly hint: string | undefined;
  }

  export class OpenAICompatAdapter implements LLMAdapter {
    constructor(config: OpenAICompatConfig);
    readonly name: string;
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream?(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse>;
  }

  export type ToolVerbClass = "read" | "write" | "unknown";
  /** Verb-based read/write classification of an MCP tool name (shared with Miranda's gate). */
  export function classifyToolVerb(tool: string): ToolVerbClass;
}
