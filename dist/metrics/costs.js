/**
 * Miranda Core — Cost Calculation
 * Estimate cost from token counts and a pricing table.
 */
import { DEFAULT_PRICING } from "../pipeline/types.js";
/**
 * Calculate estimated cost for a single LLM call.
 */
export function calculateCost(modelId, usage, pricingTable = DEFAULT_PRICING) {
    const pricing = pricingTable[modelId];
    if (!pricing) {
        // Unknown model — use a conservative default
        return (usage.promptTokens * 1.0 + usage.completionTokens * 2.0) / 1_000_000;
    }
    const inputCost = (usage.promptTokens * pricing.inputPer1M) / 1_000_000;
    const outputCost = (usage.completionTokens * pricing.outputPer1M) / 1_000_000;
    return inputCost + outputCost;
}
/**
 * Format a cost value as a human-readable string.
 */
export function formatCost(costUsd) {
    if (costUsd < 0.001) {
        return `$${(costUsd * 100).toFixed(4)}¢`;
    }
    return `$${costUsd.toFixed(6)}`;
}
//# sourceMappingURL=costs.js.map