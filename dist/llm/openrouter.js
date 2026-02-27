/**
 * Miranda Core — OpenRouter LLM Adapter
 * Implements LLMAdapter using the OpenRouter chat completions API.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export class OpenRouterAdapter {
    name = "openrouter";
    apiKey;
    siteUrl;
    appName;
    constructor(config) {
        if (!config.apiKey) {
            throw new Error("OpenRouterAdapter: apiKey is required");
        }
        this.apiKey = config.apiKey;
        this.siteUrl = config.siteUrl ?? "https://github.com/clawde";
        this.appName = config.appName ?? "Miranda Core";
    }
    async complete(request) {
        const startMs = Date.now();
        const body = {
            model: request.model,
            messages: request.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            temperature: request.temperature,
            max_tokens: request.maxTokens,
        };
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": this.siteUrl,
                "X-Title": this.appName,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(request.maxTokens > 4096 ? 120_000 : 60_000),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown error");
            throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
        }
        const data = (await response.json());
        const durationMs = Date.now() - startMs;
        const firstChoice = data.choices[0];
        if (!firstChoice) {
            throw new Error("OpenRouter returned no choices");
        }
        let usage = null;
        if (data.usage) {
            usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            };
        }
        return {
            content: firstChoice.message.content,
            model: data.model ?? request.model,
            usage,
            durationMs,
        };
    }
}
//# sourceMappingURL=openrouter.js.map