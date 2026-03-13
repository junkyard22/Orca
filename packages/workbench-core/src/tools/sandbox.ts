/**
 * Tool Sandbox — security policy for tool execution.
 *
 * Provides command allowlisting/denylisting for the run_command tool,
 * and a policy framework that can be extended for other tools.
 */

/**
 * Default allowed commands — safe read-only operations.
 * These can always run without approval in auto-approve mode.
 */
const DEFAULT_ALLOWED_COMMANDS = [
  // Filesystem reads
  "ls", "dir", "cat", "type", "head", "tail", "less", "more",
  "find", "where", "which", "grep", "rg", "ag", "fd",
  "tree", "stat", "file", "wc", "du", "diff",
  
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
  "echo", "pwd", "whoami", "hostname", "date", "uname",
  "env", "printenv", "set",
];

/**
 * Denied command patterns — always blocked even if in allowlist.
 * These are potentially destructive or dangerous operations.
 */
const DENIED_PATTERNS = [
  // System modification
  /sudo\s/i,
  /su\s/i,
  /chmod\s+[0-7]*777/i,
  /chown\s/i,
  
  // Network attacks
  /curl\s+.*\|\s*(ba)?sh/i,  // curl | bash
  /wget\s+.*\|\s*(ba)?sh/i,  // wget | bash
  /nc\s+.*-e/i,              // netcat reverse shell
  /\bncat\b.*-e/i,
  
  // Destructive operations
  /\brm\s+(-[rf]+\s+|.*-rf\s+)/i,  // rm -rf (allow specific file deletion)
  /\brm\s+.*\*\s*$/i,              // rm * patterns
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
  /type\s+.*\.ssh\//i,    // Windows equivalent
  /type\s+.*\.env/i,
];

/**
 * Command categories for policy decisions.
 */
export type CommandCategory = 
  | "safe"          // Always allowed (read-only, no side effects)
  | "moderate"      // Allowed in auto-approve mode (file writes, installs)
  | "dangerous"     // Always requires explicit approval
  | "blocked";      // Never allowed

/**
 * Sandbox policy configuration.
 */
export interface SandboxPolicy {
  /** If true, "safe" and "moderate" commands auto-approve. */
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

/**
 * Default sandbox policy — conservative for production.
 */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  autoApproveSafe: true,
  requireApprovalForAll: false,
  extraAllowedCommands: [],
  requireApprovalCommands: [],
  maxCommandLength: 4096,
  maxTimeout: 120_000,  // 2 minutes max
};

/**
 * Result of evaluating a command against the sandbox policy.
 */
export interface CommandPolicyResult {
  category: CommandCategory;
  /** Reason for the classification. */
  reason: string;
  /** If true, the command can proceed (may still need approval). */
  allowed: boolean;
  /** If true, the command requires explicit user approval. */
  requiresApproval: boolean;
}

/**
 * Evaluate a command against the sandbox policy.
 */
export function evaluateCommandPolicy(
  command: string,
  policy: SandboxPolicy,
): CommandPolicyResult {
  // Check command length
  if (command.length > policy.maxCommandLength) {
    return {
      category: "blocked",
      reason: `Command exceeds max length (${command.length} > ${policy.maxCommandLength})`,
      allowed: false,
      requiresApproval: false,
    };
  }
  
  // Check denied patterns first
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
  
  // Check if in require-approval list
  const normalizedCmd = command.trim().toLowerCase();
  for (const requireCmd of policy.requireApprovalCommands) {
    if (normalizedCmd.startsWith(requireCmd.toLowerCase())) {
      return {
        category: "moderate",
        reason: `Command requires approval: matches "${requireCmd}"`,
        allowed: true,
        requiresApproval: true,
      };
    }
  }
  
  // Check allowed commands
  const allAllowed = [...DEFAULT_ALLOWED_COMMANDS, ...policy.extraAllowedCommands];
  const isAllowed = allAllowed.some((allowed) => {
    const allowedLower = allowed.toLowerCase();
    return normalizedCmd.startsWith(allowedLower) || normalizedCmd === allowedLower;
  });
  
  if (isAllowed) {
    // In the allowlist
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
  
  // Not in allowlist — treat as moderate (may need approval)
  // Commands like npm install, git commit, file writes
  const moderateCommands = [
    "npm install", "npm i ", "npm add", "npm update", "npm uninstall",
    "pnpm add", "pnpm install", "pnpm update", "pnpm remove",
    "yarn add", "yarn install", "yarn remove", "yarn upgrade",
    "git add", "git commit", "git push", "git merge", "git rebase",
    "git checkout", "git switch", "git reset", "git clean",
    "pip install", "pip uninstall",
    "mkdir", "touch", "mv", "cp",
  ];
  
  const isModerate = moderateCommands.some((mod) => normalizedCmd.startsWith(mod.toLowerCase()));
  
  if (isModerate) {
    return {
      category: "moderate",
      reason: `Command may modify files or install packages`,
      allowed: true,
      requiresApproval: true,
    };
  }
  
  // Unknown command — require approval
  return {
    category: "dangerous",
    reason: "Command is not in allowlist and may have side effects",
    allowed: true,
    requiresApproval: true,
  };
}

/**
 * Create a sandbox policy with optional overrides.
 */
export function createSandboxPolicy(
  overrides: Partial<SandboxPolicy> = {},
): SandboxPolicy {
  return { ...DEFAULT_SANDBOX_POLICY, ...overrides };
}