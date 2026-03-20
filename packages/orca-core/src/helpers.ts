import type { PappyInput } from "@clawde/pappy-core";
import type { OrcaTaskSpec, OrcaMaestroResult, OrcaFileChange, OrcaToolEvent, TaskPermissions } from "./types.js";

const READ_ONLY_TOOLS = [
  "read_file",
  "list_directory",
  "search_files",
  "docs_read",
  "docs_list",
];

const WRITE_TOOLS = ["write_file"];

const SHELL_TOOLS = ["run_command"];

const NETWORK_TOOLS = [
  "web_fetch",
  "web_search",
  "github_list_prs",
  "github_get_pr",
  "github_list_issues",
];

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
    Array.isArray(record["toolsAllowed"])
  );
}

export function normalizeTaskPermissions(input: unknown): TaskPermissions | undefined {
  if (!input) return undefined;

  if (looksLikeTaskPermissions(input)) {
    return {
      fileRead: input.fileRead,
      fileWrite: input.fileWrite,
      shellExec: input.shellExec,
      toolsAllowed: uniqueStrings(input.toolsAllowed),
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
  const networkAccess = permissions.has("network");

  return {
    fileRead: true,
    fileWrite,
    shellExec,
    toolsAllowed: uniqueStrings([
      ...READ_ONLY_TOOLS,
      ...(fileWrite ? WRITE_TOOLS : []),
      ...(shellExec ? SHELL_TOOLS : []),
      ...(networkAccess ? NETWORK_TOOLS : []),
    ]),
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
