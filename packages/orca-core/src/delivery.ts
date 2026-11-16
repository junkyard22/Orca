import type { PappyResult } from "@clawde/pappy-core";
import type { WorkspaceAuthority } from "@clawde/miranda-core";
import { classifyToolVerb, collectExplicitPathArguments } from "@clawde/miranda-core";
import path from "node:path";
import type { TaskContract } from "./taskContract.js";
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

function readRecord(input: BuildDeliveryEnvelopeInput): { performed: boolean; paths: string[] } {
  const reads = [...(input.priorToolEvents ?? []), ...(input.toolEvents ?? [])].filter((event) => {
    if (!event.ok) return false;
    const raw = event.raw as Record<string, unknown> | undefined;
    const authority = raw?._execAuthority as Record<string, unknown> | undefined;
    return classifyToolVerb(event.tool) === "read" || (event.tool === "run_command" && authority?.approval === "confined_read");
  });
  const normalize = (name: string) => {
    const relative = input.workspaceAuthority?.root && path.isAbsolute(name) ? path.relative(input.workspaceAuthority.root, name) : name;
    return relative.replace(/\\/g, "/").replace(/^\.\//, "");
  };
  const paths = [...new Set(reads.flatMap((event) => collectExplicitPathArguments(
    event.raw && typeof event.raw === "object" ? event.raw as Record<string, unknown> : {},
  )).map(normalize))];
  const inspections = input.contract?.expects.filter((e) => e.required && e.outcome.type === "inspection") ?? [];
  return {
    performed: reads.length > 0 && inspections.length > 0 && inspections.every(({ outcome }) =>
      outcome.type === "inspection" && (outcome.paths ?? []).every((p) => paths.includes(normalize(p)))),
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
