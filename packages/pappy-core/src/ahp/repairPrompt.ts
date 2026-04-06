/**
 * AHP Repair Prompt Builder
 *
 * Generates a targeted repair prompt for WARN/FAIL AHP verdicts.
 *
 * The prompt is designed to be passed directly to the worker agent as the
 * `originalUserMessage` of a repair task.  Unlike the legacy `buildRepairTask`
 * (which works from Pappy's Issue list), this builder works from AHP acceptance
 * criteria results — naming each failed AC, quoting its failure evidence, and
 * giving a one-line correction directive.
 *
 * The output deliberately avoids restating the full original task; it targets
 * only the exact criteria that were not met.
 */

import type { AHPPacket } from "@clawde/miranda-core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface ACFailure {
  /** Identifier string, e.g. "PAC2". */
  id:       string;
  /** The original acceptance criterion text. */
  ac:       string;
  /** Evidence string produced by checkACAgainstOutput() or fileVerifier. */
  evidence: string;
}

export interface SchemaInfo {
  passed:      boolean;
  missingKeys: string[];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a targeted repair prompt for a WARN or FAIL AHP verdict.
 *
 * @param packet     - The AHPPacket being verified (objective used for context).
 * @param failedACs  - AC results where passed === false.
 * @param schemaInfo - Whether the schema check passed and which keys are missing.
 * @returns A string prompt ready to use as the repair `originalUserMessage`.
 */
export function buildAHPRepairPrompt(
  packet:     AHPPacket,
  failedACs:  ACFailure[],
  schemaInfo: SchemaInfo,
): string {
  const lines: string[] = [];

  lines.push(
    `Your previous response did not fully satisfy all acceptance criteria for:`,
    `  "${packet.objective}"`,
    ``,
    `The following criteria were not met:`,
    ``,
  );

  for (const { id, ac, evidence } of failedACs) {
    lines.push(`[${id}: ${ac}] FAILED — ${evidence}`);
    lines.push(`  → Specifically address: "${ac}". Evidence of failure: ${evidence}.`);
    lines.push(``,);
  }

  if (!schemaInfo.passed && schemaInfo.missingKeys.length > 0) {
    lines.push(
      `The response is also missing expected schema keys: ${schemaInfo.missingKeys.join(", ")}.`,
      `  → Ensure your output includes references to each of these keys: ${schemaInfo.missingKeys.join(", ")}.`,
      ``,
    );
  }

  lines.push(`Do not restate the full task. Only address the items listed above.`);

  return lines.join("\n");
}
