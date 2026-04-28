import { describe, expect, it } from "vitest";
import type { OrcaSettings } from "./settings";
import { normalizeMcpServersForRuntime } from "./mcpRuntimeConfig";

describe("normalizeMcpServersForRuntime", () => {
  const baseSettings: OrcaSettings = {
    providers: [],
    roles: {},
    budgetUsd: 0.25,
    maxRepairPasses: 2,
    verbose: false,
  };

  it("rewrites legacy Docker GitHub MCP config to npx and preserves the PAT", () => {
    const normalized = normalizeMcpServersForRuntime({
      ...baseSettings,
      mcpServers: [
        {
          id: "github-mcp",
          name: "GitHub MCP",
          transport: "stdio",
          command: "docker",
          args: [
            "run",
            "-i",
            "--rm",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server",
          ],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test" },
          enabled: true,
        },
      ],
    });

    expect(normalized[0]).toMatchObject({
      id: "github-mcp",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test",
        GITHUB_TOKEN: "ghp_test",
      },
    });
  });

  it("uses the top-level GitHub token when the MCP entry has no token", () => {
    const normalized = normalizeMcpServersForRuntime({
      ...baseSettings,
      githubToken: "ghp_top_level",
      mcpServers: [
        {
          id: "github-mcp",
          name: "GitHub MCP",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          enabled: true,
        },
      ],
    });

    expect(normalized[0]?.env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_top_level",
      GITHUB_TOKEN: "ghp_top_level",
    });
  });
});
