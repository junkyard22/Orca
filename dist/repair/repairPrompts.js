/**
 * Miranda Core — Repair Prompts
 * Template strings for escalating repair system prompts.
 */
/**
 * Build a repair system prompt for JSON stages.
 * Escalates strictness based on attempt number.
 */
export function buildJsonRepairPrompt(attemptNumber, schemaDescription, exampleJson, previousOutput, validationErrors) {
    const errorList = validationErrors.map((e) => `  - ${e}`).join("\n");
    if (attemptNumber <= 1) {
        return [
            "Your previous response was not valid JSON or did not match the required schema.",
            "",
            "Validation errors:",
            errorList,
            "",
            "Please try again. Respond with ONLY valid JSON matching the schema.",
            "",
            "Schema description:",
            schemaDescription,
        ].join("\n");
    }
    if (attemptNumber === 2) {
        return [
            "Your previous response was invalid. Here is what went wrong:",
            errorList,
            "",
            "You MUST respond with ONLY valid JSON — no markdown, no prose, no code fences.",
            "",
            "Schema description:",
            schemaDescription,
            "",
            "Here is a minimal valid example:",
            exampleJson,
            "",
            "Your previous (invalid) output was:",
            previousOutput.slice(0, 500),
            "",
            "Try again. Output ONLY the JSON object.",
        ].join("\n");
    }
    // Attempt 3+: maximum strictness
    return [
        "ONLY JSON. NO OTHER TEXT.",
        "",
        "Your output must be a single JSON object matching this schema.",
        "Do not include markdown fences, explanations, or any other text.",
        "",
        "Schema:",
        schemaDescription,
        "",
        "Valid example:",
        exampleJson,
        "",
        "Previous errors:",
        errorList,
        "",
        "Output ONLY the JSON object now.",
    ].join("\n");
}
/**
 * Build a repair system prompt for text stages.
 * Escalates strictness based on attempt number.
 */
export function buildTextRepairPrompt(attemptNumber, requiredHeadings, previousOutput, validationErrors) {
    const errorList = validationErrors.map((e) => `  - ${e}`).join("\n");
    const headingList = requiredHeadings.map((h) => `  ${h}`).join("\n");
    if (attemptNumber <= 1) {
        return [
            "Your previous response was missing required sections.",
            "",
            "Validation errors:",
            errorList,
            "",
            "Please try again. Your response MUST include all of these headings:",
            headingList,
        ].join("\n");
    }
    if (attemptNumber === 2) {
        return [
            "Your previous response did not pass validation:",
            errorList,
            "",
            "You MUST include these EXACT headings in your response (as markdown ## headings):",
            headingList,
            "",
            "Your response must be at least 200 characters long.",
            "Include substantive content under each heading.",
            "",
            "Previous output (truncated):",
            previousOutput.slice(0, 300),
            "",
            "Try again with all required headings.",
        ].join("\n");
    }
    // Attempt 3+
    return [
        "MUST include headings exactly as listed below.",
        "",
        "Required headings (copy these exactly):",
        headingList,
        "",
        "Errors from your last attempt:",
        errorList,
        "",
        "Write substantive content under EVERY heading. Minimum 200 characters total.",
    ].join("\n");
}
//# sourceMappingURL=repairPrompts.js.map