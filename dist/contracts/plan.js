/**
 * Miranda Core — PLAN Contract
 * Zod schema and system prompt for the PLAN stage.
 */
import { z } from "zod";
export const PlanSchema = z.object({
    restatement: z.string().min(1, "restatement is required"),
    assumptions: z.array(z.string()),
    constraints: z.array(z.string()),
    approach_steps: z.array(z.string()).min(1, "at least one approach step is required"),
    risks: z.array(z.string()),
    questions: z.array(z.string()),
});
export const PLAN_EXAMPLE = {
    restatement: "The user wants to understand how binary search works.",
    assumptions: ["The user has basic programming knowledge."],
    constraints: ["Must explain with code examples."],
    approach_steps: [
        "Define binary search",
        "Explain the algorithm step by step",
        "Provide a code example",
        "Discuss time complexity",
    ],
    risks: ["User may not know what a sorted array is."],
    questions: [],
};
export function buildPlanSystemPrompt(userPrompt) {
    return [
        "You are an expert assistant. Your task is to create a structured plan for answering the user's question.",
        "",
        "You MUST respond with ONLY valid JSON — no markdown fences, no prose, no explanation.",
        "The JSON must conform to this exact schema:",
        "",
        JSON.stringify({
            restatement: "string — restate what the user is asking",
            assumptions: "string[] — assumptions you are making",
            constraints: "string[] — constraints to respect",
            approach_steps: "string[] — ordered steps to answer the question",
            risks: "string[] — potential issues or gaps",
            questions: "string[] — clarifying questions (empty if none)",
        }, null, 2),
        "",
        "USER PROMPT:",
        userPrompt,
    ].join("\n");
}
//# sourceMappingURL=plan.js.map