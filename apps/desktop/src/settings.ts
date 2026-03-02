import { app } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface OrcaSettings {
  apiKey:          string;
  budgetUsd:       number;
  maxRepairPasses: number;
  siteUrl:         string;
  appName:         string;
  verbose:         boolean;
}

const DEFAULTS: OrcaSettings = {
  apiKey:          "",
  budgetUsd:       0.10,
  maxRepairPasses: 2,
  siteUrl:         "http://localhost",
  appName:         "orca-desktop",
  verbose:         false,
};

function settingsPath(): string {
  return join(app.getPath("userData"), "orca-settings.json");
}

export function loadSettings(): OrcaSettings {
  let stored: Partial<OrcaSettings> = {};
  const path = settingsPath();
  if (existsSync(path)) {
    try { stored = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
  }
  return {
    ...DEFAULTS,
    ...stored,
    // env var is fallback when no key has been saved yet
    apiKey: stored.apiKey || process.env["OPENROUTER_API_KEY"]?.trim() || "",
  };
}

export function saveSettings(s: OrcaSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), "utf-8");
}
