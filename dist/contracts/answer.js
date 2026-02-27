/**
 * Miranda Core — ANSWER Contract
 * Required headings and system prompt for the ANSWER stage.
 */
export const ANSWER_REQUIRED_HEADINGS = [
    "## Plan (summary)",
    "## Answer",
    "## Edge cases & checks",
    "## Next steps",
];
export function buildAnswerSystemPrompt(userPrompt, planJson) {
    return [
        "You are an expert assistant. Write a comprehensive answer to the user's question.",
        "",
        "Your answer MUST include ALL of these section headings (use ## markdown headings):",
        ...ANSWER_REQUIRED_HEADINGS.map((h) => `  ${h}`),
        "",
        "Requirements:",
        "- Start with a Plan (summary) section that briefly summarizes your approach.",
        "- The Answer section must be thorough and well-structured.",
        "- Edge cases & checks must identify potential issues or caveats.",
        "- Next steps must suggest follow-up actions or further reading.",
        "- Total response must be at least 200 characters.",
        "",
        "PLAN (for context):",
        planJson,
        "",
        "USER PROMPT:",
        userPrompt,
    ].join("\n");
}
//# sourceMappingURL=answer.js.map