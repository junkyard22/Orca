// ---------------------------------------------------------------------------
// Minimal LLM interface for Claire's conversational calls.
// Structurally compatible with miranda-core's LLMAdapter — the app shell
// can wrap any existing adapter without importing claire-core's types.
// ---------------------------------------------------------------------------

export interface ClaireMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ClaireComplete = (messages: ClaireMessage[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Passthrough types — structurally compatible with benson-core's shapes.
// Defined here so claire-core has no runtime import from benson-core's
// internal modules; structural typing handles wiring in the app shell.
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface ExecutionResult {
  status: "SUCCESS" | "WARN" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
}

export interface TaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  mode?: string;
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions?: unknown;
  outputFormat?: string;
}

export interface ExecuteTaskOptions {
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Claire factory dependencies
// ---------------------------------------------------------------------------

export interface ClaireDeps {
  /** LLM callable for Claire's own conversational responses. */
  complete: ClaireComplete;
  /** Executes a task through the full Orca pipeline (Maestro → Pappy). */
  executeTask: (spec: TaskSpec, options?: ExecuteTaskOptions) => Promise<ExecutionResult>;
  /** How many past exchanges to carry forward. Defaults to 8. */
  maxHistoryTurns?: number;
}

export interface ClaireHandleOptions {
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Claire instance — the public API
// ---------------------------------------------------------------------------

export interface ClaireInstance {
  handleUserMessage(message: string, options?: ClaireHandleOptions): Promise<string>;
  getHistory(): ConversationTurn[];
  setHistory(turns: ConversationTurn[]): void;
  clearHistory(): void;
}
