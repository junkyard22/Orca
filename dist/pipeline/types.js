/**
 * Miranda Core — Pipeline Types
 * All core interfaces, config, and type definitions.
 */
export const STAGE_ORDER = [
    "plan",
    "answer",
    "critique",
    "rewrite",
];
export const STAGE_FORMAT = {
    plan: "json",
    answer: "text",
    critique: "json",
    rewrite: "text",
};
/** Default pricing table (approximate, config-overridable) */
export const DEFAULT_PRICING = {
    "deepseek/deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
    "deepseek/deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
    "qwen/qwen-2.5-72b-instruct": { inputPer1M: 0.36, outputPer1M: 0.36 },
    "anthropic/claude-3.5-haiku": { inputPer1M: 0.80, outputPer1M: 4.00 },
    "anthropic/claude-3.5-sonnet": { inputPer1M: 3.00, outputPer1M: 15.00 },
    "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60 },
    "openai/gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00 },
    "google/gemini-2.0-flash-001": { inputPer1M: 0.10, outputPer1M: 0.40 },
};
// ---------------------------------------------------------------------------
// Default Models
// ---------------------------------------------------------------------------
export const DEFAULT_MODELS = {
    plan: [
        { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B" },
        { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    ],
    answer: [
        { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B" },
        { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    ],
    critique: [
        { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
        { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    ],
    rewrite: [
        { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B" },
        { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        { id: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku" },
    ],
};
// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------
function defaultStageConfig(stage) {
    return {
        models: DEFAULT_MODELS[stage],
        maxRetriesPerModel: 3,
        maxTotalAttempts: 6,
        baseTemperature: 0.4,
        maxTokens: stage === "plan" || stage === "critique" ? 2048 : 4096,
        timeoutMs: 60_000,
    };
}
export function createDefaultConfig(overrides) {
    const base = {
        stages: {
            plan: defaultStageConfig("plan"),
            answer: defaultStageConfig("answer"),
            critique: defaultStageConfig("critique"),
            rewrite: defaultStageConfig("rewrite"),
        },
        budgetUsd: 0.10,
        pricing: { ...DEFAULT_PRICING },
        circuitBreaker: {
            failureThreshold: 3,
            windowMs: 5 * 60 * 1000,
            cooldownMs: 2 * 60 * 1000,
        },
        logPath: "miranda-runs.jsonl",
        verbose: false,
    };
    if (overrides) {
        return { ...base, ...overrides };
    }
    return base;
}
//# sourceMappingURL=types.js.map