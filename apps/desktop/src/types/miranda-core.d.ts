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
  /** Whether running a tool can change local files, as far as its name tells. */
  export function toolMayModifyFilesystem(tool: string): boolean;
  /** Values of a tool call's arguments whose keys name a local location, at any depth. */
  export function collectExplicitPathArguments(args: Record<string, unknown>): string[];
  /** What an execution of a tool can reach on this machine and what, if anything, holds it there. */
  export function toolExecutionAuthority(tool: string): {
    filesystemScope: "workspace" | "host" | "unknown" | "none";
    confinement: "host_enforced_paths" | "argument_validation" | "none" | "not_applicable";
    note: string;
  };
  export const WORKSPACE_REQUIRED_CODE: "workspace_required";
  export const WORKSPACE_REQUIRED_PREFIX: string;
  export function assessWorkspaceRoot(root: string | undefined | null): {
    status: "ok" | "not_configured" | "missing" | "not_a_directory" | "filesystem_root";
    root?: string;
    message: string;
  };
}
