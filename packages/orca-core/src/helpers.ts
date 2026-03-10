import type { PappyInput } from "@clawde/pappy-core";
import type { OrcaTaskSpec, OrcaMaestroResult, OrcaFileChange, OrcaToolEvent } from "./types.js";

function pathMatches(candidate: string, expected: string): boolean {
  return candidate === expected || candidate.endsWith(expected) || expected.endsWith(candidate);
}

function extractToolPath(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const record = raw as Record<string, unknown>;
  const candidate = record["path"] ?? record["filePath"];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function changeTypeForTool(tool: string): OrcaFileChange["changeType"] | undefined {
  switch (tool) {
    case "create_file":
      return "A";
    case "delete_file":
      return "D";
    case "write_file":
    case "modify_file":
      return "M";
    default:
      return undefined;
  }
}

export function deriveFilesChangedFromToolEvents(
  toolEvents: OrcaToolEvent[] | undefined,
  existingFilesChanged: OrcaFileChange[] = [],
): OrcaFileChange[] {
  const byPath = new Map<string, OrcaFileChange>();

  for (const file of existingFilesChanged) {
    byPath.set(file.path, file);
  }

  for (const event of toolEvents ?? []) {
    if (!event.ok) continue;

    const path = extractToolPath(event.raw);
    const changeType = changeTypeForTool(event.tool);
    if (!path || !changeType) continue;

    // Fix 3: Capture file content for diff verification
    const content = (event.raw as Record<string, unknown>)._contentForDiff as string | undefined;
    const diff = content ? content.slice(0, 2000) : undefined; // Truncate for storage

    const current = byPath.get(path);
    if (!current) {
      byPath.set(path, { path, changeType, diff });
      continue;
    }

    if (current.changeType !== "A" && changeType === "A") {
      byPath.set(path, { ...current, changeType, diff });
    } else if (diff) {
      // Update existing entry with diff if available
      byPath.set(path, { ...current, diff });
    }
  }

  return [...byPath.values()];
}

export function normalizeMaestroResult(maestroResult: OrcaMaestroResult): OrcaMaestroResult {
  const filesChanged = deriveFilesChangedFromToolEvents(
    maestroResult.toolEvents,
    maestroResult.filesChanged ?? maestroResult.metadata?.filesChanged ?? [],
  );

  if (
    filesChanged === maestroResult.filesChanged &&
    filesChanged === maestroResult.metadata?.filesChanged
  ) {
    return maestroResult;
  }

  return {
    ...maestroResult,
    filesChanged,
    metadata: {
      ...maestroResult.metadata,
      filesChanged,
    },
  };
}

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
  const normalizedResult = normalizeMaestroResult(maestroResult);
  return {
    task: taskSpec.originalUserMessage,
    // Brain-defined done criteria take precedence; fall back to task goals.
    goals: normalizedResult.doneCriteria ?? taskSpec.goals,
    outputText: normalizedResult.outputText,
    filesChanged: normalizedResult.filesChanged,
    toolEvents: normalizedResult.toolEvents,
    constraints: {
      forbidDeletes:   raw["forbidDeletes"]   as boolean  | undefined,
      requireFiles:    raw["requireFiles"]    as string[] | undefined,
      requireSections: raw["requireSections"] as string[] | undefined,
    },
  };
}
