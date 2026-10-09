/**
 * Provider settings survive a restart unchanged: stable provider ids, role
 * assignments (including stale ones, which the user resolves), fallbacks and
 * per-role options; API keys are encrypted on disk and never written in clear
 * when the OS keychain is available.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: true,
  encryptString: vi.fn((plaintext: string) => Buffer.from(`cipher:${plaintext}`, "utf-8")),
  decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString("utf-8").replace(/^cipher:/, "")),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => electronState.userDataPath) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => electronState.encryptionAvailable),
    encryptString: electronState.encryptString,
    decryptString: electronState.decryptString,
  },
}));

import type { OrcaSettings } from "./settings";
import { loadSettings, saveSettings } from "./settings";

describe("provider settings persistence", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-settings-")); electronState.userDataPath = dir; electronState.encryptionAvailable = true; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const settings: OrcaSettings = {
    providers: [
      { id: "prov_d833", name: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-secret-key" },
      { id: "prov_ol", name: "Ollama", type: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
    ],
    roles: {
      brain: { providerId: "prov_d833", model: "claude-opus-5-5", temperature: 0.3, maxTokens: 4096 },
      // Stale reference kept on purpose: the user reassigns it, Orca does not.
      strong_model: { providerId: "prov_removed", model: "claude-sonnet-5-5", fallbacks: [{ providerId: "prov_ol", model: "qwen2.5-coder" }] },
      narrator: { providerId: "prov_ol", model: "llama3.2", enableThinking: false },
    },
    budgetUsd: 0.1,
    maxRepairPasses: 2,
    verbose: false,
    workspaceRoot: "",
  };

  it("round-trips provider ids, role assignments, stale references and role options unchanged", async () => {
    await saveSettings(settings);
    const loaded = await loadSettings();
    expect(loaded.providers).toEqual(settings.providers);
    expect(loaded.roles).toEqual(settings.roles);
    expect(loaded.roles.strong_model?.providerId).toBe("prov_removed");
  });

  it("never writes the API key in clear when the keychain is available", async () => {
    await saveSettings(settings);
    const onDisk = readFileSync(join(dir, "orca-settings.json"), "utf-8");
    expect(onDisk).not.toContain("sk-ant-secret-key");
    expect(onDisk).toContain('"apiKey": "enc:');
    expect((await loadSettings()).providers[0]!.apiKey).toBe("sk-ant-secret-key");
  });

  it("keeps a plaintext-prefixed key readable when the keychain is unavailable, and says so", async () => {
    electronState.encryptionAvailable = false;
    await saveSettings(settings);
    const onDisk = readFileSync(join(dir, "orca-settings.json"), "utf-8");
    expect(onDisk).toContain('"apiKey": "plain:sk-ant-secret-key"');
    expect((await loadSettings()).providers[0]!.apiKey).toBe("sk-ant-secret-key");
  });

  it("loads defaults when the file is missing, without inventing providers", async () => {
    const loaded = await loadSettings();
    expect(loaded.providers).toEqual([]);
    expect(loaded.roles).toEqual({});
  });
});
