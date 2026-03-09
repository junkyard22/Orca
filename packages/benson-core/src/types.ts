export type { TaskSpec, TaskPermissions, OutputFormat, ConversationTurn } from "@clawde/secretary-core";
import type { TaskSpec, ConversationTurn } from "@clawde/secretary-core";

export type BensonReply =
  | { kind: "CLARIFY"; text: string; options?: string[] }
  | { kind: "RESULT"; text: string; task: TaskSpec };

export interface ExecutionResult {
  status: "SUCCESS" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
}

export interface BensonDependencies {
  executeTask: (task: TaskSpec) => Promise<ExecutionResult>;
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

