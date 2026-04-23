import type { PappyInput } from "@clawde/pappy-core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { AHPLifecycle, AHPVerdict } from "./ahp/types.js";
import type { OrcaTaskSpec, OrcaMaestroResult, OrcaFileChange, OrcaToolEvent, TaskPermissions } from "./types.js";

const FILE_CHANGE_COMMENT_RE = /<!--\s*Files changed:\s*([\s\S]*?)\s*-->/i;
const MAX_DIFF_CHARS = 2_000;
const MAX_DIFF_FILE_BYTES = 256_000;

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
  const normalizedTool = tool.startsWith("desktop-commander_")
    ? tool.slice("desktop-commander_".length)
    : tool;

  switch (normalizedTool) {
    case "create_file":
      return "A";
    case "delete_file":
      return "D";
    case "write_file":
    case "modify_file":
    case "edit_block":
      return "M";
    default:
      return undefined;
  }
}

function truncateDiff(content: string | undefined): string | undefined {
  return content ? content.slice(0, MAX_DIFF_CHARS) : undefined;
}

function mergeFileChange(byPath: Map<string, OrcaFileChange>, next: OrcaFileChange): void {
  const current = byPath.get(next.path);
  if (!current) {
    byPath.set(next.path, next);
    return;
  }

  const changeType = current.changeType !== "A" && next.changeType === "A"
    ? "A"
    : current.changeType;
  const diff = next.diff ?? current.diff;
  byPath.set(next.path, { ...current, changeType, diff });
}

function normalizeFileChangePath(rawPath: string, workspaceRoot?: string, absolutePath?: string): string {
  if (!workspaceRoot || !absolutePath) {
    return rawPath.replace(/\\/g, "/");
  }

  const relativePath = relative(workspaceRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return rawPath.replace(/\\/g, "/");
  }

  return relativePath.replace(/\\/g, "/");
}

function resolveWorkspaceLikeAbsolutePath(
  rawPath: string,
  workspaceRoot?: string,
  baseDir?: string,
): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return undefined;

  const candidateSuffix = rawPath.replace(/^\/+/, "");
  const workspaceCandidate = workspaceRoot
    ? resolve(workspaceRoot, candidateSuffix)
    : undefined;
  if (workspaceCandidate && existsSync(workspaceCandidate)) {
    return workspaceCandidate;
  }

  const baseCandidate = baseDir ? resolve(baseDir, candidateSuffix) : undefined;
  if (baseCandidate && existsSync(baseCandidate)) {
    return baseCandidate;
  }

  return workspaceCandidate ?? baseCandidate;
}

function resolveCommandBaseDir(workspaceRoot?: string, cwd?: string): string | undefined {
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    const workspaceLike = resolveWorkspaceLikeAbsolutePath(cwd, workspaceRoot, workspaceRoot);
    if (workspaceLike) return workspaceLike;
    return workspaceRoot && !isAbsolute(cwd) ? resolve(workspaceRoot, cwd) : cwd;
  }
  return workspaceRoot;
}

function readDiffFromDisk(filePath: string | undefined): string | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;

  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_DIFF_FILE_BYTES) return undefined;

    const content = readFileSync(filePath, "utf8");
    if (content.includes("\u0000")) return undefined;
    return truncateDiff(content);
  } catch {
    return undefined;
  }
}

function extractEmbeddedFileChanges(raw: unknown): OrcaFileChange[] {
  if (!raw || typeof raw !== "object") return [];

  const record = raw as Record<string, unknown>;
  const embedded = record["_filesChangedForDiff"];
  if (!Array.isArray(embedded)) return [];

  return embedded.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];

    const file = entry as Record<string, unknown>;
    const path = typeof file["path"] === "string" ? file["path"].trim() : "";
    const changeType = file["changeType"];
    if (!path || (changeType !== "A" && changeType !== "M" && changeType !== "D")) {
      return [];
    }

    const diff = typeof file["diff"] === "string" ? truncateDiff(file["diff"]) : undefined;
    return [{ path, changeType, diff }];
  });
}

export function extractFilesChangedFromCommandOutput(
  output: string,
  options: { workspaceRoot?: string; cwd?: string } = {},
): OrcaFileChange[] {
  const match = output.match(FILE_CHANGE_COMMENT_RE);
  if (!match?.[1]) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const baseDir = resolveCommandBaseDir(options.workspaceRoot, options.cwd);
  const byPath = new Map<string, OrcaFileChange>();

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;

    const file = entry as Record<string, unknown>;
    const rawPath = typeof file["path"] === "string" ? file["path"].trim() : "";
    const changeType = file["changeType"];
    if (!rawPath || (changeType !== "A" && changeType !== "M" && changeType !== "D")) {
      continue;
    }

    const workspaceLikeAbsolute = resolveWorkspaceLikeAbsolutePath(rawPath, options.workspaceRoot, baseDir);
    const absolutePath = workspaceLikeAbsolute ?? (
      isAbsolute(rawPath)
        ? rawPath
        : baseDir
          ? resolve(baseDir, rawPath)
          : undefined
    );
    const path = normalizeFileChangePath(rawPath, options.workspaceRoot, absolutePath);
    const diff = changeType === "D" ? undefined : readDiffFromDisk(absolutePath);
    mergeFileChange(byPath, { path, changeType, diff });
  }

  return [...byPath.values()];
}

export function deriveFilesChangedFromToolEvents(
  toolEvents: OrcaToolEvent[] | undefined,
  existingFilesChanged: OrcaFileChange[] = [],
): OrcaFileChange[] {
  const byPath = new Map<string, OrcaFileChange>();

  for (const file of existingFilesChanged) {
    mergeFileChange(byPath, file);
  }

  for (const event of toolEvents ?? []) {
    if (!event.ok) continue;

    for (const file of extractEmbeddedFileChanges(event.raw)) {
      mergeFileChange(byPath, file);
    }

    const path = extractToolPath(event.raw);
    const changeType = changeTypeForTool(event.tool);
    if (!path || !changeType) continue;

    // Fix 3: Capture file content for diff verification
    const content = (event.raw as Record<string, unknown>)._contentForDiff as string | undefined;
    const diff = truncateDiff(content);
    mergeFileChange(byPath, { path, changeType, diff });
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
          ...(normalizedResult.metadata.auditResult !== undefined ? { audit: normalizedResult.metadata.auditResult } : {}),
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
