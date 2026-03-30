/**
 * Configuration for a single MCP server instance.
 * Stored in orca-settings.json under mcpServers[].
 */
export interface McpServerConfig {
  /**
   * Stable identifier used in logging and (optionally) tool-name namespacing.
   * e.g. "filesystem", "github-mcp", "sqlite"
   */
  id: string;

  /** Display name shown in logs and future settings UI, e.g. "Filesystem MCP" */
  name: string;

  /**
   * Transport type. Only "stdio" is supported today.
   * SSE support can be added later by extending this union.
   */
  transport: "stdio";

  /**
   * Executable to spawn for the MCP server.
   * Examples: "npx", "node", "python", "/usr/local/bin/uvx"
   */
  command: string;

  /** Arguments passed after the command, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/home"] */
  args?: string[];

  /**
   * Extra environment variables merged with process.env for the server process.
   * Use this to pass API keys and other secrets to the server.
   * Example: { "GITHUB_TOKEN": "ghp_xyz" }
   */
  env?: Record<string, string>;

  /**
   * When true (default), each tool name is prefixed with "${id}_" to avoid
   * collisions between servers that share tool names.
   * Set to false only if this server's tool names are globally unique.
   */
  namespaceTools?: boolean;

  /**
   * When false, this server entry is ignored at startup without error.
   * Useful for temporarily disabling a server without removing its config.
   * Defaults to true.
   */
  enabled?: boolean;
}
