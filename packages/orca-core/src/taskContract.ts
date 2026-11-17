import type { BrainContractProposal, CapabilityGroup, ChangeKind, ExpectedOutcome, TaskIntentKind } from "maestro-core";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { validateContractProposal } from "maestro-core";
import type { WorkspaceAuthorityStatus } from "@clawde/miranda-core";
import { classifyTaskKind } from "@clawde/pappy-core";
import { buildAcceptanceContract, relatesToRequest } from "./acceptanceContract.js";
import type { AcceptanceContract } from "./acceptanceContract.js";
import type { OrcaTaskSpec } from "./types.js";

// Brain's proposal — its shape and its validator — is owned by maestro-core,
// where Brain's decision is parsed (maestro-core cannot import this package).
// Re-exported here unchanged so existing importers keep working; there is one
// validator, not two.
export { validateContractProposal };
export type { TaskIntentKind, ChangeKind, ExpectedOutcome, BrainContractProposal };

export interface ContractOutcome {
  outcome: ExpectedOutcome;
  source: "user" | "brain" | "runtime";
  required: boolean;
}

export interface ResolvedAuthority {
  workspace: WorkspaceAuthorityStatus;
  available: CapabilityGroup[];
  withheld: Array<{
    capability: CapabilityGroup;
    reason: "settings" | "user_prohibition" | "task_kind" | "no_workspace";
  }>;
}

export interface TaskContract {
  version: 1;
  source: "intake" | "brain" | "fallback";
  /** Verbatim user request, independent of the display label and proposal. */
  request: string;
  kind: TaskIntentKind;
  kindDisputed?: boolean;
  changeKind?: ChangeKind;
  needs: CapabilityGroup[];
  prohibits: CapabilityGroup[];
  evidence: { workspace: boolean; external: boolean };
  expects: ContractOutcome[];
  acceptance: AcceptanceContract;
  authority: ResolvedAuthority;
}

export interface BuildTaskContractInput {
  task: OrcaTaskSpec;
  proposal: BrainContractProposal;
  ceiling: CapabilityGroup[];
  workspace: WorkspaceAuthorityStatus;
  workspaceRoot?: string;
  attachedFiles?: boolean;
}

const LOCAL_CAPABILITIES: readonly CapabilityGroup[] = ["filesystem-read", "filesystem-write", "shell"];
const WRITE_CAPABILITIES: readonly CapabilityGroup[] = ["filesystem-write", "github-write"];
const EXTERNAL_CAPABILITIES: readonly CapabilityGroup[] = ["web", "github-read", "github-write", "documentation", "document-editing"];

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const COMMAND_ACTIVITIES = {
  test: "run the tests", build: "run the build", lint: "run lint", typecheck: "run the type check",
} as const;

function commandPurpose(request: string): Extract<ExpectedOutcome, { type: "command" }>["purpose"] {
  for (const purpose of ["test", "build", "lint", "typecheck"] as const) {
    if (relatesToRequest(COMMAND_ACTIVITIES[purpose], request)) return purpose;
  }
  return "other";
}

function impliedOutcomes(kind: TaskIntentKind, workspace: boolean, request: string, paths: string[]): ContractOutcome[] {
  const outcomes: ExpectedOutcome[] = kind === "modify"
    ? (paths.length ? paths.map((path, index): ExpectedOutcome => ({ id: `runtime:file_change:${index}`, type: "file_change", change: "any", path }))
      : [{ id: "runtime:file_change", type: "file_change", change: "any" }])
    : [{ id: "runtime:no_file_change", type: "no_file_change" }];
  if (kind === "inspect" && workspace) outcomes.push({ id: "runtime:inspection", type: "inspection", ...(paths.length ? { paths: [...paths] } : {}) });
  if (kind === "execute") outcomes.push({ id: "runtime:command", type: "command", purpose: commandPurpose(request), mustPass: false });
  return outcomes.map((outcome) => ({ outcome, source: "runtime", required: true }));
}

function outside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Internal shared boundary, never an authority source. Brain outcomes use the relative-only default. */
export function boundedWorkspacePath(raw: string, root: string | undefined, allowAbsolute = false): string | undefined {
  const normalized = raw.replace(/\\/g, "/");
  const absolute = path.isAbsolute(normalized);
  if (!root || !path.isAbsolute(root) || (!allowAbsolute && absolute) ||
      (!absolute && path.win32.isAbsolute(raw)) || normalized.split("/").includes("..")) return undefined;
  // Only a native absolute drive prefix may contain a colon; reject drive-relative paths and ADS.
  if (normalized.includes(":") && !(absolute && /^[A-Za-z]:\//.test(normalized) && !normalized.slice(2).includes(":"))) return undefined;
  const candidate = path.resolve(root, normalized);
  if (outside(root, candidate)) return undefined;
  try {
    const realRoot = realpathSync.native(root);
    let ancestor = candidate;
    for (;;) {
      try { lstatSync(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
    const real = path.resolve(realpathSync.native(ancestor), path.relative(ancestor, candidate));
    if (outside(realRoot, real)) return undefined;
    return path.relative(root, candidate).replace(/\\/g, "/") || ".";
  } catch { return undefined; }
}

function requestPaths(request: string, root: string | undefined): string[] {
  const paths: string[] = [];
  // Quoted paths may contain spaces. Bare tokens are checked against the actual filesystem;
  // no vocabulary decides the kind floor and no scan of the workspace is needed.
  const tokens = request.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s`"'()[\]{},;!?]+)/g);
  for (const match of tokens) {
    const token = (match[1] ?? match[2] ?? match[3] ?? match[4]!).replace(/[.:]+$/, "");
    const bounded = boundedWorkspacePath(token, root, true);
    if (bounded && (/[./\\]/.test(token) || existsSync(path.resolve(root!, bounded)))) paths.push(bounded);
  }
  return [...new Set(paths)];
}

function boundOutcome(expected: ExpectedOutcome, root: string | undefined): ExpectedOutcome | undefined {
  if (expected.type === "file_change" && expected.path !== undefined) {
    const path = boundedWorkspacePath(expected.path, root);
    return path === undefined ? undefined : { ...expected, path };
  }
  if (expected.type === "inspection" && expected.paths !== undefined) {
    const paths = expected.paths.map((p) => boundedWorkspacePath(p, root));
    return paths.some((p) => p === undefined) ? undefined : { ...expected, paths: paths as string[] };
  }
  return expected;
}

function related(expected: ExpectedOutcome, request: string, paths: string[], kind: TaskIntentKind): boolean {
  switch (expected.type) {
    case "answer": return relatesToRequest(expected.text, request);
    case "inspection": return expected.paths?.length ? expected.paths.every((p) => paths.includes(p)) : kind === "inspect";
    case "file_change": return expected.path !== undefined ? paths.includes(expected.path) : kind === "modify";
    case "command": return expected.purpose === "other" ? /\b(run|execute|command)\b/i.test(request)
      : relatesToRequest(COMMAND_ACTIVITIES[expected.purpose], request);
    case "no_file_change": return kind !== "modify" || relatesToRequest("Do not change files", request);
  }
}

/**
 * The dispute tripwire checks requests to act, not verbs inside a how-to.
 * Keep independent instructions after a question (including a coordinated
 * named-file request). This only filters the tripwire's input: Pappy's
 * classifier, fallback routing, the kind floor and authority stay unchanged.
 */
function disputeRequestText(request: string): string {
  const instructional = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:how\s+(?:(?:do|can|could|should|would)\s+(?:i|we|one|you)\b|to\b)|(?:explain|describe|show\s+me|tell\s+me)\s+how\b)/i;
  // An explicit "for me" request can refer back to tests/code without a
  // filename. Split it before filtering the instructional part; a second
  // "how to" clause still remains instructional and is filtered separately.
  return request.split(/(?<=[.!?;])\s+|[\r\n]+|\s+(?:and\s+)?then\s+|\s+but\s+|,\s*(?=(?:then|please|also)\b)|\s+and\s+(?=(?:please\b|(?:can|could|would|will)\s+you\b)|[^.!?;\n]*\bfor\s+me\b|[^.!?;\n]*\b[\w/-]+\.[a-z0-9]{1,8}\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => !instructional.test(clause))
    .join("\n");
}

/** Builds a detached, immutable standard before worker execution. */
export function buildTaskContract(input: BuildTaskContractInput): TaskContract {
  const { task, ceiling, workspace } = input;
  const proposal = validateContractProposal(input.proposal);
  const request = task.originalUserMessage;
  const paths = requestPaths(request, input.workspaceRoot);
  const hasExistingPath = paths.some((p) => existsSync(path.resolve(input.workspaceRoot!, p)));
  const kind = proposal.kind === "conversation" && (hasExistingPath || input.attachedFiles) ? "inspect" : proposal.kind;
  const changeRequest = disputeRequestText(request);
  const classified = classifyTaskKind(changeRequest);
  // Pappy's classifier can call an explicit file edit "other" (for example,
  // "Fix src/parse.ts"). Preserve the dispute for an independent directive.
  const changeDirective = /^(?:(?:then|also|please)\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:fix|correct|update|modify|change|edit|create|add|implement|build|write|remove|delete|replace|refactor)\b/im.test(changeRequest);
  const kindDisputed = proposal.kind !== "modify" && ((classified !== "inspect" && classified !== "other") || changeDirective);
  const needs = [...new Set(proposal.needs ?? [])];
  const prohibits = [...new Set(proposal.prohibits ?? [])];
  const authority: ResolvedAuthority = { workspace, available: [], withheld: [] };
  for (const capability of new Set([...needs, ...prohibits, ...(kind === "modify" ? [] : WRITE_CAPABILITIES)])) {
    const reason = prohibits.includes(capability) ? "user_prohibition"
      : kind !== "modify" && WRITE_CAPABILITIES.includes(capability) ? "task_kind"
      : !ceiling.includes(capability) ? "settings"
      : workspace !== "ok" && LOCAL_CAPABILITIES.includes(capability) ? "no_workspace" : undefined;
    if (reason) authority.withheld.push({ capability, reason });
    else if (needs.includes(capability)) authority.available.push(capability);
  }
  const evidence = {
    workspace: needs.some((capability) => LOCAL_CAPABILITIES.includes(capability)) || (kind !== "conversation" && paths.length > 0),
    external: needs.some((capability) => EXTERNAL_CAPABILITIES.includes(capability)),
  };
  const expects = impliedOutcomes(kind, evidence.workspace, request, paths);
  for (const expected of proposal.expects ?? []) {
    const bounded = boundOutcome(expected, input.workspaceRoot);
    if (bounded) expects.push({ outcome: bounded, source: "brain", required: related(bounded, request, paths, kind) });
  }
  return freeze({
    version: 1, source: "brain", request,
    kind, ...(kindDisputed ? { kindDisputed: true } : {}), ...(proposal.change_kind ? { changeKind: proposal.change_kind } : {}), needs, prohibits, evidence,
    expects, acceptance: buildAcceptanceContract(task), authority,
  });
}

/** Legacy/failed Brain routing uses only the existing classifier, still bounded by the host ceiling. */
export function buildFallbackContract(task: OrcaTaskSpec, workspaceStatus: WorkspaceAuthorityStatus, ceiling: CapabilityGroup[]): TaskContract {
  const classified = classifyTaskKind(task.originalUserMessage);
  const modify = classified !== "inspect" && classified !== "other";
  const contract = buildTaskContract({
    task, workspace: workspaceStatus, ceiling,
    proposal: {
      kind: modify ? "modify" : "inspect",
      ...(modify ? { change_kind: classified } : {}),
      needs: modify ? ["filesystem-read", "filesystem-write", "shell"] : ["filesystem-read"],
    },
  });
  return freeze({ ...contract, source: "fallback" });
}
