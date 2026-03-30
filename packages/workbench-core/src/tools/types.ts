import type { SandboxPolicy } from "./sandbox.js";

/**
 * Tool system — core types.
 *
 * A Tool is a named capability (read_file, write_file, run_command, …) that
 * an agent can call. Every call is described by a JSON schema so the LLM
 * knows exactly what parameters to supply. Every result is a plain
 * { ok, output, error? } so callers never touch raw process output.
 */

export interface ToolRunCtx {
  /** Absolute path to the project/workspace the agent is operating on. */
  workspaceRoot: string;
  /** Correlation ID for logging — matches the orca-core runId. */
  runId: string;
  /** Optional cancellation signal for long-running tools. */
  abortSignal?: AbortSignal;
  /** Optional sandbox policy for command execution. */
  sandbox?: SandboxPolicy;
  /** Optional approval callback — return true to approve, false to deny. */
  requestApproval?: (tool: string, args: Record<string, unknown>, reason: string) => Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  /** Human-readable (and LLM-readable) text output from the tool. */
  output: string;
  /** Present only when ok === false. */
  error?: string;
}

export interface ToolParameterSchema {
  /** "object" and "array" are used by MCP-sourced tools; internal tools use the scalar types. */
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  /** Restrict to a fixed set of values. */
  enum?: string[];
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, ToolParameterSchema>;
  required: string[];
}

export interface Tool {
  /** Identifier used in <tool_call> JSON and the LLM prompt. */
  name: string;
  description: string;
  schema: ToolSchema;
  execute(input: Record<string, unknown>, ctx: ToolRunCtx): Promise<ToolResult>;
}
