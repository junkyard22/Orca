// ---------------------------------------------------------------------------
// Secretary types
// ---------------------------------------------------------------------------

export type OutputFormat = "code" | "diff" | "json" | "prose";

export interface TaskPermissions {
  /** Model may call read_file / list_directory / search_files */
  fileRead: boolean;
  /** Model may call write_file */
  fileWrite: boolean;
  /** Model may call run_command / shell */
  shellExec: boolean;
  /** Exact list of tool names the model is allowed to use */
  toolsAllowed: string[];
}

export interface TaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions: TaskPermissions;
  outputFormat: OutputFormat;
}

export type ConversationTurn = {
  user: string;
  assistant: string;
};
