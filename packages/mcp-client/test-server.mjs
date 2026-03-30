/**
 * Minimal MCP test server — exposes three tools covering the three schema
 * conversion paths tested by the integration suite:
 *
 *   1. echo_message     — simple scalar args (string + integer)
 *   2. describe_color   — enum-based arg
 *   3. summarise_config — nested object + array args (object→string path)
 *
 * Run directly:
 *   node packages/mcp-client/test-server.mjs
 *
 * The runner wires it in via ORCA_MCP_CONFIG env var.
 */

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "orca-test-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tool list ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo_message",
      description: "Echoes the message back with an optional repeat count.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string",  description: "Text to echo" },
          repeat:  { type: "integer", description: "How many times to repeat (default 1)" },
        },
        required: ["message"],
      },
    },
    {
      name: "describe_color",
      description: "Returns a short description of the named colour.",
      inputSchema: {
        type: "object",
        properties: {
          color: {
            type: "string",
            enum: ["red", "green", "blue", "yellow"],
            description: "The colour to describe",
          },
        },
        required: ["color"],
      },
    },
    {
      name: "summarise_config",
      description: "Returns a human-readable summary of the provided config object.",
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            description: "A JSON config object with arbitrary keys",
            properties: { name: { type: "string" }, debug: { type: "boolean" } },
          },
          tags: {
            type: "array",
            description: "Optional list of string tags",
            items: { type: "string" },
          },
        },
        required: ["config"],
      },
    },
  ],
}));

// ── Tool call handler ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const { name, arguments: args } = req.params;

  if (name === "echo_message") {
    const message = String(args?.message ?? "");
    const repeat  = Math.max(1, parseInt(String(args?.repeat ?? "1"), 10) || 1);
    return { content: [{ type: "text", text: `Echoed ${repeat}x:\n${Array(repeat).fill(message).join("\n")}` }] };
  }

  if (name === "describe_color") {
    const descs = {
      red:    "Red — warm, energetic, signals urgency.",
      green:  "Green — natural, calming, associated with growth.",
      blue:   "Blue — cool, trustworthy, widely used in tech.",
      yellow: "Yellow — bright, optimistic, attention-grabbing.",
    };
    const color = String(args?.color ?? "");
    return { content: [{ type: "text", text: descs[color] ?? `Unknown colour: "${color}"` }] };
  }

  if (name === "summarise_config") {
    // config arrives as a JSON string (object→string schema conversion in mcp-client).
    let cfg = args?.config ?? {};
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch {} }

    let tags = args?.tags ?? [];
    if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = [tags]; } }

    const keys = Object.keys(cfg);
    const tagList = Array.isArray(tags) ? tags : [String(tags)];
    return { content: [{ type: "text", text:
      `Config has ${keys.length} key(s): ${keys.join(", ") || "(none)"}\n` +
      (tagList.length > 0 ? `Tags: ${tagList.join(", ")}` : "No tags."),
    }] };
  }

  return { isError: true, content: [{ type: "text", text: `Unknown tool: "${name}"` }] };
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
