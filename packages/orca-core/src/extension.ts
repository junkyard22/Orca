/**
 * orca-core — Extension / Adapter System  (Phase 7)
 *
 * OrcaExtension enables third parties (and built-in packages) to add tools
 * to the runtime without touching core code.
 *
 * Dependency rule: orca-core must NOT import from workbench-core.
 * ExtTool is structurally identical to workbench-core's Tool interface so
 * that workbench tools satisfy it without an import-chain coupling.
 *
 * Extension wiring (app shell):
 *   const reg = await createExtensionRegistry([githubExt, webExt]);
 *   const tools = reg.asToolService();
 *   const runtime = createOrcaRuntime({ maestro, pappy, llm, tools });
 */

// ---------------------------------------------------------------------------
// Minimal tool contract (structurally identical to workbench-core's Tool)
// ---------------------------------------------------------------------------

export interface ExtToolRunCtx {
  workspaceRoot: string;
  runId: string;
}

export interface ExtToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ExtToolParamSchema {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
}

export interface ExtTool {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, ExtToolParamSchema>;
    required: string[];
  };
  execute(
    input: Record<string, unknown>,
    ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult>;
}

// ---------------------------------------------------------------------------
// Extension interface
// ---------------------------------------------------------------------------

export interface OrcaExtension {
  /** Unique reverse-domain ID, e.g. "@orca/ext-github". */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Tools this extension adds to every agent's tool-call repertoire. */
  readonly tools: ExtTool[];
  /** Called once when the extension is loaded. Use for auth checks, setup, etc. */
  onLoad?(): Promise<void>;
  /** Called when the extension is explicitly unloaded. */
  onUnload?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Extension registry — collects extensions, converts them to OrcaToolService
// ---------------------------------------------------------------------------

/**
 * OrcaToolService shape — re-declared here (structurally compatible with
 * orca-core types.ts) to avoid circular imports inside this module.
 */
interface _ToolService {
  execute(name: string, input: Record<string, unknown>): Promise<ExtToolResult>;
  formatForPrompt(): string;
}

export class ExtensionRegistry {
  private readonly _exts = new Map<string, OrcaExtension>();

  /** Load an extension. Calls ext.onLoad() and registers all its tools. */
  async load(ext: OrcaExtension): Promise<void> {
    if (this._exts.has(ext.id)) {
      throw new Error(`Extension "${ext.id}" is already loaded.`);
    }
    await ext.onLoad?.();
    this._exts.set(ext.id, ext);
  }

  /** Unload a previously loaded extension by id. */
  async unload(id: string): Promise<void> {
    const ext = this._exts.get(id);
    if (!ext) return;
    await ext.onUnload?.();
    this._exts.delete(id);
  }

  getAll(): OrcaExtension[] {
    return Array.from(this._exts.values());
  }

  /** Flat list of every tool contributed by every loaded extension. */
  allTools(): ExtTool[] {
    return this.getAll().flatMap((e) => e.tools);
  }

  /**
   * Convert the registry into an OrcaToolService that can be passed directly
   * to createOrcaRuntime({ tools }).
   */
  asToolService(workspaceRoot: string = process.cwd()): _ToolService {
    const tools = this.allTools();
    const byName = new Map<string, ExtTool>(tools.map((t) => [t.name, t]));

    return {
      execute(name: string, input: Record<string, unknown>) {
        const tool = byName.get(name);
        if (!tool) {
          const available = tools.map((t) => t.name).join(", ");
          return Promise.resolve({
            ok: false,
            output: "",
            error: `Unknown tool: "${name}". Available: ${available || "(none)"}`,
          });
        }
        return tool.execute(input, { workspaceRoot, runId: "" });
      },

      formatForPrompt() {
        if (tools.length === 0) return "";
        const defs = tools.map((t) => {
          const params = Object.entries(t.schema.properties)
            .map(([k, v]) => {
              const req = t.schema.required.includes(k) ? " (required)" : " (optional)";
              const en = v.enum ? `  options: ${v.enum.join(", ")}` : "";
              return `  ${k} [${v.type}${req}]: ${v.description}${en}`;
            })
            .join("\n");
          return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
        });
        return [
          "## Extension Tools",
          "",
          "Use the following tools by outputting a <tool_call> block.",
          "SYNTAX: <tool_call>{\"tool\": \"NAME\", ...params}</tool_call>",
          "",
          ...defs,
        ].join("\n");
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Load a list of extensions and return a ready registry.
 *
 * @example
 *   const reg   = await createExtensionRegistry([githubExt, webExt]);
 *   const tools = reg.asToolService(workspaceRoot);
 *   const runtime = createOrcaRuntime({ maestro, pappy, llm, tools });
 */
export async function createExtensionRegistry(
  extensions: OrcaExtension[],
): Promise<ExtensionRegistry> {
  const registry = new ExtensionRegistry();
  for (const ext of extensions) {
    try {
      await registry.load(ext);
      console.info(`[ExtensionRegistry] Loaded: ${ext.id} v${ext.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ExtensionRegistry] Failed to load ${ext.id}: ${msg}`);
    }
  }
  return registry;
}
