/**
 * release-smoke.ts — Config-driven multi-provider smoke gate for Orca releases.
 *
 * Wraps smoke-core.ts to run the full smoke suite across a matrix of
 * provider/model configs defined in release-smoke.json (or a custom path),
 * writes per-config reports plus a summary index, and exits nonzero if
 * any config fails.
 *
 * Usage (manual/opt-in — not part of normal CI):
 *
 *   # Run all configs in release-smoke.json:
 *   pnpm -C apps/runner release-smoke
 *
 *   # Run a single named config:
 *   pnpm -C apps/runner release-smoke --config brain-default
 *
 *   # Use a custom matrix file:
 *   ORCA_RELEASE_SMOKE_CONFIG=./my-matrix.json pnpm -C apps/runner release-smoke
 *
 *   # Override output directory:
 *   ORCA_SMOKE_OUTPUT_DIR=./ci-smoke-reports pnpm -C apps/runner release-smoke
 *
 * Config file format (release-smoke.json):
 *   {
 *     "outputDir": "smoke-reports",         // default output location
 *     "configs": [
 *       {
 *         "name": "brain-default",          // slug used for folder/file names
 *         "label": "Brain (default)",       // human label in reports
 *         "source": "orca-settings",        // "orca-settings" | "env"
 *         "role": "brain"                   // for source=orca-settings
 *       },
 *       {
 *         "name": "openrouter-gpt4o-mini",
 *         "label": "OpenRouter GPT-4o-mini",
 *         "source": "env",                  // read adapter from env vars
 *         "provider": "openrouter",         // openrouter | ollama | alibaba
 *         "model": "openai/gpt-4o-mini"
 *       }
 *     ]
 *   }
 */

import "dotenv/config";

import * as path from "path";
import * as fs from "fs";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

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
import type { SmokeResult } from "./smoke-core.js";

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  yellow:  "\x1b[33m",
  gray:    "\x1b[90m",
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
// Config types
// ─────────────────────────────────────────────────────────────────────────────

type SmokeConfigSource = "orca-settings" | "env";

interface SmokeConfigEntry {
  name: string;
  label: string;
  source: SmokeConfigSource;
  /** For source=orca-settings: which role to look up (e.g. "brain", "strong_model") */
  role?: string;
  /** For source=env: which provider type ("openrouter" | "ollama" | "alibaba") */
  provider?: string;
  /** For source=env: model id override */
  model?: string;
}

interface ReleaseSmokeConfig {
  outputDir?: string;
  configs: SmokeConfigEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings loader (mirrors index.ts — resolves a named role from orca-settings.json)
// ─────────────────────────────────────────────────────────────────────────────

interface RawDictProvider {
  type?: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
}

interface ResolvedAdapter {
  adapter: LLMAdapter;
  model: string;
  label: string;
}

function loadRoleFromSettings(
  roleName: string,
  settingsPath: string,
): ResolvedAdapter | null {
  if (!existsSync(settingsPath)) {
    log(`${C.yellow}⚠  orca-settings.json not found at ${settingsPath}${C.reset}`);
    return null;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    log(`${C.red}✗  Failed to parse ${settingsPath}: ${e}${C.reset}`);
    return null;
  }

  if (!raw["providers"] || typeof raw["providers"] !== "object" || Array.isArray(raw["providers"])) {
    log(`${C.yellow}⚠  orca-settings.json has no dict-style providers object${C.reset}`);
    return null;
  }

  const providers = raw["providers"] as Record<string, RawDictProvider>;
  const roles = raw["roles"] as
    | Record<string, { provider?: string; model?: string; label?: string }>
    | undefined;

  if (!roles) {
    log(`${C.yellow}⚠  orca-settings.json has no roles${C.reset}`);
    return null;
  }

  const roleEntry = roles[roleName];
  if (!roleEntry?.provider) {
    log(`${C.yellow}⚠  Role "${roleName}" not found in orca-settings.json${C.reset}`);
    return null;
  }

  const prov = providers[roleEntry.provider];
  if (!prov) {
    log(`${C.yellow}⚠  Provider "${roleEntry.provider}" for role "${roleName}" not found${C.reset}`);
    return null;
  }

  const type = (prov.type ?? "").toLowerCase().replace(/-/g, "_");
  if (type !== "openai_compatible") {
    log(`${C.yellow}⚠  Provider "${roleEntry.provider}" type "${prov.type}" is not openai-compatible${C.reset}`);
    return null;
  }

  const apiKey = prov.apiKey?.trim() ?? "";
  const baseUrl = prov.baseURL?.trim() ?? prov.baseUrl?.trim() ?? "";

  if (!baseUrl) {
    log(`${C.red}✗  Provider "${roleEntry.provider}" has no baseURL${C.reset}`);
    return null;
  }

  const model = roleEntry.model ?? "qwen3.5-plus";
  const label = roleEntry.label ?? `${roleEntry.provider} / ${model}`;

  return {
    adapter: new OpenAICompatAdapter({
      baseUrl,
      apiKey,
      defaultModel: model,
      enableThinking: false,
    }),
    model,
    label,
  };
}

function buildEnvAdapter(entry: SmokeConfigEntry): ResolvedAdapter | null {
  const provider = (entry.provider ?? "").toLowerCase();

  if (provider === "ollama") {
    const model = entry.model ?? process.env["OLLAMA_MODEL"] ?? "llama3.2";
    return {
      adapter: new OllamaAdapter({
        baseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434",
        defaultModel: model,
      }),
      model,
      label: `Ollama (${model})`,
    };
  }

  if (provider === "alibaba") {
    const apiKey = process.env["ALIBABA_CLOUD_API_KEY"]?.trim();
    if (!apiKey) {
      log(`${C.red}✗  ALIBABA_CLOUD_API_KEY not set (required for config "${entry.name}")${C.reset}`);
      return null;
    }
    const model = entry.model ?? process.env["LLM_MODEL"]?.trim() ?? "qwen-max";
    return {
      adapter: new OpenAICompatAdapter({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey,
        defaultModel: model,
        enableThinking: false,
      }),
      model,
      label: `Alibaba DashScope (${model})`,
    };
  }

  // Default: openrouter
  const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!apiKey) {
    log(`${C.red}✗  OPENROUTER_API_KEY not set (required for config "${entry.name}")${C.reset}`);
    return null;
  }
  const model = entry.model ?? process.env["LLM_MODEL"]?.trim() ?? "openai/gpt-4o-mini";
  return {
    adapter: new OpenRouterAdapter({
      apiKey,
      siteUrl: process.env["OPENROUTER_SITE_URL"] ?? "http://localhost",
      appName: "orca-release-smoke",
    }),
    model,
    label: `OpenRouter (${model})`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary index writer
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigRunOutcome {
  entry: SmokeConfigEntry;
  providerLabel: string;
  model: string;
  allPassed: boolean;
  promptsPassed: number;
  promptsFailed: number;
  totalChecks: number;
  passedChecks: number;
  durationMs: number;
  reportPath: string;
  error?: string;
}

function buildIndexReport(
  outcomes: ConfigRunOutcome[],
  runDate: string,
): string {
  const allPassed = outcomes.every((o) => o.allPassed);
  const lines: string[] = [];

  lines.push("# Orca Release Smoke Gate — Index");
  lines.push("");
  lines.push(`**Date:** ${runDate}  `);
  lines.push(`**Overall result:** ${allPassed ? "✅ ALL CONFIGS PASSED" : "❌ SOME CONFIGS FAILED"}  `);
  lines.push(`**Configs run:** ${outcomes.length}  `);
  lines.push(`**Prompts per config:** ${SMOKE_PROMPTS.length}  `);
  lines.push(`**Trust checks per prompt:** ${TRUST_CHECK_COUNT}  `);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Config Results");
  lines.push("");
  lines.push(
    "| Config | Label | Provider / Model | Prompts | Checks | Duration | Result | Report |",
  );
  lines.push(
    "|--------|-------|------------------|---------|--------|----------|--------|--------|",
  );

  for (const o of outcomes) {
    const result = o.allPassed ? "✅ PASS" : "❌ FAIL";
    const checks = o.error
      ? "error"
      : `${o.passedChecks}/${o.totalChecks}`;
    const prompts = o.error
      ? "error"
      : `${o.promptsPassed}/${SMOKE_PROMPTS.length}`;
    const reportLink = `[report](${path.relative(process.cwd(), o.reportPath)})`;
    lines.push(
      `| \`${o.entry.name}\` | ${o.entry.label} | ${o.providerLabel} |` +
      ` ${prompts} | ${checks} | ${o.durationMs}ms | ${result} | ${reportLink} |`,
    );
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  if (!allPassed) {
    lines.push("## Failures");
    lines.push("");
    for (const o of outcomes.filter((x) => !x.allPassed)) {
      lines.push(`### \`${o.entry.name}\``);
      lines.push("");
      if (o.error) {
        lines.push(`**Fatal error:** \`${o.error}\``);
      } else {
        lines.push(`**Provider:** ${o.providerLabel}  `);
        lines.push(`**Model:** \`${o.model}\`  `);
        lines.push(`**Prompts failed:** ${o.promptsFailed}/${SMOKE_PROMPTS.length}  `);
        lines.push(`**See:** [full report](${path.relative(process.cwd(), o.reportPath)})`);
      }
      lines.push("");
    }
  }

  lines.push("## How to use before a release");
  lines.push("");
  lines.push("1. Run `pnpm -C apps/runner release-smoke` from the repo root.");
  lines.push("2. Open this index file and check the Overall result line.");
  lines.push("3. For any ❌ FAIL, open the linked report for that config to see which prompts failed and why.");
  lines.push("4. Fix failing trust properties in the presenter, Benson, or system prompt before shipping.");
  lines.push("5. Re-run the gate and confirm ✅ ALL CONFIGS PASSED.");
  lines.push("6. Commit this index and the per-config reports as a release artifact if desired.");
  lines.push("");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("ORCA RELEASE SMOKE GATE");
  const runDate = new Date().toISOString();
  log(`${C.gray}Date: ${runDate}${C.reset}`);

  // ── Load matrix config ─────────────────────────────────────────────────────
  const configFilePath =
    process.env["ORCA_RELEASE_SMOKE_CONFIG"]?.trim() ??
    path.join(process.cwd(), "release-smoke.json");

  if (!existsSync(configFilePath)) {
    log(`${C.red}Error: Matrix config not found at ${configFilePath}${C.reset}`);
    log(`${C.dim}Create a release-smoke.json in the repo root (see apps/runner/src/release-smoke.ts for format)${C.reset}`);
    process.exit(1);
  }

  let matrixConfig: ReleaseSmokeConfig;
  try {
    matrixConfig = JSON.parse(readFileSync(configFilePath, "utf8")) as ReleaseSmokeConfig;
  } catch (e) {
    log(`${C.red}Error: Failed to parse ${configFilePath}: ${e}${C.reset}`);
    process.exit(1);
  }

  if (!Array.isArray(matrixConfig.configs) || matrixConfig.configs.length === 0) {
    log(`${C.red}Error: No configs found in ${configFilePath}${C.reset}`);
    process.exit(1);
  }

  // ── Filter to single config if --config <name> passed ─────────────────────
  const singleConfigArg = (() => {
    const idx = process.argv.indexOf("--config");
    return idx !== -1 ? process.argv[idx + 1] : undefined;
  })();

  let configsToRun = matrixConfig.configs.filter(
    // Skip entries that look like _comment* - they are documentation keys
    (c) => !c.name?.startsWith?.("_"),
  );

  if (singleConfigArg) {
    configsToRun = configsToRun.filter((c) => c.name === singleConfigArg);
    if (configsToRun.length === 0) {
      log(
        `${C.red}Error: No config named "${singleConfigArg}" found in ${configFilePath}.\n` +
        `Available: ${matrixConfig.configs.map((c) => c.name).join(", ")}${C.reset}`,
      );
      process.exit(1);
    }
  }

  // ── Resolve output directory ───────────────────────────────────────────────
  const outputDir =
    process.env["ORCA_SMOKE_OUTPUT_DIR"]?.trim() ??
    path.join(process.cwd(), matrixConfig.outputDir ?? "smoke-reports");

  // Stamp the run so reports from multiple runs don't overwrite each other
  const runTs = runDate.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = path.join(outputDir, runTs);
  mkdirSync(runDir, { recursive: true });

  const settingsPath =
    process.env["ORCA_SETTINGS_PATH"]?.trim() ??
    path.join(process.cwd(), "orca-settings.json");

  log(`${C.cyan}Matrix config  : ${configFilePath}${C.reset}`);
  log(`${C.cyan}Configs to run : ${configsToRun.length}${C.reset}`);
  log(`${C.cyan}Output dir     : ${runDir}${C.reset}`);
  log(`${C.cyan}Prompts/config : ${SMOKE_PROMPTS.length}${C.reset}`);

  // ── Run each config ────────────────────────────────────────────────────────
  const outcomes: ConfigRunOutcome[] = [];

  for (const entry of configsToRun) {
    banner(`Config: ${entry.name} — ${entry.label}`, C.cyan);

    // Resolve adapter
    let resolved: ResolvedAdapter | null = null;

    if (entry.source === "orca-settings") {
      const role = entry.role ?? "brain";
      log(`  Loading role "${role}" from ${settingsPath}…`);
      resolved = loadRoleFromSettings(role, settingsPath);
    } else if (entry.source === "env") {
      log(`  Building adapter from env vars (provider: ${entry.provider ?? "openrouter"})…`);
      resolved = buildEnvAdapter(entry);
    } else {
      log(`${C.red}  ✗ Unknown source "${(entry as { source: string }).source}" for config "${entry.name}"${C.reset}`);
    }

    if (!resolved) {
      log(`${C.red}  ✗ Could not build adapter for "${entry.name}" — skipping${C.reset}`);
      const reportPath = path.join(runDir, `${entry.name}.md`);
      const errorMsg = `Could not build adapter for config "${entry.name}" (source=${entry.source}).`;
      fs.writeFileSync(reportPath, `# Smoke Report: ${entry.name}\n\n**Error:** ${errorMsg}\n`, "utf8");

      outcomes.push({
        entry,
        providerLabel: "N/A",
        model: "N/A",
        allPassed: false,
        promptsPassed: 0,
        promptsFailed: SMOKE_PROMPTS.length,
        totalChecks: 0,
        passedChecks: 0,
        durationMs: 0,
        reportPath,
        error: errorMsg,
      });
      continue;
    }

    log(`  ${C.cyan}Provider: ${resolved.label}${C.reset}`);
    log(`  ${C.cyan}Model   : ${resolved.model}${C.reset}`);

    const t0 = Date.now();
    let results: SmokeResult[] = [];
    let fatalError: string | undefined;

    try {
      results = await runSmokeForAdapter(
        resolved.adapter,
        resolved.model,
        resolved.label,
        { log },
      );
    } catch (err: unknown) {
      fatalError = err instanceof Error ? err.message : String(err);
      log(`${C.red}  ✗ Fatal error: ${fatalError}${C.reset}`);
    }

    const durationMs = Date.now() - t0;
    const allPassed = fatalError === undefined && results.every((r) => r.allPassed);
    const promptsPassed = results.filter((r) => r.allPassed).length;
    const promptsFailed = SMOKE_PROMPTS.length - promptsPassed;
    const totalChecks = results.reduce((n, r) => n + r.trustChecks.length, 0);
    const passedChecks = results.reduce(
      (n, r) => n + r.trustChecks.filter((c) => c.pass).length,
      0,
    );

    // Write per-config report
    const reportPath = path.join(runDir, `${entry.name}.md`);
    if (fatalError) {
      fs.writeFileSync(
        reportPath,
        `# Smoke Report: ${entry.name}\n\n**Fatal error during run:** \`${fatalError}\`\n`,
        "utf8",
      );
    } else {
      const report = buildReport(results, {
        configName: entry.name,
        providerLabel: resolved.label,
        model: resolved.model,
        date: runDate,
      });
      fs.writeFileSync(reportPath, report, "utf8");
    }

    const resultLabel = allPassed
      ? `${C.green}✅ PASS${C.reset}`
      : `${C.red}❌ FAIL${C.reset}`;
    log(`  ${resultLabel}  ${durationMs}ms  ${promptsPassed}/${SMOKE_PROMPTS.length} prompts  ${passedChecks}/${totalChecks} checks`);
    log(`  ${C.dim}→ ${reportPath}${C.reset}`);

    outcomes.push({
      entry,
      providerLabel: resolved.label,
      model: resolved.model,
      allPassed,
      promptsPassed,
      promptsFailed,
      totalChecks,
      passedChecks,
      durationMs,
      reportPath,
      error: fatalError,
    });
  }

  // ── Print summary ──────────────────────────────────────────────────────────
  banner("RELEASE SMOKE GATE SUMMARY", C.magenta);
  log("");

  let overallPass = true;
  for (const o of outcomes) {
    const icon = o.allPassed ? `${C.green}✅` : `${C.red}❌`;
    const checks = o.error ? "error" : `${o.passedChecks}/${o.totalChecks} checks`;
    const prompts = o.error ? "error" : `${o.promptsPassed}/${SMOKE_PROMPTS.length} prompts`;
    log(`  ${icon} ${C.bold}${o.entry.name}${C.reset}  ${C.dim}${o.entry.label}${C.reset}  ${prompts}  ${checks}  ${o.durationMs}ms${C.reset}`);
    if (!o.allPassed) overallPass = false;
  }

  log("");
  log(
    overallPass
      ? `${C.green}${C.bold}✅ ALL CONFIGS PASSED${C.reset}`
      : `${C.red}${C.bold}❌ SOME CONFIGS FAILED${C.reset}`,
  );

  // ── Write index report ─────────────────────────────────────────────────────
  const indexPath = path.join(runDir, "index.md");
  const indexContent = buildIndexReport(outcomes, runDate);
  fs.writeFileSync(indexPath, indexContent, "utf8");
  log("");
  log(`${C.cyan}Index report: ${indexPath}${C.reset}`);
  log(`${C.dim}Per-config reports in: ${runDir}${C.reset}`);

  if (!overallPass) process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${C.red}[release-smoke] fatal: ${msg}${C.reset}\n`);
  process.exit(1);
});
