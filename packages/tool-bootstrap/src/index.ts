/**
 * @clawde/tool-bootstrap — Shared tool-loading bootstrap for Orca
 *
 * Assembles all tool sources into one OrcaToolService:
 *   1. Core workbench tools  (read_file, write_file, run_command, list_directory, search_files)
 *   2. Static extensions     (@clawde/ext-github, @clawde/ext-docs, @clawde/ext-web)
 *   3. MCP servers           (any McpServerConfig entries from orca-settings.json)
 *
 * Both the runner CLI and the desktop Electron app call buildToolBootstrap()
 * instead of wiring tools individually.
 *
 * Usage:
 *   const bootstrap = await buildToolBootstrap({ workspaceRoot, mcpServers, log });
 *   // pass to createOrcaRuntime:
 *   createOrcaRuntime({ ..., tools: bootstrap.toolService });
 *   // pass allTools to buildMaestroAdapter after adaptation:
 *   const agentTools = bootstrap.allTools.map(t => adaptToAgentTool(t, workspaceRoot));
 *   // on shutdown:
 *   await bootstrap.dispose();
 */

import { createExtensionRegistry } from "@clawde/orca-core";
import type { OrcaExtension, OrcaToolService } from "@clawde/orca-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
import type { Tool } from "@yakstacks/workbench-core";
import { githubExtension } from "@clawde/ext-github";
import { docsExtension } from "@clawde/ext-docs";
import { webExtension } from "@clawde/ext-web";
import { loadMcpExtensions } from "@clawde/mcp-client";
import type { McpServerConfig } from "@clawde/mcp-client";

export type { McpServerConfig } from "@clawde/mcp-client";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Minimal shared tool shape returned from buildToolBootstrap.
 * Structurally compatible with both workbench-core Tool and orca-core ExtTool.
 * The desktop maps these to its AgentTool[] via adaptToolsForMaestro().
 */
export interface BootstrappedTool {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  execute(
    input: Record<string, unknown>,
    ctx: {
      workspaceRoot: string;
      runId: string;
      abortSignal?: AbortSignal;
      requestApproval?: (
        tool: string,
        args: Record<string, unknown>,
        reason: string,
      ) => Promise<boolean>;
    },
  ): Promise<{ ok: boolean; output: string; error?: string }>;
}

export interface ToolBootstrapConfig {
  /** Absolute path to the user's workspace folder. Passed to every tool. */
  workspaceRoot: string;

  /**
   * MCP server definitions from orca-settings.json.
   * Omit or pass [] to skip MCP loading.
   */
  mcpServers?: McpServerConfig[];

  /**
   * Logger used for MCP connection progress and tool-call tracing.
   * Defaults to console.log.
   */
  log?: (msg: string) => void;
}

export interface ToolBootstrap {
  /**
   * Pass to createOrcaRuntime({ tools: bootstrap.toolService }).
   * Executes tools and renders their prompt descriptions.
   */
  toolService: OrcaToolService;

  /**
   * Flat list of every registered tool.
   * Use adaptToolsForMaestro() to convert to the desktop's AgentTool[].
   */
  allTools: BootstrappedTool[];

  /**
   * Names of every tool that was successfully loaded.
   * Useful for logging and per-role allowlist validation.
   */
  allToolNames: string[];

  /**
   * Names of tools that came from MCP servers (for tracing/display).
   */
  mcpToolNames: string[];

  /**
   * Close all MCP server connections. Call once on app shutdown.
   * Safe to call even when no MCP servers were loaded.
   */
  dispose(): Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Build the complete tool stack for both the runner CLI and the desktop app.
 *
 * Connection failures for individual MCP servers are warned and skipped —
 * they never abort the overall bootstrap.
 */
export async function buildToolBootstrap(
  cfg: ToolBootstrapConfig,
): Promise<ToolBootstrap> {
  const log = cfg.log ?? console.log;
  const workspaceRoot = cfg.workspaceRoot;

  // ── Step 1: core workbench tools ─────────────────────────────────────────
  const coreRegistry = createCoreToolRegistry();
  log(`[tools] Core tools: ${coreRegistry.list().map((t) => t.name).join(", ")}`);

  // ── Step 2: static extension tools ───────────────────────────────────────
  // Load individually so one broken ext never stops the rest.
  const staticExtensions: OrcaExtension[] = [];
  for (const ext of [githubExtension, docsExtension, webExtension]) {
    try {
      await ext.onLoad?.();
      staticExtensions.push(ext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[tools] ⚠ Failed to load static extension "${ext.id}": ${msg} — skipped`);
    }
  }

  // ── Step 3: MCP tools ─────────────────────────────────────────────────────
  const mcpExtensions =
    cfg.mcpServers && cfg.mcpServers.length > 0
      ? await loadMcpExtensions(cfg.mcpServers, log)
      : [];

  // ── Step 4: load all extensions into a registry (calls onLoad() on each) ─
  // Static exts already had onLoad() called above; pass them directly to avoid
  // double-loading. MCP exts need the registry to call their onLoad().
  const extRegistry = await createExtensionRegistry(mcpExtensions);

  // ── Step 5: register all tools into the core registry ───────────────────
  // ExtTool is structurally identical to workbench-core Tool — safe cast.
  const mcpToolNames: string[] = [];

  // Static extension tools (already onLoad()'d above)
  for (const ext of staticExtensions) {
    for (const extTool of ext.tools) {
      coreRegistry.register(extTool as unknown as Tool);
    }
  }

  // MCP extension tools (loaded via registry above)
  for (const ext of extRegistry.getAll()) {
    for (const extTool of ext.tools) {
      coreRegistry.register(extTool as unknown as Tool);
      mcpToolNames.push(extTool.name);
    }
  }

  const allToolNames = coreRegistry.list().map((t) => t.name);
  log(`[tools] Total tools registered: ${allToolNames.length} (${mcpToolNames.length} from MCP)`);

  // ── Step 6: build OrcaToolService ─────────────────────────────────────────
  const toolService: OrcaToolService = {
    execute(name: string, input: Record<string, unknown>) {
      const tool = coreRegistry.get(name);
      if (!tool) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `Unknown tool: "${name}". Available: ${allToolNames.join(", ")}`,
        });
      }
      return tool.execute(input, { workspaceRoot, runId: "" });
    },

    formatForPrompt(): string {
      return `Workspace root: ${workspaceRoot}\n\n${coreRegistry.formatForPrompt()}`;
    },
  };

  // ── Step 7: expose allTools for AgentTool[] mapping ───────────────────────
  // Cast: coreRegistry.list() returns Tool[], which is structurally
  // compatible with BootstrappedTool[] (the execute ctx is a superset).
  const allTools = coreRegistry.list() as unknown as BootstrappedTool[];

  // ── Step 8: dispose (close MCP connections on shutdown) ───────────────────
  const dispose = async (): Promise<void> => {
    // Unload MCP extensions via the registry (which calls each onUnload)
    for (const ext of mcpExtensions) {
      try { await extRegistry.unload(ext.id); } catch { /* best-effort */ }
    }
    // Unload static extensions directly (not in registry)
    for (const ext of staticExtensions) {
      try { await ext.onUnload?.(); } catch { /* best-effort */ }
    }
  };

  return { toolService, allTools, allToolNames, mcpToolNames, dispose };
}
