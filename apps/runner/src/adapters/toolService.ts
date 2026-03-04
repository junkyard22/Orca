import type { OrcaToolService } from "@clawde/orca-core";
import type { ToolRegistry, ToolRunCtx } from "@yakstacks/workbench-core";

/**
 * createToolService — bridges workbench-core's ToolRegistry to the abstract
 * OrcaToolService interface that orca-core (and MaestroAdapter) depends on.
 *
 * @param registry   Pre-populated ToolRegistry (use createCoreToolRegistry()).
 * @param workspaceRoot  Absolute path passed to every tool execute() call.
 *                       Defaults to process.cwd() if omitted.
 */
export function createToolService(
  registry: ToolRegistry,
  workspaceRoot: string = process.cwd(),
): OrcaToolService {
  return {
    execute(name: string, input: Record<string, unknown>) {
      const tool = registry.get(name);
      if (!tool) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `Unknown tool: "${name}". Available: ${registry.list().map((t) => t.name).join(", ")}`,
        });
      }
      const ctx: ToolRunCtx = { workspaceRoot, runId: "" };
      return tool.execute(input, ctx);
    },

    formatForPrompt() {
      return registry.formatForPrompt();
    },
  };
}
