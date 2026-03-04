export type BensonReply =
  | { kind: "CLARIFY"; text: string; options?: string[] }
  | { kind: "RESULT"; text: string; task: TaskSpec };

export interface TaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface ExecutionResult {
  status: "SUCCESS" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
}

/**
 * A single exchange in the ongoing conversation.
 * Injected into the task context so the model can resolve references like
 * "that endpoint" or "do the same for the other file".
 */
export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface BensonDependencies {
  executeTask: (task: TaskSpec) => Promise<ExecutionResult>;
  /**
   * How many past exchanges to carry forward.
   * Defaults to 8.  Set to 0 to disable history entirely.
   */
  maxHistoryTurns?: number;
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
