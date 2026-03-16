import type { LLMAdapter } from "@clawde/miranda-core";
import type { AgentAdapter, AgentTask, AgentResult, AgentRunContext } from "./AgentAdapter";
import { ReactAgentAdapter } from "./ReactAgentAdapter";
import { getRolePrompt, RoleName } from "maestro-core";

// Type definitions
type Tool = { name: string; description: string; execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }> };

export class RoleAgentAdapter implements AgentAdapter {
  readonly role: RoleName;
  private agent: ReactAgentAdapter;

  constructor(
    role: RoleName,
    llmAdapter: LLMAdapter,
    maxIterations?: number,
    maxTokens?: number,
    temperature?: number,
  ) {
    this.role = role;
    const systemPrompt = getRolePrompt(role);
    this.agent = new ReactAgentAdapter(llmAdapter, systemPrompt, role, maxIterations, maxTokens, temperature);
  }

  run(task: AgentTask, tools: Tool[], ctx: AgentRunContext): Promise<AgentResult> {
    return this.agent.run(task, tools, ctx);
  }
}