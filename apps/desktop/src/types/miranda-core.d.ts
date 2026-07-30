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
  }

  export class OpenAICompatAdapter implements LLMAdapter {
    constructor(config: OpenAICompatConfig);
    readonly name: string;
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream?(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse>;
  }
}
