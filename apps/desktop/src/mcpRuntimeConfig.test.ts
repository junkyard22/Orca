import { describe, expect, it } from "vitest";
import type { OrcaSettings } from "./settings";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolBootstrap } from "@clawde/tool-bootstrap";
import { githubTokenForRuntime, mcpServersForRuntime, normalizeMcpServersForRuntime } from "./mcpRuntimeConfig";

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

// ── Summit Demo Mode: no MCP startup ────────────────────────────────────────
describe("MCP startup in Demo Mode", () => {
  // The two servers from the presenter's real configuration (enabled: true).
  const saved = (demoMode: boolean): OrcaSettings => ({
    providers: [], roles: {}, budgetUsd: 3, maxRepairPasses: 2, verbose: false, demoMode,
    githubToken: "ghp_test_token_value",
    mcpServers: [
      { id: "github-mcp", name: "GitHub MCP", transport: "stdio", command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"], enabled: true },
      { id: "desktop-commander", name: "Desktop Commander", transport: "stdio", command: "npx",
        args: ["-y", "@wonderwhy-er/desktop-commander"], enabled: true },
    ],
  });

  it("starts no MCP servers in Demo Mode, and does not alter the saved settings", () => {
    const settings = saved(true);
    expect(mcpServersForRuntime(settings)).toEqual([]);
    expect(settings.mcpServers).toHaveLength(2);
    expect(settings.mcpServers!.every((srv) => srv.enabled === true)).toBe(true);
  });

  it("starts the configured servers normally outside Demo Mode", () => {
    for (const demoMode of [false]) {
      const servers = mcpServersForRuntime(saved(demoMode));
      expect(servers.map((srv) => srv.id)).toEqual(["github-mcp", "desktop-commander"]);
    }
    const noFlag = saved(false); delete noFlag.demoMode;
    expect(mcpServersForRuntime(noFlag)).toHaveLength(2);
  });

  it("exports no GitHub token in Demo Mode, and the usual token outside it", () => {
    expect(githubTokenForRuntime(saved(true), mcpServersForRuntime(saved(true)))).toBeUndefined();
    expect(githubTokenForRuntime(saved(false), mcpServersForRuntime(saved(false)))).toBe("ghp_test_token_value");
    const noDedicated = { ...saved(false), githubToken: undefined };
    expect(githubTokenForRuntime(noDedicated, [{ id: "github-mcp", name: "g", transport: "stdio", command: "x", env: { GITHUB_TOKEN: "from-mcp" } }])).toBe("from-mcp");
  });

  describe("real bootstrap launches nothing in Demo Mode", () => {
    // A server whose command would create a marker file if Orca ever spawned it.
    const dir = mkdtempSync(join(tmpdir(), "orca-mcp-startup-"));
    const marker = (name: string) => join(dir, name);
    const script = join(dir, "fake-server.js");
    writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'spawned'); setTimeout(() => process.exit(1), 50);");
    const trap = (markerFile: string, demoMode: boolean): OrcaSettings => ({
      ...saved(demoMode),
      mcpServers: [{ id: "trap", name: "Trap", transport: "stdio", command: process.execPath, args: [script, markerFile], enabled: true }],
    });
    const bootstrap = (settings: OrcaSettings) =>
      buildToolBootstrap({ workspaceRoot: dir, mcpServers: mcpServersForRuntime(settings), log: () => {} });

    it("Demo Mode: the server process is never started and no MCP tools exist", async () => {
      const m = marker("demo.txt");
      const result = await bootstrap(trap(m, true));
      try {
        expect(existsSync(m)).toBe(false);
        expect(result.mcpToolNames).toEqual([]);
        expect(result.failedExtensions).toEqual([]);
      } finally { await result.dispose(); }
    }, 30_000);

    it("disabled servers are never launched outside Demo Mode either", async () => {
      const m = marker("disabled.txt");
      const settings = trap(m, false);
      settings.mcpServers![0]!.enabled = false;
      const result = await bootstrap(settings);
      try {
        expect(existsSync(m)).toBe(false);
        expect(result.mcpToolNames).toEqual([]);
        expect(result.failedExtensions).toEqual([]);
      } finally { await result.dispose(); }
    }, 30_000);

    it("control — outside Demo Mode the same server IS launched", async () => {
      const m = marker("normal.txt");
      const result = await bootstrap(trap(m, false));
      try {
        expect(existsSync(m)).toBe(true);
      } finally {
        await result.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
