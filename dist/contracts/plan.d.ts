/**
 * Miranda Core — PLAN Contract
 * Zod schema and system prompt for the PLAN stage.
 */
import { z } from "zod";
export declare const PlanSchema: z.ZodObject<{
    restatement: z.ZodString;
    assumptions: z.ZodArray<z.ZodString, "many">;
    constraints: z.ZodArray<z.ZodString, "many">;
    approach_steps: z.ZodArray<z.ZodString, "many">;
    risks: z.ZodArray<z.ZodString, "many">;
    questions: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    restatement: string;
    assumptions: string[];
    constraints: string[];
    approach_steps: string[];
    risks: string[];
    questions: string[];
}, {
    restatement: string;
    assumptions: string[];
    constraints: string[];
    approach_steps: string[];
    risks: string[];
    questions: string[];
}>;
export type PlanOutput = z.infer<typeof PlanSchema>;
export declare const PLAN_EXAMPLE: PlanOutput;
export declare function buildPlanSystemPrompt(userPrompt: string): string;
//# sourceMappingURL=plan.d.ts.map