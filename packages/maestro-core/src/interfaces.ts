/**
 * Dependency Interfaces for Maestro Core.
 *
 * The core package defines these contracts. App layers (VS Code, Electron, CLI)
 * provide the implementations and pass them in at construction time.
 * The core never imports from VS Code, Electron, or any UI framework.
 */

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Minimal logger contract. Matches the Logger class in the VS Code extension
 * and any standard logging library.
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: Error, ...args: any[]): void;
}

// ============================================================================
// Git Runner Interface
// ============================================================================

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Abstracts git subprocess invocation for rollback/checkpoint operations.
 * The app layer provides an implementation using `child_process.spawn`.
 */
export interface GitRunner {
  run(cwd: string, args: string[]): Promise<GitResult>;
  isRepo(dir: string): boolean;
}

// ============================================================================
// Pod Member Interface (Orca Platform Contract)
// ============================================================================

/**
 * A task dispatched to a pod member.
 */
export interface Task {
  /** Unique task identifier. */
  id: string;
  /** Human-readable description of the task. */
  description: string;
  /** Optional structured payload for the task. */
  payload?: unknown;
}

/**
 * Execution context provided to a pod member at run time.
 */
export interface Context {
  /** Absolute path to the workspace root (if applicable). */
  workspaceRoot?: string;
  /** Arbitrary metadata for the run. */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a pod member after handling a task.
 */
export interface Result {
  success: boolean;
  /** Human-readable output or summary. */
  output?: string;
  /** Error message if success === false. */
  error?: string;
  /** Structured result metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Standard Orca Pod Member interface.
 * Every pod member must implement this contract.
 */
export interface PodMember {
  /** Stable unique identifier for this pod member. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** List of capability strings this member exposes. */
  capabilities: string[];
  /** Returns true if this member can handle the given task. */
  canHandle(task: Task): boolean;
  /** Execute the task and return a result. */
  run(task: Task, context: Context): Promise<Result>;
}
