/**
 * Miranda Core — Token Estimation
 * Helpers for estimating token counts when the API doesn't return them.
 */
import type { TokenUsage } from "../pipeline/types.js";
/**
 * Approximate token count from character count.
 */
export declare function estimateTokens(text: string): number;
/**
 * Build a TokenUsage from either the API response or an approximation.
 */
export declare function resolveTokenUsage(apiUsage: TokenUsage | null, promptText: string, completionText: string): TokenUsage;
//# sourceMappingURL=tokens.d.ts.map