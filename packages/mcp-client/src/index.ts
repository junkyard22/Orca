/**
 * @clawde/mcp-client — MCP (Model Context Protocol) client for Orca
 *
 * Connects to MCP servers via stdio transport, discovers their tools, and wraps
 * them as OrcaExtension instances that plug directly into ExtensionRegistry.
 *
 * Usage:
 *   import { loadMcpExtensions } from "@clawde/mcp-client";
 *   const extensions = await loadMcpExtensions(mcpServerConfigs);
 *   for (const ext of extensions) {
 *     await registry.load(ext);
 *   }
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OrcaExtension, ExtTool, ExtToolRunCtx, ExtToolResult } from "@clawde/orca-core";
import type { McpServerConfig } from "./types.js";

export type { McpServerConfig } from "./types.js";

// ── Internal SDK type stubs ─────────────────────────────────────────────────
// The MCP SDK ships its own types; these local stubs let us safely cast
// the SDK's untyped JSON responses without importing SDK types directly.

interface McpParamSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  // nested object — we flatten it to "string" with a note
  properties?: Record<string, unknown>;
  items?: unknown;
}

interface McpToolSchema {
  type?: string;
  properties?: Record<string, McpParamSchema>;
  required?: string[];
}

interface McpTool {
  name: string;
  description?: string;
  // inputSchema is optional on some servers that return minimal tool info
  inputSchema?: McpToolSchema;
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpOtherContent {
  type: string;
  [key: string]: unknown;
}

type McpContent = McpTextContent | McpOtherContent;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Merge extra env vars with process.env, stripping undefined values so
 * StdioClientTransport receives Record<string, string> (not string | undefined).
 */
function mergeEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined;
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...extra };
}

/**
 * Convert an MCP tool's inputSchema into Orca's internal ExtTool.schema shape.
 *
 * Mapping rules:
 *  - "integer" → "number"
 *  - "boolean" → "boolean"
 *  - "object"  → "string"  (nested objects are represented as a JSON string;
 *                            the model is told this in the description)
 *  - "array"   → "string"  (serialised as JSON)
 *  - anything else / missing → "string"
 *  - enum values are coerced to strings and preserved
 *  - required[] is preserved as-is; missing → []
 *  - a missing or empty inputSchema is treated as { type:"object", properties:{}, required:[] }
 */
function convertSchema(mcp: McpToolSchema | undefined): ExtTool["schema"] {
  const props: ExtTool["schema"]["properties"] = {};
  const schema = mcp ?? {};

  for (const [key, val] of Object.entries(schema.properties ?? {})) {
    const rawType = (val.type ?? "string").toLowerCase();

    let paramType: "string" | "number" | "boolean";
    let description = val.description ?? key;

    if (rawType === "number" || rawType === "integer") {
      paramType = "number";
    } else if (rawType === "boolean") {
      paramType = "boolean";
    } else if (rawType === "object") {
      paramType = "string";
      description = `${description} (pass as a JSON object string)`;
    } else if (rawType === "array") {
      paramType = "string";
      description = `${description} (pass as a JSON array string)`;
    } else {
      paramType = "string";
    }

    // Coerce enum values to strings — MCP servers may send numbers or booleans.
    const rawEnum = val.enum;
    const enumValues =
      Array.isArray(rawEnum) && rawEnum.length > 0
        ? rawEnum.map((v) => String(v))
        : undefined;

    props[key] = {
      type: paramType,
      description,
      ...(enumValues ? { enum: enumValues } : {}),
    };
  }

  return {
    type: "object",
    properties: props,
    required: Array.isArray(schema.required) ? schema.required : [],
  };
}

/**
 * Extract plain text from an MCP callTool result's content array.
 * Non-text content (images, resources) is silently skipped.
 */
function extractText(content: McpContent[]): string {
  return content
    .filter((c): c is McpTextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// ── Core connection logic ───────────────────────────────────────────────────

/**
 * Connect to a single MCP server via stdio, perform tool discovery, and
 * return an OrcaExtension wrapping all discovered tools.
 *
 * Returns null (and logs a warning) if the connection or discovery fails —
 * callers skip null entries so one bad server never blocks the rest.
 *
 * A 10-second connection timeout prevents a hanging server from delaying
 * the entire bootstrap.
 */
export async function connectMcpServer(
  cfg: McpServerConfig,
  log: (msg: string) => void = console.log,
): Promise<OrcaExtension | null> {
  const namespace = cfg.namespaceTools !== false;
  const prefix = namespace ? `${cfg.id}_` : "";

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: mergeEnv(cfg.env),
  });

  const client = new Client(
    { name: "orca-mcp-client", version: "0.1.0" },
    { capabilities: {} },
  );

  // Gate the whole connect + listTools sequence to avoid hanging the bootstrap.
  const CONNECT_TIMEOUT_MS = 10_000;

  const connectWithTimeout = <T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${CONNECT_TIMEOUT_MS}ms (${label})`));
      }, CONNECT_TIMEOUT_MS);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  };

  try {
    await connectWithTimeout(client.connect(transport), "connect");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[MCP] ✗ Failed to connect "${cfg.id}" (${cfg.command}): ${msg}`);
    // Attempt to clean up the spawned process if connect() threw after spawning
    try { await client.close(); } catch { /* best-effort */ }
    return null;
  }

  // Discover tools
  let mcpTools: McpTool[];
  try {
    const result = await connectWithTimeout(client.listTools(), "listTools");
    mcpTools = (result.tools ?? []) as McpTool[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[MCP] ✗ listTools failed for "${cfg.id}": ${msg}`);
    try { await client.close(); } catch { /* best-effort */ }
    return null;
  }

  if (mcpTools.length === 0) {
    log(`[MCP] ⚠ "${cfg.name}" (${cfg.id}): connected but exposed 0 tools — keeping alive`);
  } else {
    log(`[MCP] ✓ "${cfg.name}" (${cfg.id}): ${mcpTools.length} tool(s)`);
  }

  // Build ExtTool wrappers
  const extTools: ExtTool[] = mcpTools.map((mcpTool) => {
    const toolName = `${prefix}${mcpTool.name}`;
    log(`[MCP]   • ${toolName}`);

    return {
      name: toolName,
      description: mcpTool.description ?? mcpTool.name,
      // Guard: inputSchema may be missing on some servers
      schema: convertSchema(mcpTool.inputSchema),

      async execute(
        input: Record<string, unknown>,
        ctx: ExtToolRunCtx,
      ): Promise<ExtToolResult> {
        const t0 = Date.now();
        try {
          log(`[MCP] → ${toolName} (runId=${ctx.runId})`);

          // Call the tool using its ORIGINAL (non-prefixed) name
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: input,
          });

          const content = (result.content ?? []) as McpContent[];
          const text = extractText(content);
          const isError = (result as { isError?: boolean }).isError === true;
          const elapsed = Date.now() - t0;

          log(`[MCP] ← ${toolName} ${isError ? "ERROR" : "ok"} (${elapsed}ms)`);

          if (isError) {
            return { ok: false, output: "", error: text || "MCP server reported an error" };
          }
          return { ok: true, output: text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[MCP] ← ${toolName} threw: ${msg} (${Date.now() - t0}ms)`);
          return { ok: false, output: "", error: msg };
        }
      },
    };
  });

  // Extension ID is "@clawde/mcp-${cfg.id}" — tool-bootstrap uses this
  // prefix to identify which tools came from MCP servers.
  return {
    id: `@clawde/mcp-${cfg.id}`,
    name: cfg.name,
    version: "0.1.0",
    tools: extTools,

    async onUnload(): Promise<void> {
      try {
        await client.close();
        log(`[MCP] Disconnected from "${cfg.name}" (${cfg.id})`);
      } catch { /* best-effort — process may already be gone */ }
    },
  };
}

/**
 * Load all enabled MCP server configurations, connect to each, and return
 * the successfully connected servers as OrcaExtension instances.
 *
 * Servers that fail to connect are warned and skipped — the returned array
 * may be shorter than the input.
 */
export async function loadMcpExtensions(
  configs: McpServerConfig[],
  log: (msg: string) => void = console.log,
): Promise<OrcaExtension[]> {
  const enabled = configs.filter((c) => c.enabled !== false);

  if (enabled.length === 0) {
    return [];
  }

  log(`[MCP] Connecting to ${enabled.length} server(s)…`);

  const results = await Promise.allSettled(
    enabled.map((cfg) => connectMcpServer(cfg, log)),
  );

  const extensions: OrcaExtension[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const cfg = enabled[i]!;
    if (result.status === "rejected") {
      // connectMcpServer should never reject (it catches internally), but guard anyway
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log(`[MCP] ✗ Unexpected error loading "${cfg.id}": ${msg}`);
    } else if (result.value !== null) {
      extensions.push(result.value);
    }
  }

  log(`[MCP] Ready: ${extensions.length}/${enabled.length} server(s) connected`);
  return extensions;
}
