/**
 * Miranda Core — JSON Validation
 * Parse raw LLM output as JSON and validate against a Zod schema.
 */
import type { z } from "zod";
import type { ValidationResult } from "../pipeline/types.js";
/**
 * Validate raw LLM output as JSON against a Zod schema.
 * Strips markdown fences before parsing.
 */
export declare function validateJson<T>(raw: string, schema: z.ZodType<T>): ValidationResult;
//# sourceMappingURL=validateJson.d.ts.map