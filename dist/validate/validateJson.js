/**
 * Miranda Core — JSON Validation
 * Parse raw LLM output as JSON and validate against a Zod schema.
 */
/**
 * Strip markdown code fences if the LLM wrapped JSON in ```json...```
 */
function stripMarkdownFences(raw) {
    let cleaned = raw.trim();
    // Remove ```json ... ``` or ``` ... ```
    const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
    const match = fencePattern.exec(cleaned);
    if (match?.[1]) {
        cleaned = match[1].trim();
    }
    return cleaned;
}
/**
 * Validate raw LLM output as JSON against a Zod schema.
 * Strips markdown fences before parsing.
 */
export function validateJson(raw, schema) {
    // Empty or whitespace check
    if (!raw || !raw.trim()) {
        return {
            valid: false,
            errors: ["Output is empty or whitespace-only"],
        };
    }
    const cleaned = stripMarkdownFences(raw);
    // Parse JSON
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            valid: false,
            errors: [`Invalid JSON: ${message}`],
        };
    }
    // Validate against schema
    const result = schema.safeParse(parsed);
    if (!result.success) {
        const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        return {
            valid: false,
            data: parsed,
            errors,
        };
    }
    return {
        valid: true,
        data: result.data,
    };
}
//# sourceMappingURL=validateJson.js.map