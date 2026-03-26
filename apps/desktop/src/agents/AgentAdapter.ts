import type { RoleName } from "maestro-core";
import type { LLMMessage as Message } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";

export interface AgentTask {
  intent: string;
  goals: string[];
  doneCriteria: string[];
  conversationHistory?: Message[];
}

export interface ThoughtRecord {
  iteration: number;
  thought: string;
  observation: string;
  next: string;
}

export interface AgentResult {
  outputText: string;
  thoughts: ThoughtRecord[];
  toolsUsed: ToolEvent[];
  filesChanged: FileChange[];
  iterationCount: number;
  stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'parse_failure_loop' | 'no_final_output' | 'error';
  error?: string;
  loopEvidence?: {
    iteration: number;
    repeatedCall: string;
    occurrences: number;
  };
}

/**
 * Callback for streaming output tokens.
 * Called for each token/chunk as the model generates output.
 */
export type StreamCallback = (chunk: string) => void;

/**
 * Extended agent context that includes streaming support.
 */
export interface AgentRunContext extends OrcaRunCtx {
  /** Optional callback for streaming output tokens */
  onStreamToken?: StreamCallback;
  /** Optional callback when stream is reset (e.g., before a new response) */
  onStreamReset?: () => void;
}

export interface AgentAdapter {
  readonly role: RoleName;
  run(task: AgentTask, tools: Tool[], ctx: AgentRunContext): Promise<AgentResult>;
}

// Type definitions for tools and events
type Tool = {
  name: string;
  description: string;
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string }>;
  };
  execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }>;
};
type ToolEvent = { tool: string; ok: boolean; summary: string; raw?: unknown };
type FileChange = { path: string; changeType: "A" | "M" | "D"; diff?: string };
