/**
 * Miranda Core — REWRITE Contract
 * Required headings and system prompt for the REWRITE stage.
 */
export const REWRITE_REQUIRED_HEADINGS = [
    "## Plan (summary)",
    "## Answer",
    "## Edge cases & checks",
    "## Next steps",
];
export function buildRewriteSystemPrompt(userPrompt, answerText, critiqueJson) {
    return [
        "You are an expert assistant. Rewrite and improve the following answer based on the critique provided.",
        "",
        "Your rewritten answer MUST include ALL of these section headings (use ## markdown headings):",
        ...REWRITE_REQUIRED_HEADINGS.map((h) => `  ${h}`),
        "",
        "Requirements:",
        "- Address every issue and fix mentioned in the critique.",
        "- Fill in any missing topics identified in the critique.",
        "- Keep the same overall structure but improve clarity and completeness.",
        "- Total response must be at least 200 characters.",
        "",
        "ORIGINAL USER PROMPT:",
        userPrompt,
        "",
        "ORIGINAL ANSWER:",
        answerText,
        "",
        "CRITIQUE:",
        critiqueJson,
    ].join("\n");
}
//# sourceMappingURL=rewrite.js.map