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

/**
 * The MCP servers Orca may launch for these settings.
 *
 * Summit Demo Mode launches none: the demo needs only the built-in file and
 * command tools, and starting GitHub MCP or Desktop Commander (docker/npx,
 * possibly downloading packages) would put external-write and process-control
 * tools in front of a public audience. Execution-time authorization still
 * blocks such tools in Demo Mode; this keeps them from starting at all.
 * Outside Demo Mode, the saved configuration applies unchanged. The saved
 * settings are not modified — the same servers start again when Demo Mode is off.
 */
export function mcpServersForRuntime(settings: OrcaSettings): McpServerConfig[] {
  if (settings.demoMode === true) return [];
  return normalizeMcpServersForRuntime(settings);
}

/**
 * The GITHUB_TOKEN exported to the process for the ext-github tools.
 * Demo Mode exports none, so a demo run cannot read private repositories
 * with the presenter's token. Elsewhere: the dedicated setting first, then
 * the GitHub MCP server's PAT.
 */
export function githubTokenForRuntime(settings: OrcaSettings, servers: McpServerConfig[]): string | undefined {
  if (settings.demoMode === true) return undefined;
  const gh = servers.find((srv) => srv.id === "github-mcp");
  return (
    settings.githubToken ||
    gh?.env?.["GITHUB_TOKEN"] ||
    gh?.env?.["GITHUB_PERSONAL_ACCESS_TOKEN"] ||
    undefined
  );
}
