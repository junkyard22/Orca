/**
 * Miranda Core — CRITIQUE Contract
 * Zod schema and system prompt for the CRITIQUE stage.
 */
import { z } from "zod";
export declare const CritiqueIssueSchema: z.ZodObject<{
    severity: z.ZodEnum<["low", "med", "high"]>;
    issue: z.ZodString;
    impact: z.ZodString;
}, "strip", z.ZodTypeAny, {
    severity: "low" | "med" | "high";
    issue: string;
    impact: string;
}, {
    severity: "low" | "med" | "high";
    issue: string;
    impact: string;
}>;
export declare const CritiqueFixSchema: z.ZodObject<{
    fix: z.ZodString;
    reason: z.ZodString;
}, "strip", z.ZodTypeAny, {
    fix: string;
    reason: string;
}, {
    fix: string;
    reason: string;
}>;
export declare const CritiqueSchema: z.ZodObject<{
    issues: z.ZodArray<z.ZodObject<{
        severity: z.ZodEnum<["low", "med", "high"]>;
        issue: z.ZodString;
        impact: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        severity: "low" | "med" | "high";
        issue: string;
        impact: string;
    }, {
        severity: "low" | "med" | "high";
        issue: string;
        impact: string;
    }>, "many">;
    fixes: z.ZodArray<z.ZodObject<{
        fix: z.ZodString;
        reason: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        fix: string;
        reason: string;
    }, {
        fix: string;
        reason: string;
    }>, "many">;
    missing: z.ZodArray<z.ZodString, "many">;
    confidence: z.ZodEnum<["low", "med", "high"]>;
}, "strip", z.ZodTypeAny, {
    issues: {
        severity: "low" | "med" | "high";
        issue: string;
        impact: string;
    }[];
    fixes: {
        fix: string;
        reason: string;
    }[];
    missing: string[];
    confidence: "low" | "med" | "high";
}, {
    issues: {
        severity: "low" | "med" | "high";
        issue: string;
        impact: string;
    }[];
    fixes: {
        fix: string;
        reason: string;
    }[];
    missing: string[];
    confidence: "low" | "med" | "high";
}>;
export type CritiqueOutput = z.infer<typeof CritiqueSchema>;
export declare const CRITIQUE_EXAMPLE: CritiqueOutput;
export declare function buildCritiqueSystemPrompt(userPrompt: string, answerText: string): string;
//# sourceMappingURL=critique.d.ts.map