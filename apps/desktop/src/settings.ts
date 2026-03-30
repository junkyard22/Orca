import { app, safeStorage } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { McpServerConfig } from "@clawde/tool-bootstrap";

export type { McpServerConfig };

// ── Provider Types ──────────────────────────────────────────────────────────

export type ProviderType =
  | 'openrouter'
  | 'ollama'
  | 'deepseek'
  | 'siliconflow'
  | 'openai'
  | 'anthropic'
  | 'zai'
  | 'alibaba'
  | 'custom';

/**
 * Default base URLs for each provider type (without /chat/completions).
 * OllamaAdapter appends /v1/chat/completions.
 * OpenAICompatAdapter appends /chat/completions.
 */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  openrouter:  "https://openrouter.ai/api/v1",
  ollama:      "http://localhost:11434",
  deepseek:    "https://api.deepseek.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openai:      "https://api.openai.com/v1",
  anthropic:   "https://api.anthropic.com/v1",
  zai:         "https://api.z.ai/v1",
  alibaba:     "https://dashscope.aliyuncs.com/compatible-mode/v1",
  custom:      "",
};

// ── Provider & Role Config ──────────────────────────────────────────────────

export interface ProviderEntry {
  /** Stable unique ID, e.g. "prov_a1b2" */
  id: string;
  /** Display name shown in role dropdowns */
  name: string;
  /** Provider type */
  type: ProviderType;
  /** Base API URL (without /chat/completions) */
  baseUrl: string;
  /** Bearer API key (empty for local Ollama). Stored encrypted in file. */
  apiKey: string;
}

export interface RoleEntry {
  /** References ProviderEntry.id */
  providerId: string;
  /** Model name/ID as the provider expects, e.g. "llama3.2" or "anthropic/claude-3.5-sonnet" */
  model: string;
  /**
   * Ordered fallback models tried when the primary fails.
   * Miranda attempts primary first, then each fallback in order.
   */
  fallbacks?: Array<{ providerId: string; model: string }>;
  /**
   * Controls the provider's `enable_thinking` parameter.
   * Set to `false` to suppress deep thinking on models like qwen3.5-plus.
   * Set to `true` to force it on. Omit to use the provider's default.
   */
  enableThinking?: boolean;
  /** Max tokens for completions on this role. Default: 8192. */
  maxTokens?: number;
  /** Sampling temperature for this role (0–2). Default: 0.7. */
  temperature?: number;
  /**
   * Whitelist of tool names available to this role.
   * Omit to allow all tools. Applies on top of any per-task toolNamesAllowed.
   */
  toolsAllowed?: string[];
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface OrcaSettings {
  providers:       ProviderEntry[];
  /** Keyed by role name: brain, strong_model, cheap_model, utility, reviewer,
   *  narrator, planner_deep, debugger, reader, vision */
  roles:           Partial<Record<string, RoleEntry>>;
  budgetUsd:       number;
  maxRepairPasses: number;
  verbose:         boolean;
  /** Absolute path to the workspace root used for tool execution */
  workspaceRoot:   string;
  /**
   * MCP server definitions. Each entry spawns one child process via stdio.
   * Disabled or missing entries are skipped automatically.
   */
  mcpServers?:     McpServerConfig[];
}

const DEFAULTS: OrcaSettings = {
  providers:       [],
  roles:           {},
  budgetUsd:       0.10,
  maxRepairPasses: 2,
  verbose:         false,
  workspaceRoot:   "",
};

function settingsPath(): string {
  return join(app.getPath("userData"), "orca-settings.json");
}

// ── API Key Encryption ──────────────────────────────────────────────────────

/**
 * Encrypt an API key using Electron's safeStorage (uses OS keychain).
 * Falls back to base64 encoding if encryption is unavailable (e.g., Linux without secret service).
 */
function encryptApiKey(plaintext: string): string {
  if (!plaintext) return "";
  
  // safeStorage.isEncryptionAvailable() may be false on Linux without a keyring
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: base64 encode with a prefix marker
    return "b64:" + Buffer.from(plaintext, "utf-8").toString("base64");
  }
  
  const encrypted = safeStorage.encryptString(plaintext);
  return "enc:" + encrypted.toString("base64");
}

/**
 * Decrypt an API key that was encrypted with encryptApiKey.
 * Returns the plaintext key, or empty string if decryption fails.
 */
function decryptApiKey(stored: string): string {
  if (!stored) return "";
  
  // Handle unencrypted legacy keys (plain text)
  if (!stored.startsWith("enc:") && !stored.startsWith("b64:")) {
    return stored;  // Legacy plain text
  }
  
  // Handle base64 fallback
  if (stored.startsWith("b64:")) {
    try {
      return Buffer.from(stored.slice(4), "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  
  // Handle encrypted keys
  if (stored.startsWith("enc:")) {
    try {
      const buffer = Buffer.from(stored.slice(4), "base64");
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn("[Settings] Cannot decrypt API key: encryption unavailable");
        return "";
      }
      return safeStorage.decryptString(buffer);
    } catch (err) {
      console.error("[Settings] Failed to decrypt API key:", err);
      return "";
    }
  }
  
  return stored;
}

/**
 * Encrypt all API keys in the settings before saving to disk.
 */
function encryptSettings(settings: OrcaSettings): OrcaSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({
      ...p,
      apiKey: encryptApiKey(p.apiKey),
    })),
  };
}

/**
 * Decrypt all API keys in the settings after loading from disk.
 */
function decryptSettings(settings: OrcaSettings): OrcaSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({
      ...p,
      apiKey: decryptApiKey(p.apiKey),
    })),
  };
}

// ── Load / Save ─────────────────────────────────────────────────────────────

export function loadSettings(): OrcaSettings {
  let stored: Partial<OrcaSettings> = {};
  const path = settingsPath();
  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, "utf-8"));
    } catch { /* ignore corrupt file */ }
  }

  // Migration: old format had flat provider + apiKey + ollamaBaseUrl etc.
  const raw = stored as Record<string, unknown>;
  if (!stored.providers && (raw["apiKey"] || raw["ollamaBaseUrl"] || raw["provider"])) {
    return { ...DEFAULTS, ...migrateFromLegacy(raw) };
  }

  // Decrypt API keys after loading
  const decrypted = decryptSettings({ ...DEFAULTS, ...stored });
  return decrypted;
}

function migrateFromLegacy(raw: Record<string, unknown>): Partial<OrcaSettings> {
  const providers: ProviderEntry[] = [];
  const roles: Partial<Record<string, RoleEntry>> = {};
  const providerType = (raw["provider"] as string) ?? "openrouter";

  if (providerType === "ollama") {
    const id = "ollama_migrated";
    providers.push({
      id,
      name:    "Ollama",
      type:    "ollama",
      baseUrl: (raw["ollamaBaseUrl"] as string) ?? "http://localhost:11434",
      apiKey:  "",
    });
    roles["brain"] = {
      providerId: id,
      model: (raw["ollamaModel"] as string) ?? "llama3.2",
    };
  } else {
    const id = "openrouter_migrated";
    providers.push({
      id,
      name:    "OpenRouter",
      type:    "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey:  (raw["apiKey"] as string) ?? "",
    });
    roles["brain"] = { providerId: id, model: "anthropic/claude-3.5-sonnet" };
  }

  // Decrypt after migration
  return decryptSettings({
    providers,
    roles,
    budgetUsd:       (raw["budgetUsd"]      as number)  ?? 0.10,
    maxRepairPasses: (raw["maxRepairPasses"] as number)  ?? 2,
    verbose:         (raw["verbose"]         as boolean) ?? false,
    workspaceRoot:   "",
  });
}

export function saveSettings(s: OrcaSettings): void {
  // Encrypt API keys before saving to disk
  const encrypted = encryptSettings(s);
  writeFileSync(settingsPath(), JSON.stringify(encrypted, null, 2), "utf-8");
}
