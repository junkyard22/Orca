/**
 * Execution-time authorization for every tool call a worker or the runtime makes.
 *
 * Miranda's gate checks task permissions and protected paths, and run_command
 * enforces its own command policy — but MCP and extension tools (GitHub writes,
 * Desktop Commander processes and config) previously executed with no presenter
 * approval and only partial path checks. This module sits directly in front of
 * tool.execute(), so a prompt cannot talk its way past it.
 *
 * Every tool is classified into an explicit capability. Decisions:
 *   allow    — read-only or workspace-confined operations whose paths all
 *              resolve inside the workspace
 *   approve  — needs explicit presenter approval for this call (mutates an
 *              external system, starts processes, or is not recognised)
 *   deny     — never allowed (sandbox reconfiguration, paths outside the
 *              workspace, or anything needing approval when strict)
 *
 * `strict` (intended for public Demo Mode) turns every `approve` into `deny`,
 * so no external write or process launch can happen even if someone clicks
 * Approve by mistake.
 */
import { isAbsolute, relative, resolve } from "node:path";

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
  /** Deny anything that would otherwise need approval (public demos). */
  strict?: boolean;
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

/** Desktop Commander tools, keyed without the "desktop-commander_" prefix. */
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

const DESKTOP_COMMANDER_PREFIX = "desktop-commander_";

const READ_VERB = /(?:^|_)(?:get|list|search|read|fetch|find|view|show|describe|query|lookup|status)(?:_|$)/i;
const WRITE_VERB =
  /(?:^|_)(?:create|update|delete|write|remove|send|post|put|patch|merge|close|reopen|approve|reject|clone|upload|move|rename|edit|modify|push|fork|add|set|comment|assign|label|star|dispatch|run|trigger|transfer|archive|lock|unlock|publish|release|tag|execute|exec|start|kill|terminate|install|deploy|invite)(?:_|$)/i;

export function classifyTool(tool: string): ToolCapability {
  if (Object.prototype.hasOwnProperty.call(CORE, tool)) return CORE[tool]!;
  if (tool.startsWith(DESKTOP_COMMANDER_PREFIX)) {
    const op = tool.slice(DESKTOP_COMMANDER_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(DESKTOP_COMMANDER, op) ? DESKTOP_COMMANDER[op]! : "unknown";
  }
  // Other MCP / connector tools: classify by verb. Any write verb wins, so a
  // name like "get_or_create_x" is treated as a write.
  if (WRITE_VERB.test(tool)) return "external_write";
  if (READ_VERB.test(tool)) return "external_read";
  return "unknown";
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
  const capability = classifyTool(tool);
  const approveOrDeny = (reason: string): ToolAuthorization =>
    options.strict
      ? { capability, decision: "deny", reason: `${reason} (blocked: approval-required tools are disabled in this mode)` }
      : { capability, decision: "approve", reason };

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
    case "shell_policy":
      return { capability, decision: "allow", reason: "run_command enforces its own command policy and approval" };
    case "process_read":
    case "external_read":
      return { capability, decision: "allow", reason: "read-only operation" };
    case "process_exec":
      return approveOrDeny(`"${tool}" starts or controls a process outside run_command's command policy`);
    case "external_write":
      return approveOrDeny(`"${tool}" modifies an external system`);
    case "sandbox_config":
      return { capability, decision: "deny", reason: `"${tool}" would reconfigure the tool sandbox` };
    case "unknown":
    default:
      return approveOrDeny(`"${tool}" is not a recognised tool capability`);
  }
}

export type ApprovalRequester = (tool: string, args: Record<string, unknown>) => Promise<boolean>;

/**
 * Enforce the decision. Returns null when the call may proceed, or a tool
 * result describing why it was refused. Approval is requested per call; a
 * missing approver means the call is refused.
 */
export async function enforceToolAuthorization(
  tool: string,
  args: Record<string, unknown>,
  options: ToolAuthorizationOptions & { requestApproval?: ApprovalRequester },
): Promise<{ ok: false; output: string; error: string } | null> {
  const auth = authorizeToolCall(tool, args, options);
  if (auth.decision === "allow") return null;
  if (auth.decision === "approve") {
    if (!options.requestApproval) {
      return { ok: false, output: "", error: `Tool "${tool}" requires presenter approval, but none is available: ${auth.reason}` };
    }
    const approved = await options.requestApproval(tool, args).catch(() => false);
    if (approved) return null;
    return { ok: false, output: "", error: `Tool "${tool}" was not approved: ${auth.reason}` };
  }
  return { ok: false, output: "", error: `Tool "${tool}" blocked: ${auth.reason}` };
}
