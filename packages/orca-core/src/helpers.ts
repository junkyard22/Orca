import type { PappyInput } from "@clawde/pappy-core";
import type { OrcaTaskSpec, OrcaMaestroResult } from "./types.js";

/**
 * Map a task spec + Maestro's structured result into the shape Pappy expects.
 * OrcaTaskSpec.constraints (Record<string,unknown>) is narrowed to Pappy's
 * known keys; any unknown keys are silently dropped.
 */
export function buildPappyInput(
  taskSpec: OrcaTaskSpec,
  maestroResult: OrcaMaestroResult,
): PappyInput {
  const raw = taskSpec.constraints ?? {};
  return {
    task: taskSpec.originalUserMessage,
    // Brain-defined done criteria take precedence; fall back to task goals.
    goals: maestroResult.doneCriteria ?? taskSpec.goals,
    outputText:   maestroResult.outputText,
    filesChanged: maestroResult.filesChanged,
    toolEvents:   maestroResult.toolEvents,
    constraints: {
      forbidDeletes:   raw["forbidDeletes"]   as boolean  | undefined,
      requireFiles:    raw["requireFiles"]    as string[] | undefined,
      requireSections: raw["requireSections"] as string[] | undefined,
    },
  };
}
