import type { Tool } from "./types.js";

/**
 * ToolRegistry — holds named tools and can render their definitions as a
 * prompt block that the LLM uses to know when and how to call each tool.
 *
 * Usage:
 *   const registry = new ToolRegistry()
 *     .register(readFileTool)
 *     .register(writeFileTool);
 *
 *   // Inject into system prompt:
 *   systemPrompt += registry.formatForPrompt();
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns a prompt-ready block that describes every registered tool.
   * Injected into the LLM system prompt before each agent run.
   *
   * Calling convention taught to the model:
   *
   *   <tool_call>
   *   {"tool": "TOOL_NAME", "PARAM": "VALUE"}
   *   </tool_call>
   *
   * The agent loop in maestroAdapter parses these blocks, executes the
   * tool, and feeds back:
   *
   *   <tool_result tool="TOOL_NAME" ok="true|false">
   *   ...output or error...
   *   </tool_result>
   */
  formatForPrompt(): string {
    if (this.tools.size === 0) return "";

    const lines: string[] = [
      "## Tools",
      "",
      "You may call tools to complete this task. Use exactly one tool call at a time.",
      "Wait for the tool result before continuing.",
      "When your task is fully complete, give your final answer without a trailing tool call.",
      "",
      "TOOL CALL SYNTAX:",
      "<tool_call>",
      '{"tool": "TOOL_NAME", "PARAM": "VALUE"}',
      "</tool_call>",
      "",
      "### Available Tools",
      "",
    ];

    for (const tool of this.tools.values()) {
      lines.push(`**${tool.name}** — ${tool.description}`);
      const { properties, required } = tool.schema;
      for (const [param, spec] of Object.entries(properties)) {
        const req = required.includes(param) ? "" : ", optional";
        lines.push(`  - ${param} (${spec.type}${req}): ${spec.description}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
