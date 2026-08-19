/**
 * Tool Capability Groups — role-scoped tool access.
 *
 * Maps tool names to named capability groups so roles can declare what kinds
 * of tools they need (e.g. "filesystem-read") instead of a role config
 * hand-enumerating every exact tool name, including MCP-server tools that
 * are only known at connect time.
 *
 * Classification is conservative by design: known static tools (core +
 * ext-github/ext-docs/ext-web) are matched by exact name. Dynamically
 * discovered MCP tools are matched by verb heuristics against the tool name
 * with destructive/write verbs checked before execution verbs, which are
 * checked before read verbs — so an ambiguous name (e.g. containing both a
 * read and a delete verb) always resolves to the more privileged group. A
 * name matching no pattern at all is left unclassified (`null`) and is
 * excluded from every role's resolved tool set unless separately named in
 * an explicit `toolsAllowed` list — there is no "allow by default" fallback.
 *
 * No external dependencies, mirroring the rest of this package.
 */

import type { RoleName } from './roleSelector';

// ============================================================================
// Capability Groups
// ============================================================================

export type CapabilityGroup =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'shell'
  | 'github-read'
  | 'github-write'
  | 'web'
  | 'documentation'
  // Reserved — no tools classify into this group today (no DOCX/PDF/Excel
  // tools exist in this codebase yet). Kept so role configs can declare it
  // in advance without a schema change when such tools are added.
  | 'document-editing';

export const ALL_CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  'filesystem-read',
  'filesystem-write',
  'shell',
  'github-read',
  'github-write',
  'web',
  'documentation',
  'document-editing',
];

/**
 * Type guard for capability group names coming from user-editable settings
 * JSON (which is just `string[]` on disk). Unrecognized names are dropped
 * by callers rather than guessed into a group — fail closed, matching the
 * classifier's own "unclassified tools are excluded" rule.
 */
export function isCapabilityGroup(value: string): value is CapabilityGroup {
  return (ALL_CAPABILITY_GROUPS as readonly string[]).includes(value);
}

// ============================================================================
// Explicit exact-name map — every static tool this codebase ships today.
// ============================================================================

const KNOWN_TOOL_CAPABILITIES: Record<string, CapabilityGroup> = {
  // Core workbench tools (packages/workbench-core/src/tools)
  read_file: 'filesystem-read',
  list_directory: 'filesystem-read',
  search_files: 'filesystem-read',
  write_file: 'filesystem-write',
  run_command: 'shell',

  // ext-github (packages/ext-github/src/index.ts)
  github_list_prs: 'github-read',
  github_get_pr: 'github-read',
  github_list_issues: 'github-read',
  github_list_repos: 'github-read',
  github_clone_repo: 'github-write',

  // ext-docs (packages/ext-docs/src/index.ts)
  docs_read: 'documentation',
  docs_list: 'documentation',

  // ext-web (packages/ext-web/src/index.ts)
  web_fetch: 'web',
  web_search: 'web',
};

// ============================================================================
// Verb heuristics for dynamically-discovered (MCP) tool names.
// Order matters — destructive/write verbs are checked first, so an
// ambiguous name resolves to the more privileged group, never a guessed
// "safe" one.
// ============================================================================

const WRITE_VERBS = new Set([
  'create', 'write', 'edit', 'update', 'delete', 'remove', 'merge', 'push',
  'clone', 'patch', 'rename', 'move', 'kill', 'stop', 'terminate', 'force',
]);
const SHELL_VERBS = new Set(['execute', 'run', 'start', 'spawn']);
const READ_VERBS = new Set([
  'get', 'list', 'read', 'search', 'find', 'show', 'describe', 'fetch', 'view', 'query',
]);

/**
 * Split a tool-name suffix into lowercase word tokens on any non-letter
 * separator (underscore, hyphen, digits, …). Word-based matching, rather
 * than a substring/`\b`-boundary regex, avoids two failure modes: `\b`
 * treats `_` as a word character, so it never matches a verb immediately
 * after an underscore (e.g. "get_and_delete_thing" would silently miss
 * "delete"); and a plain substring match could false-positive inside an
 * unrelated longer word.
 */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function hasAny(tokens: string[], verbs: Set<string>): boolean {
  return tokens.some((t) => verbs.has(t));
}

/**
 * Classify a single tool name into a capability group.
 *
 * Known static tools are matched by exact name first. Anything else is
 * treated as a dynamically-discovered (MCP) tool: the `${serverId}_` prefix
 * (if any) is stripped, and the remaining name's word tokens are matched
 * against the write → shell → read precedence order above. Returns `null`
 * when nothing matches — callers must never treat `null` as "allow".
 */
export function classifyToolCapability(toolName: string): CapabilityGroup | null {
  const known = KNOWN_TOOL_CAPABILITIES[toolName];
  if (known) return known;

  // Namespaced MCP tool: strip the "${serverId}_" prefix if present so verb
  // matching runs against the tool's own name, not the server id.
  const underscoreIdx = toolName.indexOf('_');
  const suffix = underscoreIdx === -1 ? toolName : toolName.slice(underscoreIdx + 1);
  const isGithubServer = /^github/i.test(toolName);
  const tokens = words(suffix);

  if (hasAny(tokens, WRITE_VERBS)) {
    return isGithubServer ? 'github-write' : 'filesystem-write';
  }
  if (hasAny(tokens, SHELL_VERBS)) {
    return 'shell';
  }
  if (hasAny(tokens, READ_VERBS)) {
    return isGithubServer ? 'github-read' : 'filesystem-read';
  }

  return null;
}

// ============================================================================
// Default per-role capability baselines.
// ============================================================================

export const DEFAULT_ROLE_CAPABILITIES: Record<RoleName, CapabilityGroup[]> = {
  // Correctness fix (found during the Dynamic Tool Prompt Hygiene
  // milestone): brain is not always tool-less. routeRequest() only skips
  // tools for its own internal Brain *routing* LLM call (direct-vs-decompose
  // decision) — but pickCoreRole()/selectRole() can also choose 'brain' as
  // the *worker* role for direct investigative/status tasks, in which case
  // it runs through the normal runSingleAgent()/runAgentLoop() tool-bearing
  // path like any other role. BRAIN's own prompt text (rolePrompts.ts)
  // explicitly assumes read access ("use tools to gather the information
  // you need", "ran list_directory or read_file"). The previous milestone
  // set this to [] on a false premise, which — now that role-scoped
  // filtering is actually wired into apps/runner/src/index.ts — silently
  // zeroed brain's tool access for every investigative task. filesystem-read
  // matches its designed (read-only) behavior; write access still requires
  // explicit task.permissions.fileWrite === true, same as every other role.
  brain: ['filesystem-read'],
  strong_model: ['filesystem-read', 'filesystem-write', 'shell'],
  cheap_model: ['filesystem-read', 'filesystem-write', 'shell'],
  utility: ['filesystem-read', 'filesystem-write', 'shell'],
  reviewer: ['filesystem-read'],
  // filesystem-write is intentionally absent from narrator's baseline — it
  // can only be added per-task via explicit task.permissions.fileWrite.
  narrator: ['filesystem-read', 'documentation'],
  planner_deep: ['filesystem-read'],
  debugger: ['filesystem-read', 'filesystem-write', 'shell'],
  reader: ['filesystem-read', 'documentation'],
  vision: ['filesystem-read'],
};

// ============================================================================
// Resolver
// ============================================================================

/**
 * Resolve a role's capability groups into a concrete list of currently
 * registered tool names. Unclassified tools (classifyToolCapability returns
 * null) are never included — there is no "allow by default" branch here.
 */
export function resolveAllowedToolNames(
  allToolNames: string[],
  groups: readonly CapabilityGroup[],
): string[] {
  if (groups.length === 0) return [];
  const groupSet = new Set(groups);
  return allToolNames.filter((name) => {
    const capability = classifyToolCapability(name);
    return capability !== null && groupSet.has(capability);
  });
}
