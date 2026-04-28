import type { McpServerConfig, OrcaSettings } from "./settings";

const LEGACY_GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server";

/**
 * Normalize saved MCP settings into the runtime shape expected by currently
 * supported stdio servers. This does not rewrite the user's settings file.
 */
export function normalizeMcpServersForRuntime(settings: OrcaSettings): McpServerConfig[] {
  return (settings.mcpServers ?? []).map((server) => {
    if (server.id !== "github-mcp") return server;

    const env = { ...(server.env ?? {}) };
    const token =
      env["GITHUB_TOKEN"] ??
      env["GITHUB_PERSONAL_ACCESS_TOKEN"] ??
      settings.githubToken;

    if (token) {
      env["GITHUB_TOKEN"] ??= token;
      env["GITHUB_PERSONAL_ACCESS_TOKEN"] ??= token;
    }

    const usesLegacyDockerImage =
      server.command === "docker" &&
      (server.args ?? []).includes(LEGACY_GITHUB_MCP_IMAGE);

    if (usesLegacyDockerImage) {
      return {
        ...server,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env,
      };
    }

    return {
      ...server,
      env: Object.keys(env).length > 0 ? env : server.env,
    };
  });
}
