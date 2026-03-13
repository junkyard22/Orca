/**
 * Type declarations for @yakstacks/workbench-core
 */
declare module '@yakstacks/workbench-core' {
  export interface Tool {
    name: string;
    description: string;
    execute(input: Record<string, unknown>, context: { workspaceRoot: string; runId?: string }): Promise<{ ok: boolean; output: string; error?: string }>;
  }

  export interface ToolRegistry {
    get(name: string): Tool | undefined;
    list(): Tool[];
    formatForPrompt(): string;
  }

  export function createCoreToolRegistry(): ToolRegistry;
}