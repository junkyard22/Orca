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

  it("round-trips API keys when encryption is unavailable", () => {
    saveSettings(baseSettings);

    const saved = JSON.parse(readFileSync(join(userDataDir, "orca-settings.json"), "utf-8")) as OrcaSettings;
    expect(saved.providers[0]?.apiKey).toBe("b64:c2VjcmV0LWtleQ==");

    const loaded = loadSettings();
    expect(loaded).toEqual(baseSettings);
  });

  it("stores encrypted keys when safeStorage is available", () => {
    electronState.encryptionAvailable = true;

    saveSettings(baseSettings);

    const saved = JSON.parse(readFileSync(join(userDataDir, "orca-settings.json"), "utf-8")) as OrcaSettings;
    expect(saved.providers[0]?.apiKey).toBe("enc:Y2lwaGVyOnNlY3JldC1rZXk=");

    const loaded = loadSettings();
    expect(loaded.providers[0]?.apiKey).toBe("secret-key");
    expect(electronState.encryptString).toHaveBeenCalledWith("secret-key");
    expect(electronState.decryptString).toHaveBeenCalled();
  });

  it("migrates legacy settings files into provider-role settings", () => {
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

    const loaded = loadSettings();

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
});
