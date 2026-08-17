import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: false,
  encryptString: vi.fn((plaintext: string) => Buffer.from(`cipher:${plaintext}`, "utf-8")),
  decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString("utf-8").replace(/^cipher:/, "")),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataPath),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => electronState.encryptionAvailable),
    encryptString: electronState.encryptString,
    decryptString: electronState.decryptString,
  },
}));

import type { OrcaSettings } from "./settings";
import { loadSettings, saveSettings } from "./settings";

describe("settings", () => {
  let userDataDir: string;

  const baseSettings: OrcaSettings = {
    providers: [
      {
        id: "provider-1",
        name: "OpenRouter",
        type: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "secret-key",
      },
    ],
    roles: {
      brain: {
        providerId: "provider-1",
        model: "anthropic/claude-3.5-sonnet",
      },
    },
    budgetUsd: 0.25,
    maxRepairPasses: 3,
    verbose: true,
    workspaceRoot: "C:\\workspace",
  };

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "orca-settings-"));
    electronState.userDataPath = userDataDir;
    electronState.encryptionAvailable = false;
    electronState.encryptString.mockClear();
    electronState.decryptString.mockClear();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("round-trips API keys when encryption is unavailable", async () => {
    await saveSettings(baseSettings);

    const saved = JSON.parse(readFileSync(join(userDataDir, "orca-settings.json"), "utf-8")) as OrcaSettings;
    expect(saved.providers[0]?.apiKey).toBe("plain:secret-key");

    const loaded = await loadSettings();
    expect(loaded).toEqual(baseSettings);
  });

  it("stores encrypted keys when safeStorage is available", async () => {
    electronState.encryptionAvailable = true;

    await saveSettings(baseSettings);

    const saved = JSON.parse(readFileSync(join(userDataDir, "orca-settings.json"), "utf-8")) as OrcaSettings;
    expect(saved.providers[0]?.apiKey).toBe("enc:Y2lwaGVyOnNlY3JldC1rZXk=");

    const loaded = await loadSettings();
    expect(loaded.providers[0]?.apiKey).toBe("secret-key");
    expect(electronState.encryptString).toHaveBeenCalledWith("secret-key");
    expect(electronState.decryptString).toHaveBeenCalled();
  });

  it("round-trips MCP server env secrets (GitHub PAT) when encryption is unavailable", async () => {
    const settingsWithMcp: OrcaSettings = {
      ...baseSettings,
      mcpServers: [
        {
          id: "github-mcp",
          name: "GitHub MCP",
          transport: "stdio",
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
                 "ghcr.io/github/github-mcp-server"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test_token_abc123" },
          enabled: true,
        },
        {
          id: "desktop-commander",
          name: "Desktop Commander",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@wonderwhy-er/desktop-commander"],
          // env is undefined — should survive round-trip unchanged
          enabled: true,
        },
      ],
    };

    await saveSettings(settingsWithMcp);

    const saved = JSON.parse(
      readFileSync(join(userDataDir, "orca-settings.json"), "utf-8"),
    ) as OrcaSettings;

    // GitHub PAT must be stored as plaintext on disk (encryption unavailable)
    const ghEnv = saved.mcpServers?.[0]?.env;
    expect(ghEnv?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("plain:ghp_test_token_abc123");

    // Desktop Commander has no env — must stay undefined
    expect(saved.mcpServers?.[1]?.env).toBeUndefined();

    // Full round-trip: loaded value must equal original
    const loaded = await loadSettings();
    expect(loaded.mcpServers?.[0]?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_test_token_abc123");
    expect(loaded.mcpServers?.[1]?.env).toBeUndefined();
  });

  it("encrypts MCP server env secrets via safeStorage when available", async () => {
    electronState.encryptionAvailable = true;

    const settingsWithMcp: OrcaSettings = {
      ...baseSettings,
      mcpServers: [
        {
          id: "github-mcp",
          name: "GitHub MCP",
          transport: "stdio",
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
                 "ghcr.io/github/github-mcp-server"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret_pat" },
          enabled: true,
        },
      ],
    };

    await saveSettings(settingsWithMcp);

    const saved = JSON.parse(
      readFileSync(join(userDataDir, "orca-settings.json"), "utf-8"),
    ) as OrcaSettings;

    // PAT must be stored with enc: prefix (safeStorage encrypted)
    expect(saved.mcpServers?.[0]?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toMatch(/^enc:/);

    // Round-trip: plaintext must be recovered after decrypt
    const loaded = await loadSettings();
    expect(loaded.mcpServers?.[0]?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_secret_pat");
    expect(electronState.encryptString).toHaveBeenCalledWith("ghp_secret_pat");
    expect(electronState.decryptString).toHaveBeenCalled();
  });

  it("migrates legacy settings files into provider-role settings", async () => {
    writeFileSync(
      join(userDataDir, "orca-settings.json"),
      JSON.stringify({
        provider: "openrouter",
        apiKey: "legacy-key",
        budgetUsd: 0.5,
        maxRepairPasses: 4,
        verbose: true,
      }),
      "utf-8",
    );

    const loaded = await loadSettings();

    expect(loaded.providers).toEqual([
      {
        id: "openrouter_migrated",
        name: "OpenRouter",
        type: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "legacy-key",
      },
    ]);
    expect(loaded.roles.brain).toEqual({
      providerId: "openrouter_migrated",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(loaded.budgetUsd).toBe(0.5);
    expect(loaded.maxRepairPasses).toBe(4);
    expect(loaded.verbose).toBe(true);
  });

  it("preserves workspaceRoot through legacy settings migration", async () => {
    writeFileSync(
      join(userDataDir, "orca-settings.json"),
      JSON.stringify({
        provider: "openrouter",
        apiKey: "legacy-key",
        workspaceRoot: "C:\\projects\\myapp",
      }),
      "utf-8",
    );

    const loaded = await loadSettings();

    expect(loaded.workspaceRoot).toBe("C:\\projects\\myapp");
  });

  it("preserves workspaceRoot through normal (non-legacy) settings round-trip", async () => {
    await saveSettings({ ...baseSettings, workspaceRoot: "C:\\Orca\\Orca" });

    const loaded = await loadSettings();

    expect(loaded.workspaceRoot).toBe("C:\\Orca\\Orca");
  });

  it("round-trips Cargo resolution and Narrator progress settings", async () => {
    await saveSettings({
      ...baseSettings,
      autoResolveCargo: false,
      narratorProgressMode: "model",
    });

    const loaded = await loadSettings();

    expect(loaded.autoResolveCargo).toBe(false);
    expect(loaded.narratorProgressMode).toBe("model");
  });
});
