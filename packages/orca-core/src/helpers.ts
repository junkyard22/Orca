import type { PappyInput } from "@clawde/pappy-core";
import { AHPLifecycle, AHPVerdict } from "./ahp/types.js";
import type { OrcaTaskSpec, OrcaMaestroResult, OrcaFileChange, OrcaToolEvent, TaskPermissions } from "./types.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function looksLikeTaskPermissions(value: unknown): value is TaskPermissions {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record["fileRead"] === "boolean" &&
    typeof record["fileWrite"] === "boolean" &&
    typeof record["shellExec"] === "boolean" &&
    (record["toolsAllowed"] === undefined || Array.isArray(record["toolsAllowed"]))
  );
}

export function normalizeTaskPermissions(input: unknown): TaskPermissions | undefined {
  if (!input) return undefined;

  if (looksLikeTaskPermissions(input)) {
    return {
      fileRead: input.fileRead,
      fileWrite: input.fileWrite,
      shellExec: input.shellExec,
      ...(input.toolsAllowed !== undefined && { toolsAllowed: uniqueStrings(input.toolsAllowed) }),
    };
  }

  if (!Array.isArray(input)) return undefined;

  const permissions = new Set(
    input
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase()),
  );

  const fileWrite = permissions.has("write");
  const shellExec = permissions.has("shell");

  // Intentionally no toolsAllowed whitelist here — the boolean flags
  // (fileWrite, shellExec) already drive the LLM execution-limit text.
  // Setting a static whitelist would silently block dynamic MCP tools.
  return {
    fileRead: true,
    fileWrite,
    shellExec,
  };
}

export function normalizeTaskSpec(taskSpec: OrcaTaskSpec): OrcaTaskSpec {
  const normalizedPermissions = normalizeTaskPermissions((taskSpec as { permissions?: unknown }).permissions);
  if (normalizedPermissions === undefined) return taskSpec;

  return {
    ...taskSpec,
    permissions: normalizedPermissions,
  };
}

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
  const ahpNonCompleteChildren = (normalizedResult.ahpChildPackets ?? [])
    .filter((packet) =>
      packet.lifecycle !== AHPLifecycle.COMPLETE ||
      (packet.verdict !== undefined && packet.verdict !== AHPVerdict.PASS)
    )
    .map((packet) => ({
      id: packet.id,
      role: String(packet.role),
      lifecycle: String(packet.lifecycle),
      verdict: packet.verdict === undefined ? undefined : String(packet.verdict),
      objective: packet.objective,
    }));
  return {
    task: taskSpec.originalUserMessage,
    // Brain-defined done criteria take precedence; fall back to task goals.
    goals: normalizedResult.doneCriteria ?? taskSpec.goals,
    outputText: normalizedResult.outputText,
    filesChanged: normalizedResult.filesChanged,
    toolEvents: normalizedResult.toolEvents,
    metadata: normalizedResult.metadata
      ? {
          stoppedBecause: normalizedResult.metadata.stoppedBecause,
          loopEvidence: normalizedResult.metadata.loopEvidence,
          ...(ahpNonCompleteChildren.length > 0 ? { ahpNonCompleteChildren } : {}),
        }
      : ahpNonCompleteChildren.length > 0
        ? { ahpNonCompleteChildren }
        : undefined,
    constraints: {
      forbidDeletes:   raw["forbidDeletes"]   as boolean  | undefined,
      requireFiles:    raw["requireFiles"]    as string[] | undefined,
      requireSections: raw["requireSections"] as string[] | undefined,
    },
  };
}
