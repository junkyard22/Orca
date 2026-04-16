export type Permission = "read" | "write" | "shell" | "network";

export type OutputFormat =
  | "prose"
  | "code"
  | "file_diff"
  | "json"
  | "bullets"
  | "table";

export type TaskMode = "default" | "project_audit";

export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface TaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  mode?: TaskMode;
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions?: Permission[];
  outputFormat?: OutputFormat;
}

export type BensonReply =
  | { kind: "CLARIFY"; text: string; options?: string[] }
  | { kind: "RESULT"; text: string; task: TaskSpec };

export interface ExecutionResult {
  status: "SUCCESS" | "WARN" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
}

export interface ExecuteTaskOptions {
  abortSignal?: AbortSignal;
}

export interface BensonMessageOptions {
  abortSignal?: AbortSignal;
}

export interface BensonDependencies {
  executeTask: (task: TaskSpec, options?: ExecuteTaskOptions) => Promise<ExecutionResult>;
  /**
   * How many past exchanges to carry forward.
   * Defaults to 8.  Set to 0 to disable history entirely.
   */
  maxHistoryTurns?: number;
}

// Message type for conversation history
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Internal — not exported from package index
export interface ParsedClarify {
  kind: "CLARIFY";
  text: string;
  options: string[];
}

export interface ParsedTask {
  kind: "TASK";
  spec: TaskSpec;
}

export type ParseResult = ParsedClarify | ParsedTask;

