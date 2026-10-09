/**
 * Execution-time authorization for every tool call a worker or the runtime makes.
 *
 * Miranda's gate checks request-level permissions and protected paths, and
 * run_command enforces its own command policy — but MCP and extension tools
 * (GitHub writes, Desktop Commander processes and configuration) executed with
 * no user approval and only partial path checks. This module sits directly in
 * front of tool.execute(), so a prompt cannot talk its way past it.
 *
 * Every tool is classified into an explicit capability. Decisions:
 *   allow    — read-only or workspace-confined operations whose paths all
 *              resolve inside the workspace
 *   approve  — needs the user's explicit approval for this call (mutates an
 *              external system, starts processes, or is not recognised)
 *   deny     — never allowed (tool-sandbox reconfiguration, local paths
 *              outside the workspace)
 *
 * A refusal is an ordinary failed tool result (`ok: false`), so the agent loop
 * records it as a failure and nothing downstream can mistake it for execution.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { classifyToolVerb } from "@clawde/miranda-core";

export type ToolCapability =
  | "workspace_read"
  | "workspace_write"
  | "shell_policy"     // run_command — enforces its own allowlist + approval
  | "process_exec"
  | "process_read"
  | "external_read"
  | "external_write"
  | "sandbox_config"
  | "unknown";

export type ToolDecision = "allow" | "approve" | "deny";

export interface ToolAuthorization {
  capability: ToolCapability;
  decision: ToolDecision;
  reason: string;
}

export interface ToolAuthorizationOptions {
  workspaceRoot: string;
  /**
   * Configured MCP server ids. Tool names are `<server-id>_<operation>`; the id
   * is user-chosen and may itself contain a verb, so it is stripped before the
   * operation's verbs are classified.
   */
  mcpServerIds?: readonly string[];
}

const CORE: Record<string, ToolCapability> = {
  read_file: "workspace_read",
  list_directory: "workspace_read",
  search_files: "workspace_read",
  write_file: "workspace_write",
  run_command: "shell_policy",
  docs_read: "workspace_read",
  docs_list: "workspace_read",
  web_fetch: "external_read",
  web_search: "external_read",
  github_list_prs: "external_read",
  github_get_pr: "external_read",
  github_list_issues: "external_read",
  github_list_repos: "external_read",
  // Downloads third-party content into the workspace.
  github_clone_repo: "external_write",
};

/** Desktop Commander operations, keyed without the server prefix. */
const DESKTOP_COMMANDER: Record<string, ToolCapability> = {
  read_file: "workspace_read",
  read_multiple_files: "workspace_read",
  list_directory: "workspace_read",
  get_file_info: "workspace_read",
  start_search: "workspace_read",
  get_more_search_results: "workspace_read",
  stop_search: "workspace_read",
  list_searches: "workspace_read",
  write_file: "workspace_write",
  write_pdf: "workspace_write",
  edit_block: "workspace_write",
  create_directory: "workspace_write",
  move_file: "workspace_write",
  start_process: "process_exec",
  interact_with_process: "process_exec",
  force_terminate: "process_exec",
  kill_process: "process_exec",
  read_process_output: "process_read",
  list_sessions: "process_read",
  list_processes: "process_read",
  get_config: "process_read",
  get_usage_stats: "process_read",
  get_recent_tool_calls: "process_read",
  get_prompts: "process_read",
  // Rewrites Desktop Commander's own sandbox (allowedDirectories, blockedCommands).
  set_config_value: "sandbox_config",
  // Sends data to a third party / opens a browser.
  give_feedback_to_desktop_commander: "external_write",
};

/** The id the rest of the desktop assumes for Desktop Commander (see absolutizeDesktopCommanderInput). */
const DESKTOP_COMMANDER_PREFIX = "desktop-commander_";

/** Split `<server-id>_<operation>` using the configured ids; longest id first. */
export function splitServerPrefix(tool: string, mcpServerIds: readonly string[] = []): { serverId?: string; operation: string } {
  const ids = [...new Set([...mcpServerIds, "desktop-commander"])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    if (tool.startsWith(`${id}_`) && tool.length > id.length + 1) {
      return { serverId: id, operation: tool.slice(id.length + 1) };
    }
  }
  return { operation: tool };
}

export function classifyTool(tool: string, mcpServerIds: readonly string[] = []): ToolCapability {
  if (Object.prototype.hasOwnProperty.call(CORE, tool)) return CORE[tool]!;
  const { serverId, operation } = splitServerPrefix(tool, mcpServerIds);
  if (tool.startsWith(DESKTOP_COMMANDER_PREFIX)) {
    const op = tool.slice(DESKTOP_COMMANDER_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(DESKTOP_COMMANDER, op) ? DESKTOP_COMMANDER[op]! : "unknown";
  }
  // Other MCP / connector tools: classify the operation's verbs (the server id
  // is dropped when it is known, so an id like "search-tools" cannot mislead).
  switch (classifyToolVerb(serverId ? operation : tool)) {
    case "write": return "external_write";
    case "read": return "external_read";
    default: return "unknown";
  }
}

/** Argument keys that name local filesystem locations. */
const PATH_KEY = /^(?:path|paths|file|files|file_?path|file_?paths|filename|source|src|destination|dest|target|cwd|dir|directory|root|folder|output_?path|input_?path)$/i;

/**
 * Every path argument, including arrays (`paths: [...]`), nested objects
 * (`files: [{ path }]`) and source/destination pairs. For external_write tools
 * these may name paths inside a remote repo, so the caller only treats them as
 * local for capabilities that touch the local filesystem.
 */
export function collectLocalPathArguments(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, keyIsPath: boolean): void => {
    if (typeof value === "string") {
      if (keyIsPath) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyIsPath);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, PATH_KEY.test(k));
    }
  };
  for (const [k, v] of Object.entries(args ?? {})) visit(v, PATH_KEY.test(k));
  return out;
}

export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  if (!workspaceRoot) return false;
  const root = resolve(workspaceRoot);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function authorizeToolCall(
  tool: string,
  args: Record<string, unknown>,
  options: ToolAuthorizationOptions,
): ToolAuthorization {
  const capability = classifyTool(tool, options.mcpServerIds);

  // Local paths are checked for every capability that touches the filesystem.
  if (capability === "workspace_read" || capability === "workspace_write" || capability === "process_exec" || capability === "external_write" || capability === "unknown") {
    const outside = collectLocalPathArguments(args).filter((p) => !isInsideWorkspace(options.workspaceRoot, p));
    // external_write paths may be remote (GitHub `files[].path`); those calls
    // need approval regardless, except a clone, whose `dest` is always local.
    if (outside.length > 0 && capability !== "external_write") {
      return { capability, decision: "deny", reason: `path outside the workspace: ${outside.join(", ")}` };
    }
    if (outside.length > 0 && tool === "github_clone_repo") {
      return { capability, decision: "deny", reason: `clone destination outside the workspace: ${outside.join(", ")}` };
    }
  }

  switch (capability) {
    case "workspace_read":
    case "workspace_write":
      return { capability, decision: "allow", reason: "workspace-confined file operation" };
    case "shell_policy": {
      // A working directory outside the workspace is never allowed.
      const cwd = typeof args["cwd"] === "string" ? args["cwd"] : undefined;
      if (cwd !== undefined && !isInsideWorkspace(options.workspaceRoot, cwd)) {
        return { capability, decision: "deny", reason: `working directory outside the workspace: ${cwd}` };
      }
      return { capability, decision: "allow", reason: "run_command enforces its own command policy and approval" };
    }
    case "process_read":
    case "external_read":
      return { capability, decision: "allow", reason: "read-only operation" };
    case "process_exec":
      return { capability, decision: "approve", reason: `"${tool}" starts or controls a process outside run_command's command policy` };
    case "external_write":
      return { capability, decision: "approve", reason: `"${tool}" modifies an external system` };
    case "sandbox_config":
      return { capability, decision: "deny", reason: `"${tool}" would reconfigure the tool sandbox` };
    case "unknown":
    default:
      return { capability, decision: "approve", reason: `"${tool}" is not a recognised tool capability` };
  }
}

export type ApprovalRequester = (tool: string, args: Record<string, unknown>, reason: string) => Promise<boolean>;

export interface ToolRefusal {
  ok: false;
  output: string;
  error: string;
  /** Why execution did not happen; never present on a result that ran. */
  authorization: ToolDecision | "approval_denied" | "approval_unavailable";
}

/**
 * Enforce the decision. Returns null when the call may proceed, or a failed
 * tool result describing why it was refused. Approval is requested per call;
 * a missing approver, a denial, a timeout (the approver resolves false) or an
 * approver error all refuse the call. The tool itself is never reached.
 */
export async function enforceToolAuthorization(
  tool: string,
  args: Record<string, unknown>,
  options: ToolAuthorizationOptions & { requestApproval?: ApprovalRequester },
): Promise<ToolRefusal | null> {
  const auth = authorizeToolCall(tool, args, options);
  if (auth.decision === "allow") return null;
  if (auth.decision === "approve") {
    if (!options.requestApproval) {
      return { ok: false, output: "", error: `Tool "${tool}" requires user approval, but no approval handler is available: ${auth.reason}`, authorization: "approval_unavailable" };
    }
    const approved = await options.requestApproval(tool, args, auth.reason).catch(() => false);
    if (approved === true) return null;
    return { ok: false, output: "", error: `Tool "${tool}" was not approved (denied or timed out): ${auth.reason}. The call did not execute.`, authorization: "approval_denied" };
  }
  return { ok: false, output: "", error: `Tool "${tool}" blocked: ${auth.reason}. The call did not execute.`, authorization: "deny" };
}
