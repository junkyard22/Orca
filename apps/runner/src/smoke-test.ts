/**
 * smoke-test.ts — Live smoke harness for Orca trust boundary validation.
 *
 * Thin entrypoint — all shared logic lives in smoke-core.ts.
 * Constructs an LLM adapter from env vars, then delegates the full suite to
 * runSmokeForAdapter() and writes a single markdown report.
 *
 * Usage (manual, opt-in only — not part of CI):
 *   pnpm -C apps/runner smoke
 *   ORCA_SMOKE_REPORT=./my-report.md pnpm -C apps/runner smoke
 *
 * Environment variables honoured (same as index.ts):
 *   LLM_PROVIDER         — openrouter | ollama | alibaba | settings (default)
 *   ORCA_SETTINGS_PATH   — path to orca-settings.json (default: repo root)
 *   OPENROUTER_API_KEY   — required when LLM_PROVIDER=openrouter
 *   OLLAMA_BASE_URL / OLLAMA_MODEL
 *   ALIBABA_CLOUD_API_KEY
 *   LLM_MODEL            — override model id
 *   WORKSPACE_ROOT       — workspace for tool calls
 *   ORCA_DB_PATH
 *   ORCA_SMOKE_REPORT    — output path for the markdown report
 *                          (default: smoke-report-<timestamp>.md in CWD)
 */

import "dotenv/config";

import * as path from "path";
import * as fs from "fs";
import { existsSync, readFileSync } from "node:fs";

import {
  OpenRouterAdapter,
  OllamaAdapter,
  OpenAICompatAdapter,
} from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";

import {
  runSmokeForAdapter,
  buildReport,
  SMOKE_PROMPTS,
  TRUST_CHECK_COUNT,
} from "./smoke-core.js";

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers (stderr-only — keeps stdout clean for the report)
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  yellow:  "\x1b[33m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  gray:    "\x1b[90m",
  white:   "\x1b[37m",
};

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

function banner(msg: string, color = C.magenta): void {
  const border = "─".repeat(72);
  log(`\n${color}┌${border}┐${C.reset}`);
  log(`${color}│ ${C.bold}${msg.padEnd(71)}${C.reset}${color}│${C.reset}`);
  log(`${color}└${border}┘${C.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings loader (mirrors index.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface RawDictProvider {
  type?: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
}

interface AdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
}

function loadAdapterFromSettings(): AdapterConfig | null {
  const settingsPath =
    process.env["ORCA_SETTINGS_PATH"]?.trim() ??
    path.join(process.cwd(), "orca-settings.json");

  if (!existsSync(settingsPath)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (
    !raw["providers"] ||
    Array.isArray(raw["providers"]) ||
    typeof raw["providers"] !== "object"
  ) {
    return null;
  }

  const providers = raw["providers"] as Record<string, RawDictProvider>;
  const roles = raw["roles"] as
    | Record<string, { provider?: string; model?: string; label?: string }>
    | undefined;

  let providerName: string | undefined;
  let model: string | undefined;
  let label: string | undefined;

  if (roles) {
    const brainRole = roles["brain"];
    if (brainRole?.provider) {
      providerName = brainRole.provider;
      model = brainRole.model;
      label = brainRole.label;
    } else {
      const first = Object.values(roles)[0];
      if (first?.provider) {
        providerName = first.provider;
        model = first.model;
        label = first.label;
      }
    }
  }
  if (!providerName) return null;

  const prov = providers[providerName];
  if (!prov) return null;

  const type = (prov.type ?? "").toLowerCase().replace(/-/g, "_");
  if (type !== "openai_compatible") return null;

  const apiKey = prov.apiKey?.trim() ?? "";
  const baseUrl = prov.baseURL?.trim() ?? prov.baseUrl?.trim() ?? "";
  if (!baseUrl) return null;

  return {
    baseUrl,
    apiKey,
    model: model ?? process.env["LLM_MODEL"]?.trim() ?? "qwen3.5-plus",
    label: label ?? `${providerName} / ${model}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("ORCA SMOKE TEST — trust boundary validation");
  log(`${C.gray}Date: ${new Date().toISOString()}${C.reset}`);

  // ── Build adapter ──────────────────────────────────────────────────────────
  const provider = process.env["LLM_PROVIDER"]?.trim().toLowerCase();
  let adapter: LLMAdapter;
  let resolvedModel: string;
  let providerLabel: string;

  if (provider === "ollama") {
    resolvedModel = process.env["OLLAMA_MODEL"] ?? "llama3.2";
    providerLabel = `Ollama (${resolvedModel})`;
    adapter = new OllamaAdapter({
      baseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434",
      defaultModel: resolvedModel,
    });
  } else if (provider === "alibaba") {
    const apiKey = process.env["ALIBABA_CLOUD_API_KEY"]?.trim();
    if (!apiKey) {
      log(`${C.red}Error: ALIBABA_CLOUD_API_KEY is not set.${C.reset}`);
      process.exit(1);
    }
    resolvedModel = process.env["LLM_MODEL"]?.trim() ?? "qwen-max";
    providerLabel = `Alibaba DashScope (${resolvedModel})`;
    adapter = new OpenAICompatAdapter({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      defaultModel: resolvedModel,
      enableThinking: false,
    });
  } else {
    const cfg = loadAdapterFromSettings();
    if (cfg) {
      if (!cfg.apiKey) {
        log(`${C.red}Error: provider in orca-settings.json has no apiKey.${C.reset}`);
        process.exit(1);
      }
      resolvedModel = cfg.model;
      providerLabel = cfg.label;
      adapter = new OpenAICompatAdapter({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        defaultModel: cfg.model,
        enableThinking: false,
      });
    } else if (provider === "settings") {
      log(`${C.red}Error: LLM_PROVIDER=settings but no valid dict-style provider found.${C.reset}`);
      process.exit(1);
    } else {
      const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
      if (!apiKey) {
        log(
          `${C.red}Error: No provider configured.\n` +
          `  • Add orca-settings.json with a dict-style provider, or\n` +
          `  • Set OPENROUTER_API_KEY and LLM_PROVIDER=openrouter, or\n` +
          `  • Set LLM_PROVIDER=ollama (no key needed), or\n` +
          `  • Set LLM_PROVIDER=alibaba and ALIBABA_CLOUD_API_KEY${C.reset}`,
        );
        process.exit(1);
      }
      resolvedModel = process.env["LLM_MODEL"]?.trim() ?? "openai/gpt-4o-mini";
      providerLabel = `OpenRouter (${resolvedModel})`;
      adapter = new OpenRouterAdapter({
        apiKey,
        siteUrl: process.env["OPENROUTER_SITE_URL"] ?? "http://localhost",
        appName: "orca-smoke",
      });
    }
  }

  log(`${C.cyan}Provider : ${providerLabel}${C.reset}`);
  log(`${C.cyan}Model    : ${resolvedModel}${C.reset}`);
  log(`${C.cyan}Prompts  : ${SMOKE_PROMPTS.length}${C.reset}`);

  // ── Run suite ──────────────────────────────────────────────────────────────
  const results = await runSmokeForAdapter(adapter, resolvedModel, providerLabel, { log });

  // ── Print summary ──────────────────────────────────────────────────────────
  banner("SMOKE TEST SUMMARY", C.magenta);
  log("");

  const header =
    `${"ID".padEnd(4)}${"Label".padEnd(36)}${"Kind".padEnd(10)}` +
    `${"Checks".padEnd(10)}${"Time".padEnd(10)}Result`;
  log(`${C.bold}${header}${C.reset}`);
  log("─".repeat(header.length + 10));

  let totalPass = 0;
  let totalFail = 0;

  for (const r of results) {
    const passed = r.trustChecks.filter((c) => c.pass).length;
    const row =
      r.prompt.id.padEnd(4) +
      r.prompt.label.slice(0, 34).padEnd(36) +
      r.replyKind.padEnd(10) +
      `${passed}/${TRUST_CHECK_COUNT}`.padEnd(10) +
      `${r.durationMs}ms`.padEnd(10);
    if (r.allPassed) {
      log(`  ${C.green}${row}✅ PASS${C.reset}`);
      totalPass++;
    } else {
      log(`  ${C.red}${row}❌ FAIL${C.reset}`);
      totalFail++;
    }
  }

  log("");
  log(`${C.bold}Total: ${totalPass} passed, ${totalFail} failed out of ${results.length} prompts${C.reset}`);

  // ── Write report ───────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const reportPath =
    process.env["ORCA_SMOKE_REPORT"]?.trim() ??
    path.join(process.cwd(), `smoke-report-${ts}.md`);

  const report = buildReport(results, {
    configName: "manual",
    providerLabel,
    model: resolvedModel,
    date: new Date().toISOString(),
  });

  fs.writeFileSync(reportPath, report, "utf8");
  log("");
  log(`${C.green}Report written to: ${reportPath}${C.reset}`);

  if (totalFail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log(`${C.red}[smoke-test] fatal: ${msg}${C.reset}`);
  process.exit(1);
});




