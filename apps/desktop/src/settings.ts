import { app } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── Provider Types ──────────────────────────────────────────────────────────

export type ProviderType =
  | 'openrouter'
  | 'ollama'
  | 'deepseek'
  | 'siliconflow'
  | 'openai'
  | 'anthropic'
  | 'zai'
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
  /** Bearer API key (empty for local Ollama) */
  apiKey: string;
}

export interface RoleEntry {
  /** References ProviderEntry.id */
  providerId: string;
  /** Model name/ID as the provider expects, e.g. "llama3.2" or "anthropic/claude-3.5-sonnet" */
  model: string;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface OrcaSettings {
  providers:       ProviderEntry[];
  /** Keyed by role name: brain, coder_strong, coder_cheap, utility, reviewer,
   *  narrator, planner_deep, debugger, reader, vision */
  roles:           Partial<Record<string, RoleEntry>>;
  budgetUsd:       number;
  maxRepairPasses: number;
  verbose:         boolean;
}

const DEFAULTS: OrcaSettings = {
  providers:       [],
  roles:           {},
  budgetUsd:       0.10,
  maxRepairPasses: 2,
  verbose:         false,
};

function settingsPath(): string {
  return join(app.getPath("userData"), "orca-settings.json");
}

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

  return { ...DEFAULTS, ...stored };
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

  return {
    providers,
    roles,
    budgetUsd:       (raw["budgetUsd"]      as number)  ?? 0.10,
    maxRepairPasses: (raw["maxRepairPasses"] as number)  ?? 2,
    verbose:         (raw["verbose"]         as boolean) ?? false,
  };
}

export function saveSettings(s: OrcaSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), "utf-8");
}
