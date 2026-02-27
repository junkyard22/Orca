/**
 * Miranda Core — LLM Adapter Interface
 * Provider-agnostic interface for LLM calls.
 */
import type { LLMRequest, LLMResponse } from "../pipeline/types.js";
export interface LLMAdapter {
    /** Unique identifier for this adapter (e.g. "openrouter") */
    readonly name: string;
    /**
     * Send a completion request and return the response.
     * Must throw on network/timeout errors so the pipeline can handle retry.
     */
    complete(request: LLMRequest): Promise<LLMResponse>;
}
//# sourceMappingURL=adapter.d.ts.map