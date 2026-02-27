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

export interface BensonDependencies {
  executeTask: (task: TaskSpec) => Promise<ExecutionResult>;
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
