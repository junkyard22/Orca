/**
 * Miranda Core — Repair Prompts
 * Template strings for escalating repair system prompts.
 */
/**
 * Build a repair system prompt for JSON stages.
 * Escalates strictness based on attempt number.
 */
export declare function buildJsonRepairPrompt(attemptNumber: number, schemaDescription: string, exampleJson: string, previousOutput: string, validationErrors: string[]): string;
/**
 * Build a repair system prompt for text stages.
 * Escalates strictness based on attempt number.
 */
export declare function buildTextRepairPrompt(attemptNumber: number, requiredHeadings: string[], previousOutput: string, validationErrors: string[]): string;
//# sourceMappingURL=repairPrompts.d.ts.map