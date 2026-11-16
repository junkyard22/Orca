import type { PappyResult } from "@clawde/pappy-core";
import type { WorkspaceAuthority } from "@clawde/miranda-core";
import { classifyToolPermissionRequirement } from "@clawde/miranda-core";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { classifyToolCapability } from "maestro-core";
import type { TaskContract } from "./taskContract.js";
import { boundedWorkspacePath } from "./taskContract.js";
import type { OrcaExecutionResult, OrcaToolEvent } from "./types.js";
import type { TaskLifecycleSnapshot } from "./lifecycle.js";
import type { ToolRefusal } from "./authorization.js";
import { summarizeRefusals } from "./authorization.js";

export type DeliveryOutcome = "answered" | "inspected" | "verified" | "completed_unverified" | "failed" | "blocked" | "stopped";

export interface DeliveryEnvelope {
  outcome: DeliveryOutcome;
  body?: string;
  status: string[];
  /** Preserved separately from the delivery outcome; never upgraded by delivery. */
  verification?: PappyResult["verification"];
  issues?: Array<{ code: string; description: string }>;
  notDone?: string[];
  needsUser?: string;
  narration: "lead_in" | "none";
}

export interface BuildDeliveryEnvelopeInput {
  contract?: TaskContract;
  result: OrcaExecutionResult;
  qcResult?: PappyResult;
  lifecycle?: TaskLifecycleSnapshot;
  workspaceAuthority?: WorkspaceAuthority;
  /** Host-recorded events and authorization decisions, never worker-authored receipts. */
  toolEvents?: readonly OrcaToolEvent[];
  priorToolEvents?: readonly OrcaToolEvent[];
  refusals?: readonly ToolRefusal[];
}

const STATUS: Record<DeliveryOutcome, string> = {
  answered: "Answered without reading any files.",
  inspected: "The explanation was not independently checked.",
  verified: "Verified against the task contract and host-recorded evidence.",
  completed_unverified: "The result is not verified.",
  failed: "Verification failed. This response is not verified.",
  blocked: "The task was blocked. The requested work is not verified.",
  stopped: "The task was stopped. The result is not verified.",
};

/** Interprets only a recorded, successfully completed confined read; never authorizes or executes one. */
function confinedReadPaths(event: OrcaToolEvent, root: string | undefined): string[] {
  const raw = event.raw as Record<string, unknown> | undefined;
  const authority = raw?._execAuthority as Record<string, unknown> | undefined;
  if (event.tool !== "run_command" || !event.ok || raw?._exitCodeForProof !== 0 ||
      authority?.approval !== "confined_read" || authority.filesystemScope !== "host" || authority.confinement !== "none" ||
      typeof raw.command !== "string" || !/^[A-Za-z0-9_.\/\\:-]+(?: [A-Za-z0-9_.\/\\:-]+)*$/.test(raw.command)) return [];
  const cwd = boundedWorkspacePath(raw.cwd === undefined ? "." : typeof raw.cwd === "string" ? raw.cwd : "", root, true);
  if (cwd === undefined || !root) return [];
  try { if (!statSync(path.resolve(root, cwd)).isDirectory()) return []; } catch { return []; }
  const [reader, ...tokens] = raw.command.split(" ");
  if (!["cat", "head", "tail", ...(process.platform === "win32" ? ["type"] : [])].includes(reader!)) return [];
  const operands: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (!["head", "tail"].includes(reader!) || !["-n", "-c"].includes(token) || !/^[1-9][0-9]*$/.test(tokens[++index] ?? "")) return [];
    } else operands.push(token);
  }
  const paths = operands.map((operand) => {
    if (!path.isAbsolute(operand) && operand.includes(":")) return undefined;
    return boundedWorkspacePath(path.resolve(root, cwd, operand.replace(/\\/g, "/")), root, true);
  });
  return paths.some((p) => p === undefined) ? [] : paths as string[];
}

function readRecord(input: BuildDeliveryEnvelopeInput): { performed: boolean; paths: string[] } {
  const root = input.workspaceAuthority?.root;
  if (input.workspaceAuthority?.status !== "ok" || !root) return { performed: false, paths: [] };
  const recordedPath = (name: string, content: boolean): string | undefined => {
    const relative = boundedWorkspacePath(name, root, true);
    if (relative === undefined) return undefined;
    try {
      const actual = realpathSync.native(path.resolve(root, relative));
      if (content && !statSync(actual).isFile()) return undefined;
      const key = path.relative(realpathSync.native(root), actual).replace(/\\/g, "/") || ".";
      return process.platform === "win32" ? key.toLowerCase() : key;
    } catch { return undefined; }
  };
  const reads = [...(input.priorToolEvents ?? []), ...(input.toolEvents ?? [])].flatMap((event) => {
    if (!event.ok) return [];
    let names: string[];
    let content = true;
    if (event.tool === "run_command") {
      names = confinedReadPaths(event, root);
    } else {
      const capability = classifyToolCapability(event.tool);
      if ((capability && ["github-read", "web", "documentation", "document-editing"].includes(capability)) ||
          classifyToolPermissionRequirement(event.tool) !== "file_read") return [];
      const raw = event.raw && typeof event.raw === "object" ? event.raw as Record<string, unknown> : {};
      const matches = (name: string) => event.tool === name || event.tool.endsWith(`_${name}`);
      if (matches("read_file")) names = typeof raw.path === "string" ? [raw.path] : [];
      else if (matches("read_multiple_files")) names = Array.isArray(raw.paths) && raw.paths.every((p) => typeof p === "string") ? raw.paths : [];
      else if (["list_directory", "search_files", "start_search", "get_file_info"].some(matches)) {
        // A listing/search/metadata call establishes workspace activity, not which files' contents were read.
        content = false;
        names = raw.path === undefined ? ["."] : typeof raw.path === "string" ? [raw.path] : [];
      } else return [];
    }
    const paths = names.map((name) => recordedPath(name, content));
    return paths.length && paths.every((p) => p !== undefined) ? [{ paths: paths as string[], content }] : [];
  });
  const paths = [...new Set(reads.flatMap((read) => read.paths))];
  const contentPaths = new Set(reads.filter((read) => read.content).flatMap((read) => read.paths));
  const inspections = input.contract?.expects.filter((e) => e.required && e.outcome.type === "inspection") ?? [];
  return {
    performed: reads.length > 0 && inspections.length > 0 && inspections.every(({ outcome }) =>
      outcome.type === "inspection" && (outcome.paths ?? []).every((p) => {
        const key = recordedPath(p, true);
        return key !== undefined && contentPaths.has(key);
      })),
    paths,
  };
}

function blockingNeed(input: BuildDeliveryEnvelopeInput): string | undefined {
  const { contract, workspaceAuthority } = input;
  if (!contract) return undefined;
  if (contract.evidence.workspace && (workspaceAuthority?.status ?? contract.authority.workspace) !== "ok") {
    return workspaceAuthority?.message || "Choose an existing workspace folder before continuing.";
  }
  const types = contract.expects.filter((e) => e.required).map((e) => e.outcome.type);
  const missing = contract.authority.withheld.filter(({ capability }) =>
    (types.includes("file_change") && (capability === "filesystem-write" || capability === "github-write")) ||
    (types.includes("command") && capability === "shell") ||
    (types.includes("inspection") && capability === "filesystem-read") ||
    (contract.kind !== "conversation" && contract.evidence.external && contract.needs.includes(capability) &&
      ["web", "github-read", "documentation", "document-editing"].includes(capability)));
  return missing.length ? `The request requires unavailable capabilities: ${missing.map((entry) => `${entry.capability} (${entry.reason})`).join(", ")}. Review the task restrictions and authorization before continuing.` : undefined;
}

function notDone(input: BuildDeliveryEnvelopeInput): string[] {
  const actions = (input.refusals ?? []).map((refusal) => summarizeRefusals([refusal]));
  for (const event of [...(input.priorToolEvents ?? []), ...(input.toolEvents ?? [])]) {
    if (!event.ok && /\b(blocked|denied|not approved|not authorized|unavailable)\b|^Unknown tool:|^Workspace required:/i.test(event.summary)) {
      actions.push(`${event.tool}: ${event.summary}`);
    }
  }
  return [...new Set(actions)];
}

/** Formats host/verifier decisions only; it never invokes a model, verifier or repair. */
export function buildDeliveryEnvelope(input: BuildDeliveryEnvelopeInput): DeliveryEnvelope {
  const { result, contract } = input;
  const qc = input.qcResult ?? result.qcResult;
  const reads = readRecord(input);
  const needsUser = blockingNeed(input);
  const lifecycle = input.lifecycle ?? result.lifecycle;
  let outcome: DeliveryOutcome = "completed_unverified";
  if (lifecycle && ["CANCELLING", "CANCELLED", "INTERRUPTED"].includes(lifecycle.state)) outcome = "stopped";
  else if (qc?.verdict === "FAIL" || result.status === "FAIL") outcome = "failed";
  else if (needsUser) outcome = "blocked";
  else if (qc && contract && !contract.kindDisputed) {
    if (contract.kind === "conversation") outcome = "answered";
    else if (contract.kind === "inspect" && reads.performed) outcome = "inspected";
    else if ((contract.kind === "modify" || contract.kind === "execute") && result.status === "SUCCESS" &&
      qc.verdict === "PASS" && qc.verification?.status === "verified" &&
      !qc.receipt_ledger.some((receipt) => receipt.status !== "PROVED") &&
      !qc.issues.some((issue) => issue.severity === "HIGH" || issue.severity === "CRITICAL")) outcome = "verified";
  }
  const status = [STATUS[outcome]];
  if (outcome === "inspected") status.unshift(reads.paths.length ? `Files read or searched: ${reads.paths.join(", ")}.` : "Read/search activity was recorded by the host.");
  if (outcome === "answered" && qc?.verdict === "WARN") status.push(STATUS.completed_unverified);
  if (contract?.kindDisputed && outcome === "completed_unverified") status.push("Orca treated this as a question and changed nothing.");
  const issues = qc?.issues.filter((issue) => qc.verdict === "FAIL" || outcome === "failed" || qc.verdict === "WARN" ||
    (outcome === "completed_unverified" && issue.severity !== "LOW"));
  const undone = notDone(input);
  return {
    outcome, body: result.userFacingText ?? result.summary, status,
    ...(qc?.verification ? { verification: structuredClone(qc.verification) } : {}),
    ...(issues?.length ? { issues: issues.map(({ code, description }) => ({ code, description })) } : {}),
    ...(undone.length ? { notDone: undone } : {}),
    ...(outcome === "blocked" && needsUser ? { needsUser } : {}),
    narration: outcome === "verified" ? "lead_in" : "none",
  };
}
