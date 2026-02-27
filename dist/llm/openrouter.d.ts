/**
 * Miranda Core — OpenRouter LLM Adapter
 * Implements LLMAdapter using the OpenRouter chat completions API.
 */
import type { LLMAdapter } from "./adapter.js";
import type { LLMRequest, LLMResponse } from "../pipeline/types.js";
export interface OpenRouterConfig {
    apiKey: string;
    /** Optional site URL for OpenRouter rankings */
    siteUrl?: string;
    /** Optional app name for OpenRouter rankings */
    appName?: string;
}
export declare class OpenRouterAdapter implements LLMAdapter {
    readonly name = "openrouter";
    private readonly apiKey;
    private readonly siteUrl;
    private readonly appName;
    constructor(config: OpenRouterConfig);
    complete(request: LLMRequest): Promise<LLMResponse>;
}
//# sourceMappingURL=openrouter.d.ts.map