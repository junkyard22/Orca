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
  stoppedBecause: 'done' | 'max_iterations' | 'error';
  error?: string;
}

export interface AgentAdapter {
  readonly role: RoleName;
  run(task: AgentTask, tools: Tool[], ctx: OrcaRunCtx): Promise<AgentResult>;
}

// Type definitions for tools and events
type Tool = { name: string; description: string; execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }> };
type ToolEvent = { tool: string; ok: boolean; summary: string; raw?: unknown };
type FileChange = { path: string; changeType: "A" | "M" | "D"; diff?: string };
