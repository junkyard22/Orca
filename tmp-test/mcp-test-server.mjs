/**
 * Minimal MCP test server — exposes three tools that exercise the three
 * schema conversion paths in mcp-client's convertSchema():
 *
 *   1. echo_message     — simple scalar args (string + number)
 *   2. describe_color   — enum-based arg
 *   3. summarise_config — nested object + array args
 *
 * Run via:
 *   node tmp-test/mcp-test-server.mjs
 *
 * It communicates over stdio so the MCP client can spawn it directly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "orca-test-server", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ── Tool list ────────────────────────────────────────────────────────────────

server.setRequestHandler({ method: "tools/list" }, () => ({
  tools: [
    // ── Tool 1: simple scalars ──────────────────────────────────────────────
    {
      name: "echo_message",
      description: "Echoes the message back with an optional repeat count.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Text to echo" },
          repeat:  { type: "integer", description: "How many times to repeat (default 1)" },
        },
        required: ["message"],
      },
    },

    // ── Tool 2: enum arg ───────────────────────────────────────────────────
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

    // ── Tool 3: nested object + array ──────────────────────────────────────
    {
      name: "summarise_config",
      description: "Returns a human-readable summary of the provided config object.",
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            description: "A JSON config object with arbitrary keys",
            properties: {
              name:  { type: "string" },
              debug: { type: "boolean" },
            },
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

server.setRequestHandler({ method: "tools/call" }, (req) => {
  const { name, arguments: args } = req.params;

  // ── echo_message ──
  if (name === "echo_message") {
    const message = String(args?.message ?? "");
    const repeat  = Math.max(1, parseInt(String(args?.repeat ?? "1"), 10) || 1);
    const output  = Array(repeat).fill(message).join("\n");
    return { content: [{ type: "text", text: `Echoed ${repeat}x:\n${output}` }] };
  }

  // ── describe_color ──
  if (name === "describe_color") {
    const color = String(args?.color ?? "");
    const descriptions = {
      red:    "Red is warm, energetic, and signals urgency.",
      green:  "Green is natural, calming, and associated with growth.",
      blue:   "Blue is cool, trustworthy, and widely used in tech.",
      yellow: "Yellow is bright, optimistic, and attention-grabbing.",
    };
    const text = descriptions[color] ?? `Unknown colour: "${color}"`;
    return { content: [{ type: "text", text }] };
  }

  // ── summarise_config ──
  if (name === "summarise_config") {
    // args.config arrives as a JSON string (due to object→string schema conversion)
    // or as a plain object if the caller passed it natively.
    let configObj = args?.config ?? {};
    if (typeof configObj === "string") {
      try { configObj = JSON.parse(configObj); } catch { /* leave as string */ }
    }

    let tagsArr = args?.tags ?? [];
    if (typeof tagsArr === "string") {
      try { tagsArr = JSON.parse(tagsArr); } catch { tagsArr = [tagsArr]; }
    }

    const keys  = Object.keys(configObj);
    const tags  = Array.isArray(tagsArr) ? tagsArr : [String(tagsArr)];
    const text  = [
      `Config has ${keys.length} key(s): ${keys.join(", ") || "(none)"}`,
      tags.length > 0 ? `Tags: ${tags.join(", ")}` : "No tags.",
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: "${name}"` }],
  };
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until the client closes the connection (stdin EOF).
