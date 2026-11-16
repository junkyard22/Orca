import { redirectionsRequireApproval, runCommandShellDialect, type ShellDialect } from "./shellRedirection.js";
import { resolveWorkspacePath } from "./workspacePath.js";
import * as path from "node:path";
/**
 * Command policy for the run_command tool.
 *
 * This is NOT a sandbox in the operating-system sense, whatever the file is
 * called: run_command starts a host shell as the current user, and nothing
 * here confines that process to the workspace. What this module decides is
 * whether a command may run WITHOUT ASKING the user:
 *
 *   - blocked patterns never run;
 *   - a command runs unattended only when it is a "confined read" (a plain
 *     invocation of a single-purpose reader, nothing for the shell to
 *     interpret, every operand resolving inside the workspace with links
 *     followed — see `isConfinedRead`), or the host configured an explicit
 *     allowance for it (`extraAllowedCommands`);
 *   - everything else needs the user's approval, and the request says that
 *     the command has the user's access to the whole computer.
 *
 * The name lists below are a judgement about which commands are worth asking
 * for; they are not a confinement and must not be described as one.
 */

/**
 * Default allowed commands - safe read-only operations.
 * These can always run without approval in auto-approve mode.
 */
const DEFAULT_ALLOWED_COMMANDS = [
  // Filesystem reads
  "ls", "dir", "cat", "type", "head", "tail", "less", "more",
  "find", "where", "which", "grep", "rg", "ag", "fd",
  "tree", "stat", "file", "wc", "du", "diff",
  "findstr",

  // Git read-only
  "git status", "git log", "git diff", "git show", "git branch",
  "git remote", "git tag", "git stash list", "git ls-files",

  // Package managers (read operations)
  "npm list", "npm ls", "npm outdated",
  "pnpm list", "pnpm ls",
  "yarn list", "yarn why",

  // Node/Python version checks
  "node --version", "node -v",
  "npm --version", "npm -v",
  "python --version", "python -V",
  "python3 --version", "python3 -V",
  "pip --version", "pip3 --version",

  // Safe utilities
  "echo", "pwd", "cd", "whoami", "hostname", "date", "uname",
];

/**
 * Denied command patterns - always blocked even if in allowlist.
 * These are potentially destructive or dangerous operations.
 */
const DENIED_PATTERNS = [
  // System modification
  /sudo\s/i,
  /su\s/i,
  /chmod\s+[0-7]*777/i,
  /chown\s/i,

  // Network attacks
  /curl\s+.*\|\s*(ba)?sh/i,
  /wget\s+.*\|\s*(ba)?sh/i,
  /nc\s+.*-e/i,
  /\bncat\b.*-e/i,

  // Destructive operations
  /\brm\s+(-[rf]+\s+|.*-rf\s+)/i,
  /\brm\s+.*\*\s*$/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/(sda|hda|nvme|disk)/i,

  // Privilege escalation
  /polkit/i,
  /pkexec/i,

  // Credential theft
  /cat\s+.*\.ssh\//i,
  /cat\s+.*\.env/i,
  /cat\s+.*credentials/i,
  /cat\s+.*password/i,
  /type\s+.*\.ssh\//i,
  /type\s+.*\.env/i,
];

export type CommandCategory =
  | "safe"
  | "moderate"
  | "dangerous"
  | "blocked";

export interface SandboxPolicy {
  /** If true, "safe" commands auto-approve. */
  autoApproveSafe: boolean;

  /** If true, all commands require approval. */
  requireApprovalForAll: boolean;

  /** Additional commands to allow (appended to DEFAULT_ALLOWED_COMMANDS). */
  extraAllowedCommands: string[];

  /** Commands that always require approval, even if in allowlist. */
  requireApprovalCommands: string[];

  /** Maximum command length (prevents paste attacks). */
  maxCommandLength: number;

  /** Timeout cap (prevents long-running commands). */
  maxTimeout: number;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  autoApproveSafe: true,
  requireApprovalForAll: false,
  extraAllowedCommands: [],
  requireApprovalCommands: [],
  maxCommandLength: 4096,
  maxTimeout: 120_000,
};

export interface CommandPolicyResult {
  category: CommandCategory;
  /** Reason for the classification. */
  reason: string;
  /** If true, the command can proceed (may still need approval). */
  allowed: boolean;
  /** If true, the command requires explicit user approval. */
  requiresApproval: boolean;
  /**
   * Why a command may run without asking, when it may: `confined_read` (its
   * structure and operands were validated against the workspace) or
   * `host_policy` (the host configured an allowance for it). Absent when
   * approval is required or the command is blocked.
   */
  unattended?: "confined_read" | "host_policy";
  /** What the user is told when asked: approval grants host-level access, not workspace-only access. */
  hostAccessWarning?: string;
}

/** Where the command will run; without it no operand can be vouched for. */
export interface CommandLocation {
  workspaceRoot?: string;
  /** Absolute working directory of the command (inside the workspace). */
  cwd?: string;
}

export const HOST_ACCESS_WARNING =
  "Not sandboxed: this command runs as a process with your account's access to the whole computer (files outside the workspace, the network, other programs); the workspace is only where it starts.";

/**
 * Single-purpose readers and the option tokens accepted for each. Anything a
 * command needs beyond this — another option, a tool that can execute, write
 * or load configuration from the repository (git, find, grep -R, npm, less…) —
 * is simply not a confined read and is put to the user.
 */
const CONFINED_READERS: Record<string, { options?: RegExp; numericAfter?: RegExp; operands: "paths" | "words" | "none" }> = {
  cat: { operands: "paths" },
  head: { options: /^-[nc]$/, numericAfter: /^-[nc]$/, operands: "paths" },
  tail: { options: /^-[nc]$/, numericAfter: /^-[nc]$/, operands: "paths" },
  wc: { options: /^-[lwcm]{1,4}$/, operands: "paths" },
  ls: { options: /^-[lah1tSrAFp]{1,8}$/, operands: "paths" },
  dir: { operands: "paths" },
  stat: { operands: "paths" },
  file: { operands: "paths" },
  type: { operands: "paths" },
  echo: { operands: "words" },
  which: { operands: "words" },
  where: { operands: "words" },
  pwd: { operands: "none" },
  whoami: { operands: "none" },
  hostname: { operands: "none" },
  date: { operands: "none" },
  uname: { options: /^-[asrm]{1,4}$/, operands: "none" },
};
const VERSION_CHECKS = new Set([
  "node --version", "node -v", "npm --version", "npm -v",
  "python --version", "python -V", "python3 --version", "python3 -V", "pip --version", "pip3 --version",
]);

/**
 * Whether a command can run without asking because it can be vouched for:
 *
 *  1. it contains nothing a shell interprets — only letters, digits, `_ . / -`
 *     and single spaces (plus `\` and `:` for Windows paths) — so the shell
 *     does no more than split it into words. No quoting, expansion,
 *     substitution, globbing, redirection, chaining or line break is parsed
 *     here; any of them simply disqualifies the command;
 *  2. its first word is a listed single-purpose reader and every option is
 *     one listed for it;
 *  3. every operand that is a path resolves inside the workspace, with links
 *     followed, from the command's working directory.
 *
 * This validates arguments. It does not confine the process: it is the reason
 * these commands are not asked about, not a sandbox.
 */
export function isConfinedRead(command: string, dialect: ShellDialect, location: CommandLocation = {}): boolean {
  const plain = dialect === "posix" ? /^[A-Za-z0-9_.\/-]+(?: [A-Za-z0-9_.\/-]+)*$/ : /^[A-Za-z0-9_.\/\\:-]+(?: [A-Za-z0-9_.\/\\:-]+)*$/;
  if (!plain.test(command)) return false;
  if (VERSION_CHECKS.has(command)) return true;
  const [name, ...rest] = command.split(" ");
  const reader = name ? CONFINED_READERS[name] : undefined;
  if (!reader) return false;
  let previous = "";
  for (const token of rest) {
    const wasNumericOption = reader.numericAfter?.test(previous) === true;
    previous = token;
    if (wasNumericOption) {
      if (!/^[0-9]+$/.test(token)) return false;
      continue;
    }
    if (token.startsWith("-")) {
      if (!reader.options?.test(token)) return false;
      continue;
    }
    if (reader.operands === "none") return false;
    if (reader.operands === "words") {
      if (!/^[A-Za-z0-9_.-]+$/.test(token)) return false;
      continue;
    }
    if (!location.workspaceRoot || !location.cwd) return false;
    try {
      resolveWorkspacePath(location.workspaceRoot, path.resolve(location.cwd, token));
    } catch {
      return false;
    }
  }
  if (reader.numericAfter?.test(previous)) return false; // an option left without its number
  return true;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (!char) continue;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    const isControlOperator =
      char === ";" ||
      char === "|" ||
      (char === "&" && next === "&");

    if (isControlOperator) {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      if (char === "&") index += 1;
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments;
}

function hasCommandPrefix(command: string, prefix: string): boolean {
  const normalized = command.trim().toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  return normalized === lowerPrefix || normalized.startsWith(`${lowerPrefix} `);
}

function hasWriteRedirection(command: string): boolean {
  const redirectionPattern = /(?:^|\s)(\d*)>>?\s*([^&\s][^\s]*)/g;
  let match: RegExpExecArray | null;

  while ((match = redirectionPattern.exec(command)) !== null) {
    const fd = match[1] ?? "";
    const target = (match[2] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
    if (fd === "2" && (target === "nul" || target === "/dev/null")) continue;
    return true;
  }

  return false;
}

function combineSegmentResults(results: CommandPolicyResult[]): CommandPolicyResult {
  const blocked = results.find((result) => result.category === "blocked");
  if (blocked) return blocked;

  const requiringApproval = results.find((result) => result.requiresApproval);
  if (requiringApproval) {
    return {
      category: requiringApproval.category,
      reason: `One command segment requires approval: ${requiringApproval.reason}`,
      allowed: true,
      requiresApproval: true,
    };
  }

  return {
    category: "safe",
    reason: "All command segments are safe and auto-approved",
    allowed: true,
    requiresApproval: false,
  };
}

function evaluateSingleCommandPolicy(
  command: string,
  policy: SandboxPolicy,
  dialect: ShellDialect,
): CommandPolicyResult {
  // The earlier pattern stays, and the dialect-aware parse is added to it: a
  // redirection either one recognises as a write needs approval, so the rule
  // can only become stricter (it now also catches `&>file`, `>& file`,
  // run-time targets and writes inside inline scripts of nested shells).
  if (hasWriteRedirection(command) || redirectionsRequireApproval(command, dialect)) {
    return {
      category: "moderate",
      reason: "Command writes through shell redirection",
      allowed: true,
      requiresApproval: true,
    };
  }

  for (const requireCmd of policy.requireApprovalCommands) {
    if (hasCommandPrefix(command, requireCmd)) {
      return {
        category: "moderate",
        reason: `Command requires approval: matches "${requireCmd}"`,
        allowed: true,
        requiresApproval: true,
      };
    }
  }

  const allAllowed = [...DEFAULT_ALLOWED_COMMANDS, ...policy.extraAllowedCommands];
  const isAllowed = allAllowed.some((allowed) => hasCommandPrefix(command, allowed));

  if (isAllowed) {
    if (policy.requireApprovalForAll) {
      return {
        category: "safe",
        reason: "Command is in allowlist but policy requires approval for all",
        allowed: true,
        requiresApproval: true,
      };
    }

    if (policy.autoApproveSafe) {
      return {
        category: "safe",
        reason: "Command is in allowlist and auto-approve is enabled",
        allowed: true,
        requiresApproval: false,
      };
    }

    return {
      category: "safe",
      reason: "Command is in allowlist but auto-approve is disabled",
      allowed: true,
      requiresApproval: true,
    };
  }

  const moderateCommands = [
    "npm install", "npm i", "npm add", "npm update", "npm uninstall",
    "pnpm add", "pnpm install", "pnpm update", "pnpm remove",
    "yarn add", "yarn install", "yarn remove", "yarn upgrade",
    "git add", "git commit", "git push", "git merge", "git rebase",
    "git checkout", "git switch", "git reset", "git clean",
    "pip install", "pip uninstall",
    "mkdir", "touch", "mv", "cp",
  ];

  const isModerate = moderateCommands.some((mod) => hasCommandPrefix(command, mod));

  if (isModerate) {
    return {
      category: "moderate",
      reason: "Command may modify files or install packages",
      allowed: true,
      requiresApproval: true,
    };
  }

  return {
    category: "dangerous",
    reason: "Command is not in allowlist and may have side effects",
    allowed: true,
    requiresApproval: true,
  };
}

/**
 * Evaluate a command against the policy: blocked, runs unattended, or needs
 * the user's approval. The name-based classification below decides the
 * category and the reason shown; whether the command may run WITHOUT asking
 * additionally requires that it can be vouched for (`isConfinedRead`) or that
 * the host configured an allowance for it.
 */
export function evaluateCommandPolicy(
  command: string,
  policy: SandboxPolicy,
  dialect: ShellDialect = runCommandShellDialect(),
  location: CommandLocation = {},
): CommandPolicyResult {
  const named = classifyByName(command, policy, dialect);
  if (!named.allowed) return named;
  if (named.requiresApproval) return { ...named, hostAccessWarning: HOST_ACCESS_WARNING };
  if (isConfinedRead(command, dialect, location)) return { ...named, unattended: "confined_read" };
  // Unattended only because the host listed it: would the built-in names alone have asked?
  if (policy.extraAllowedCommands.length > 0 && classifyByName(command, { ...policy, extraAllowedCommands: [] }, dialect).requiresApproval) {
    return { ...named, unattended: "host_policy" };
  }
  return {
    ...named,
    requiresApproval: true,
    reason: `${named.reason}, but it cannot be confirmed to stay inside the workspace (it uses shell syntax, an option or tool that is not a plain read, or a path outside the workspace)`,
    hostAccessWarning: HOST_ACCESS_WARNING,
  };
}

function classifyByName(
  command: string,
  policy: SandboxPolicy,
  dialect: ShellDialect,
): CommandPolicyResult {
  if (command.length > policy.maxCommandLength) {
    return {
      category: "blocked",
      reason: `Command exceeds max length (${command.length} > ${policy.maxCommandLength})`,
      allowed: false,
      requiresApproval: false,
    };
  }

  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        category: "blocked",
        reason: `Command matches blocked pattern: ${pattern.source}`,
        allowed: false,
        requiresApproval: false,
      };
    }
  }

  const segments = splitShellSegments(command);
  if (segments.length > 1) {
    return combineSegmentResults(segments.map((segment) => classifyByName(segment, policy, dialect)));
  }

  return evaluateSingleCommandPolicy(command, policy, dialect);
}

/**
 * Create a sandbox policy with optional overrides.
 */
export function createSandboxPolicy(
  overrides: Partial<SandboxPolicy> = {},
): SandboxPolicy {
  return { ...DEFAULT_SANDBOX_POLICY, ...overrides };
}
