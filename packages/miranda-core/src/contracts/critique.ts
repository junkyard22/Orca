/**
 * @deprecated LEGACY MULTI-STAGE PIPELINE — DO NOT EXTEND.
 *
 * Architectural boundary:
 *   Miranda is a compliance gate, not a response pipeline.
 *   The live Orca path uses createDirectLLMService + agent-loop-core.
 *   Do not extend the Miranda plan/answer/critique/rewrite pipeline.
 *   Future Miranda work must be gate-shaped: PASS / WARN / BLOCK / CONFIRM_REQUIRED.
 *
 * Miranda Core — CRITIQUE Contract (legacy)
 * Zod schema and system prompt for the CRITIQUE stage.
 */

import { z } from "zod";

const SeverityEnum = z.enum(["low", "med", "high"]);
const ConfidenceEnum = z.enum(["low", "med", "high"]);

export const CritiqueIssueSchema = z.object({
  severity: SeverityEnum,
  issue: z.string().min(1),
  impact: z.string().min(1),
});

export const CritiqueFixSchema = z.object({
  fix: z.string().min(1),
  reason: z.string().min(1),
});

export const CritiqueSchema = z.object({
  issues: z.array(CritiqueIssueSchema),
  fixes: z.array(CritiqueFixSchema),
  missing: z.array(z.string()),
  confidence: ConfidenceEnum,
});

export type CritiqueOutput = z.infer<typeof CritiqueSchema>;

export const CRITIQUE_EXAMPLE: CritiqueOutput = {
  issues: [
    {
      severity: "low",
      issue: "Code example lacks error handling",
      impact: "Reader may not understand edge cases",
    },
  ],
  fixes: [
    {
      fix: "Add error handling to the code example",
      reason: "Makes the example more production-ready",
    },
  ],
  missing: ["Mention of iterative vs recursive approaches"],
  confidence: "high",
};

export function buildCritiqueSystemPrompt(
  userPrompt: string,
  answerText: string
): string {
  return [
    "You are an expert reviewer. Critique the following answer for accuracy, completeness, and clarity.",
    "",
    "You MUST respond with ONLY valid JSON — no markdown fences, no prose, no explanation.",
    "The JSON must conform to this exact schema:",
    "",
    JSON.stringify(
      {
        issues: [
          {
            severity: '"low" | "med" | "high"',
            issue: "string — description of the issue",
            impact: "string — impact of the issue",
          },
        ],
        fixes: [
          {
            fix: "string — suggested fix",
            reason: "string — why this fix is needed",
          },
        ],
        missing: ["string — topics or details that are missing"],
        confidence: '"low" | "med" | "high" — overall confidence in the answer',
      },
      null,
      2
    ),
    "",
    "ORIGINAL USER PROMPT:",
    userPrompt,
    "",
    "ANSWER TO CRITIQUE:",
    answerText,
  ].join("\n");
}
