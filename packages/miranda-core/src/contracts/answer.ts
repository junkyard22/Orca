/**
 * @deprecated LEGACY MULTI-STAGE PIPELINE — DO NOT EXTEND.
 *
 * Architectural boundary:
 *   Miranda is a compliance gate, not a response pipeline.
 *   The live Orca path uses createDirectLLMService + agent-loop-core.
 *   Do not extend the Miranda plan/answer/critique/rewrite pipeline.
 *   Future Miranda work must be gate-shaped: PASS / WARN / BLOCK / CONFIRM_REQUIRED.
 *
 * Miranda Core — ANSWER Contract (legacy)
 * Required headings and system prompt for the ANSWER stage.
 */

export const ANSWER_REQUIRED_HEADINGS = [
  "## Plan (summary)",
  "## Answer",
  "## Edge cases & checks",
  "## Next steps",
];

export function buildAnswerSystemPrompt(
  userPrompt: string,
  planJson: string
): string {
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
