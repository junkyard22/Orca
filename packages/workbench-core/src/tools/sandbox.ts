/**
 * Tool Sandbox - security policy for tool execution.
 *
 * Provides command allowlisting/denylisting for the run_command tool,
 * and a policy framework that can be extended for other tools.
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
  "env", "printenv", "set",
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
): CommandPolicyResult {
  if (hasWriteRedirection(command)) {
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
 * Evaluate a command against the sandbox policy.
 */
export function evaluateCommandPolicy(
  command: string,
  policy: SandboxPolicy,
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
    return combineSegmentResults(segments.map((segment) => evaluateCommandPolicy(segment, policy)));
  }

  return evaluateSingleCommandPolicy(command, policy);
}

/**
 * Create a sandbox policy with optional overrides.
 */
export function createSandboxPolicy(
  overrides: Partial<SandboxPolicy> = {},
): SandboxPolicy {
  return { ...DEFAULT_SANDBOX_POLICY, ...overrides };
}
