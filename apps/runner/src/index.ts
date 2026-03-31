/**
 * apps/runner — minimal Orca pod CLI runner.
 *
 * Wiring:
 *   OpenRouterAdapter → createDirectLLMService → OrcaLLMService
 *   createMirandaGate()                          → MirandaGate (compliance only, no LLM calls)
 *   createPappyPort()                            → PappyPort
 *   createMaestroAdapter()                       → MaestroPort
 *   createOrcaRuntime({ maestro, pappy, llm, gate }) → OrcaRuntime
 *   createBenson({ executeTask })                → Benson
 *
 * Usage:
 *   pnpm -C apps/runner dev "Create a README for Orca"
 *   echo "Your prompt" | pnpm -C apps/runner dev
 *
 * Requires apps/runner/.env  (copy from .env.example and fill in the key).
 */

import "dotenv/config";

import * as os from "os";
import * as path from "path";
import { OpenRouterAdapter, OllamaAdapter, OpenAICompatAdapter, createMirandaGate } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
  getWorkspaceContext,
  SqliteStore,
  exportTrainingData,
  createRunAnalysisWriter,
} from "@clawde/orca-core";
import type { OrcaRuntime, OrcaEvent, OrcaEventType, ExportOptions, OrcaTaskSpec, OrcaExecutionResult } from "@clawde/orca-core";
import { createBenson } from "@clawde/benson-core";
import type { TaskSpec, ExecutionResult } from "@clawde/benson-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
import type { Tool } from "@yakstacks/workbench-core";
import { createExtensionRegistry } from "@clawde/orca-core";
import { buildToolBootstrap } from "@clawde/tool-bootstrap";
import type { McpServerConfig } from "@clawde/tool-bootstrap";

import { createMaestroAdapter } from "./adapters/maestroAdapter.js";
import { createToolService } from "./adapters/toolService.js";

// ---------------------------------------------------------------------------
// MCP config loader
//
// Two ways to supply MCP server definitions to the runner:
//   1. ORCA_MCP_CONFIG env var — JSON array of McpServerConfig objects
//   2. ORCA_SETTINGS_PATH env var — path to an orca-settings.json file
//      (the runner reads only the mcpServers field from it)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Settings-file provider loader
//
// When orca-settings.json uses the dict-style providers format:
//   { "providers": { "name": { "type": "openai-compatible", "apiKey": "...", "baseURL": "..." } },
//     "roles": { "brain": { "provider": "name", "model": "..." } } }
//
// The runner constructs an OpenAICompatAdapter from the brain role's provider.
// Triggered automatically when LLM_PROVIDER is unset or set to "settings".
// ---------------------------------------------------------------------------

interface RawDictProvider {
  type?: string;
  apiKey?: string;
  baseURL?: string;
  baseUrl?: string;
}

function loadAdapterFromSettings(): { baseUrl: string; apiKey: string; model: string } | null {
  const settingsPath = process.env["ORCA_SETTINGS_PATH"]?.trim()
    ?? path.join(process.cwd(), "orca-settings.json");
  if (!existsSync(settingsPath)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Only applies to dict-style (non-array) providers object
  if (!raw["providers"] || Array.isArray(raw["providers"]) || typeof raw["providers"] !== "object") {
    return null;
  }

  const providers = raw["providers"] as Record<string, RawDictProvider>;
  const roles = raw["roles"] as Record<string, { provider?: string; model?: string }> | undefined;

  // Resolve provider name from brain role, then first role
  let providerName: string | undefined;
  let model: string | undefined;
  if (roles) {
    const brainRole = roles["brain"];
    if (brainRole?.provider) {
      providerName = brainRole.provider;
      model = brainRole.model;
    } else {
      const first = Object.values(roles)[0];
      if (first?.provider) { providerName = first.provider; model = first.model; }
    }
  }
  if (!providerName) return null;

  const prov = providers[providerName];
  if (!prov) return null;

  const type = (prov.type ?? "").toLowerCase().replace(/-/g, "_");
  if (type !== "openai_compatible") return null;

  const apiKey = prov.apiKey?.trim() ?? "";
  const baseUrl = prov.baseURL?.trim() ?? prov.baseUrl?.trim() ?? "";

  if (!baseUrl) {
    console.error(`[runner] Provider "${providerName}" in orca-settings.json has no baseURL.`);
    return null;
  }

  return { baseUrl, apiKey, model: model ?? process.env["LLM_MODEL"]?.trim() ?? "qwen3.5-plus" };
}

function loadMcpConfig(): McpServerConfig[] {
  // Option 1: inline JSON in env var
  const rawJson = process.env["ORCA_MCP_CONFIG"]?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) return parsed as McpServerConfig[];
    } catch (err) {
      console.error(`[runner] ORCA_MCP_CONFIG is not valid JSON: ${err}`);
    }
  }

  // Option 2: settings file
  const settingsPath = process.env["ORCA_SETTINGS_PATH"]?.trim();
  if (settingsPath && existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { mcpServers?: unknown };
      if (Array.isArray(settings.mcpServers)) return settings.mcpServers as McpServerConfig[];
    } catch (err) {
      console.error(`[runner] Failed to load settings from ${settingsPath}: ${err}`);
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Type-narrowing helper
//
// runtime.on() gives handlers OrcaEvent (the full discriminated union).
// This wrapper narrows to the exact event shape so callers stay type-safe
// without polluting call-sites with "as" casts.
// ---------------------------------------------------------------------------

type EventOfType<T extends OrcaEventType> = Extract<OrcaEvent, { type: T }>;

function listenFor<T extends OrcaEventType>(
  runtime: OrcaRuntime,
  type: T,
  handler: (e: EventOfType<T>) => void,
): void {
  runtime.on(type, (e) => {
    if (e.type === type) handler(e as EventOfType<T>);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Read user prompt from argv or stdin
  const userText = await readPrompt();

  // 2. Build LLM adapter — set LLM_PROVIDER in .env to choose a provider:
  //      openrouter (default), ollama, alibaba, settings
  //
  //   "settings" (or unset + orca-settings.json with dict-style providers):
  //      reads provider config from orca-settings.json, supports type: "openai-compatible"
  //      with any baseURL and apiKey — including Alibaba Coding Plan (sk-sp-...) keys.
  const provider = process.env["LLM_PROVIDER"]?.trim().toLowerCase();

  let adapter;
  let settingsModelId: string | undefined;

  if (provider === "ollama") {
    adapter = new OllamaAdapter({
      baseUrl:      process.env["OLLAMA_BASE_URL"]  ?? "http://localhost:11434",
      defaultModel: process.env["OLLAMA_MODEL"]     ?? "llama3.2",
    });
  } else if (provider === "alibaba") {
    const apiKey = process.env["ALIBABA_CLOUD_API_KEY"]?.trim();
    if (!apiKey) {
      console.error(
        "Error: ALIBABA_CLOUD_API_KEY is not set.\n" +
          "  → Get your key at https://dashscope.console.aliyun.com/apiKey\n" +
          "  → Or set LLM_PROVIDER=openrouter and use OPENROUTER_API_KEY instead.",
      );
      process.exit(1);
    }
    adapter = new OpenAICompatAdapter({
      baseUrl:      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      defaultModel: process.env["LLM_MODEL"]?.trim() ?? "qwen-max",
      // Qwen3 models on DashScope default to deep thinking; suppress it unless
      // the caller explicitly sets ALIBABA_ENABLE_THINKING=true.
      enableThinking: process.env["ALIBABA_ENABLE_THINKING"] === "true" ? true
        : process.env["ALIBABA_ENABLE_THINKING"] === "false" ? false
        : false,
    });
  } else if (provider === "settings" || !provider) {
    // Try orca-settings.json dict-style providers (e.g. alibaba_coding_plan with sk-sp- key).
    // Falls through to OpenRouter if the file is absent or uses the array/desktop format.
    const cfg = loadAdapterFromSettings();
    if (cfg) {
      if (!cfg.apiKey) {
        console.error(
          `Error: provider in orca-settings.json has no apiKey.\n` +
            `  → Add "apiKey": "sk-sp-..." to the provider entry in orca-settings.json.`,
        );
        process.exit(1);
      }
      settingsModelId = cfg.model;
      adapter = new OpenAICompatAdapter({
        baseUrl:        cfg.baseUrl,
        apiKey:         cfg.apiKey,
        defaultModel:   cfg.model,
        enableThinking: false,
      });
    } else if (provider === "settings") {
      console.error(
        "Error: LLM_PROVIDER=settings but no valid dict-style provider found in orca-settings.json.\n" +
          `  → Expected format: { "providers": { "name": { "type": "openai-compatible", "apiKey": "...", "baseURL": "..." } }, "roles": { ... } }`,
      );
      process.exit(1);
    }
  }

  if (!adapter) {
    const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
    if (!apiKey) {
      console.error(
        "Error: OPENROUTER_API_KEY is not set.\n" +
          "  → Copy apps/runner/.env.example → apps/runner/.env and add your key.\n" +
          "  → Get a free key at https://openrouter.ai/keys\n" +
          "  → Or set LLM_PROVIDER=ollama to use a local Ollama model instead.\n" +
          "  → Or set LLM_PROVIDER=alibaba and ALIBABA_CLOUD_API_KEY to use Qwen via DashScope.\n" +
          "  → Or create orca-settings.json with type: openai-compatible provider config.",
      );
      process.exit(1);
    }
    adapter = new OpenRouterAdapter({
      apiKey,
      siteUrl: process.env["OPENROUTER_SITE_URL"] ?? "http://localhost",
      appName: process.env["OPENROUTER_APP_NAME"] ?? "orca-runner",
    });
  }

  // 3. Wire the pod ──────────────────────────────────────────────────────────

  // Miranda is the compliance gate — she never calls the LLM.
  // Maestro handles all LLM calls directly using role prompts.
  // Default model matches VS Code Maestro BRAIN role setting
  const modelId = settingsModelId ?? process.env["LLM_MODEL"]?.trim() ?? "openai/gpt-4o-mini";
  const llm = createDirectLLMService(adapter, modelId);
  const gate = createMirandaGate({ verbose: process.env["MIRANDA_VERBOSE"] === "1" });

  const pappy = createPappyPort();
  const maestro = createMaestroAdapter();

  const workspaceRoot = process.env["WORKSPACE_ROOT"]?.trim() ?? process.cwd();

  // Unified tool bootstrap: core workbench + ext-* + any configured MCP servers
  const mcpServers = loadMcpConfig();
  const bootstrap = await buildToolBootstrap({
    workspaceRoot,
    mcpServers,
    log: (msg) => console.error(msg),
  });

  const tools = bootstrap.toolService;

  // Persistent run store — saves every task to ~/.orca/runs.db
  // Override the path with ORCA_DB_PATH if needed.
  const dbPath = process.env["ORCA_DB_PATH"]?.trim() ??
    path.join(os.homedir(), ".orca", "runs.db");
  const store = new SqliteStore(dbPath);
  _store = store;

  // Run analysis artifacts — written to ORCA_RUNS_DIR (default ~/.orca/runs/)
  const runsDir = process.env["ORCA_RUNS_DIR"]?.trim() ??
    path.join(os.homedir(), ".orca", "runs");
  const analysisWriter = createRunAnalysisWriter(runsDir);

  const runtime = createOrcaRuntime({
    maestro,
    pappy,
    llm,
    tools,
    store,
    gate,
    getWorkspaceContext: () => getWorkspaceContext(workspaceRoot),
    writeTrace: (trace) => analysisWriter.writeTrace(trace),
  });

  // Must be called after createOrcaRuntime and before executeTask
  analysisWriter.attachRuntime(runtime);

  // Benson receives executeTask via injection — orca-core never depends on Benson.
  // Wrap to adapt OrcaTaskSpec/OrcaExecutionResult to benson-core's TaskSpec/ExecutionResult
  const benson = createBenson({
    executeTask: async (task: TaskSpec): Promise<ExecutionResult> => {
      const orcaResult = await runtime.executeTask(task as OrcaTaskSpec);
      return orcaResult as unknown as ExecutionResult;
    },
    maxHistoryTurns: parseInt(process.env["ORCA_HISTORY_TURNS"] ?? "8", 10),
  });

  // 4. Subscribe to runtime events (written to stderr so they don't mix with output)
  listenFor(runtime, "task:start", (e) => {
    console.error(`\n[orca] ▶ task:start   ${e.taskId}  intent="${e.intent}"`);
  });

  listenFor(runtime, "maestro:start", (e) => {
    const label = e.isRepair ? `repair pass #${e.attempt}` : "initial pass";
    console.error(`[orca]   maestro:start  attempt=${e.attempt}  (${label})`);
  });

  listenFor(runtime, "maestro:done", (e) => {
    console.error(`[orca]   maestro:done   hasOutput=${e.hasOutput}`);
  });

  listenFor(runtime, "qc:result", (e) => {
    const icon =
      e.verdict === "PASS" ? "✓" : e.verdict === "WARN" ? "⚠" : "✗";
    console.error(
      `[orca]   qc:result      ${icon} ${e.verdict}  issues=${e.issueCount}`,
    );
  });

  listenFor(runtime, "repair:start", (e) => {
    console.error(`[orca]   repair:start   pass=${e.pass}/${e.maxPasses}`);
  });

  listenFor(runtime, "subagent:spawned", (e) => {
    console.error(`[orca]   subagent:▶     id=${e.subagentId}  role=${e.role}`);
  });

  listenFor(runtime, "subagent:done", (e) => {
    const icon = e.ok ? "✓" : "✗";
    console.error(`[orca]   subagent:■  ${icon}  id=${e.subagentId}`);
  });

  listenFor(runtime, "subagent:failed", (e) => {
    console.error(`[orca]   subagent:✗     id=${e.subagentId}  error=${e.error}`);
  });

  listenFor(runtime, "task:done", (e) => {
    console.error(`[orca] ■ task:done    status=${e.status}\n`);
  });

  // 5. Ask Benson to handle the user's message
  const reply = await benson.handleUserMessage(userText);

  // 6. Print Benson's reply to stdout
  //    (runtime events above all go to stderr so piping stdout stays clean)
  if (reply.kind === "CLARIFY") {
    console.log(reply.text);
    if (reply.options != null && reply.options.length > 0) {
      reply.options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    }
  } else {
    console.log(reply.text);
  }
}

// ---------------------------------------------------------------------------
// Prompt reader — argv first, then stdin
// ---------------------------------------------------------------------------

async function readPrompt(): Promise<string> {
  // pnpm forwards args after the script name directly, e.g.:
  //   pnpm -C apps/runner dev "Create a README for Orca"
  //   → process.argv = [..., "tsx", "src/index.ts", "Create a README for Orca"]
  const argv = process.argv.slice(2).join(" ").trim();
  if (argv) return argv;

  // Pipe mode: echo "prompt" | pnpm -C apps/runner dev
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const text = data.trim();
      if (!text) {
        console.error(
          "Usage:\n" +
            '  pnpm -C apps/runner dev "Your prompt here"\n' +
            '  echo "Your prompt" | pnpm -C apps/runner dev',
        );
        process.exit(1);
      }
      resolve(text);
    });
    process.stdin.on("error", reject);

    // Interactive TTY — prompt the user
    if (process.stdin.isTTY) {
      process.stdout.write("Enter prompt: ");
      process.stdin.resume();
    }
  });
}

// ---------------------------------------------------------------------------
// export-training-data sub-command
//
// Usage:
//   orca export-training-data \
//     --verdict PASS \
//     --max-repair-passes 0 \
//     --output moonshiner/data/orca_coding_prompts.jsonl \
//     --task-type strong_model \
//     --limit 500
// ---------------------------------------------------------------------------

async function runExportCommand(args: string[]): Promise<void> {
  const opts: Partial<ExportOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];

    switch (flag) {
      case '--verdict':
        if (value === 'PASS' || value === 'WARN' || value === 'FAIL') {
          opts.verdict = value;
          i++;
        } else {
          console.error(`[export] --verdict must be PASS, WARN, or FAIL. Got: ${value}`);
          process.exit(1);
        }
        break;
      case '--max-repair-passes':
        opts.maxRepairPasses = parseInt(value ?? '0', 10);
        i++;
        break;
      case '--output':
        opts.outputPath = value;
        i++;
        break;
      case '--task-type':
        opts.taskType = value;
        i++;
        break;
      case '--min-iterations':
        opts.minIterations = parseInt(value ?? '1', 10);
        i++;
        break;
      case '--limit':
        opts.limit = parseInt(value ?? '0', 10);
        i++;
        break;
    }
  }

  if (!opts.outputPath) {
    console.error(
      'Usage: orca export-training-data --output <path> [--verdict PASS|WARN|FAIL]\n' +
      '  [--max-repair-passes N] [--task-type ROLE] [--min-iterations N] [--limit N]',
    );
    process.exit(1);
  }

  const dbPath = process.env['ORCA_DB_PATH']?.trim() ??
    path.join(os.homedir(), '.orca', 'runs.db');
  const store = new SqliteStore(dbPath);

  try {
    const summary = await exportTrainingData(store, opts as ExportOptions);
    console.log(`[export] done — exported=${summary.exported} skipped=${summary.skipped} output=${summary.outputPath}`);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Store reference for graceful shutdown
let _store: SqliteStore | null = null;

async function run(): Promise<void> {
  // Check for sub-commands before the normal prompt-based flow.
  const subCommand = process.argv[2]?.trim();
  if (subCommand === 'export-training-data') {
    await runExportCommand(process.argv.slice(3));
    return;
  }

  try {
    await main();
  } finally {
    _store?.close();
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[runner] fatal: ${message}`);
  _store?.close();
  process.exit(1);
});
