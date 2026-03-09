import type { LLMAdapter } from "@clawde/miranda-core";
import type { AgentAdapter, AgentTask, AgentResult } from "./AgentAdapter";
import { ReactAgentAdapter } from "./ReactAgentAdapter";
import { getRolePrompt, RoleName } from "maestro-core";
import type { OrcaRunCtx } from "@clawde/orca-core";

// Type definitions
type Tool = { name: string; description: string; execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }> };

export class RoleAgentAdapter implements AgentAdapter {
  readonly role: RoleName;
  private agent: ReactAgentAdapter;

  constructor(
    role: RoleName,
    llmAdapter: LLMAdapter,
    maxIterations?: number
  ) {
    this.role = role;
    const systemPrompt = getRolePrompt(role);
    this.agent = new ReactAgentAdapter(llmAdapter, systemPrompt, role, maxIterations);
  }

  run(task: AgentTask, tools: Tool[], ctx: OrcaRunCtx): Promise<AgentResult> {
    return this.agent.run(task, tools, ctx);
  }
}