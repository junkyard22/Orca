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

    // Build a concrete example from the first tool's required params,
    // using native JSON shapes ({} / []) for object and array params.
    const [firstTool] = this.tools.values();
    const exampleArgs: Record<string, unknown> = { tool: firstTool!.name };
    for (const param of firstTool!.schema.required) {
      const spec = firstTool!.schema.properties[param];
      const t = spec?.type ?? "string";
      if (t === "object") exampleArgs[param] = {};
      else if (t === "array") exampleArgs[param] = [];
      else exampleArgs[param] = spec?.description ? `<${param}>` : "value";
    }
    const exampleJson = JSON.stringify(exampleArgs);

    const lines: string[] = [
      "## Tools",
      "",
      "You may call tools to complete this task. Use exactly one tool call at a time.",
      "Wait for the tool result before continuing.",
      "When your task is fully complete, give your final answer without a trailing tool call.",
      "",
      "TOOL CALL SYNTAX — use ONLY this exact JSON format:",
      "<tool_call>",
      '{"tool": "tool_name", "arg_name": "arg_value"}',
      "</tool_call>",
      "",
      "RULES:",
      '- "tool" must be the exact tool name',
      "- Other keys are the specific parameters for that tool",
      "- Always close with </tool_call>",
      "- Do NOT use XML-style <arg_key>/<arg_value> tags",
      "- Object params must be native JSON objects — not serialised strings",
      "- Array params must be native JSON arrays — not serialised strings",
      "",
      `EXAMPLE (${firstTool!.name}):`,
      "<tool_call>",
      exampleJson,
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
      // For tools with structured (object/array) params, add a per-tool call example
      // so the model sees the exact native JSON shape it must emit.
      const hasStructured = Object.values(properties).some(
        (s) => s.type === "object" || s.type === "array",
      );
      if (hasStructured) {
        const callShape: Record<string, unknown> = { tool: tool.name };
        for (const param of required) {
          const spec = properties[param];
          if (!spec) continue;
          if (spec.type === "object") callShape[param] = {};
          else if (spec.type === "array") callShape[param] = [];
          else callShape[param] = `<${param}>`;
        }
        lines.push("  Call example:");
        lines.push("  <tool_call>");
        lines.push(`  ${JSON.stringify(callShape)}`);
        lines.push("  </tool_call>");
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
