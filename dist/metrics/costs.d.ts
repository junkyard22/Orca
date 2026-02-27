/**
 * Miranda Core — Cost Calculation
 * Estimate cost from token counts and a pricing table.
 */
import type { TokenUsage, ModelPricing } from "../pipeline/types.js";
/**
 * Calculate estimated cost for a single LLM call.
 */
export declare function calculateCost(modelId: string, usage: TokenUsage, pricingTable?: Record<string, ModelPricing>): number;
/**
 * Format a cost value as a human-readable string.
 */
export declare function formatCost(costUsd: number): string;
//# sourceMappingURL=costs.d.ts.map