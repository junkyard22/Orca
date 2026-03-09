/**
 * apps/runner — minimal Orca pod CLI runner.
 *
 * Wiring:
 *   OpenRouterAdapter → createMirandaLLMService → OrcaLLMService
 *   createPappyPort()                            → PappyPort
 *   createMaestroAdapter()                       → MaestroPort
 *   createOrcaRuntime({ maestro, pappy, llm })   → OrcaRuntime
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
import { OpenRouterAdapter, OllamaAdapter, createDefaultConfig } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createMirandaLLMService,
  createPappyPort,
  getWorkspaceContext,
  SqliteStore,
} from "@clawde/orca-core";
import type { OrcaRuntime, OrcaEvent, OrcaEventType } from "@clawde/orca-core";
import { createBenson } from "@clawde/benson-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";

import { createMaestroAdapter } from "./adapters/maestroAdapter.js";
import { createToolService } from "./adapters/toolService.js";

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

  // 2. Build LLM adapter — set LLM_PROVIDER=ollama in .env to use Ollama locally
  const provider = process.env["LLM_PROVIDER"]?.trim().toLowerCase();

  let adapter;
  if (provider === "ollama") {
    adapter = new OllamaAdapter({
      baseUrl:      process.env["OLLAMA_BASE_URL"]  ?? "http://localhost:11434",
      defaultModel: process.env["OLLAMA_MODEL"]     ?? "llama3.2",
    });
  } else {
    const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
    if (!apiKey) {
      console.error(
        "Error: OPENROUTER_API_KEY is not set.\n" +
          "  → Copy apps/runner/.env.example → apps/runner/.env and add your key.\n" +
          "  → Get a free key at https://openrouter.ai/keys\n" +
          "  → Or set LLM_PROVIDER=ollama to use a local Ollama model instead.",
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

  const llm = createMirandaLLMService(
    adapter,
    createDefaultConfig(),
  );

  const pappy = createPappyPort();
  const maestro = createMaestroAdapter();

  // Tool registry — workspace root defaults to CWD but can be overridden
  // via the WORKSPACE_ROOT env var (useful when the agent should operate on
  // a specific project rather than wherever the runner process starts).
  const workspaceRoot = process.env["WORKSPACE_ROOT"]?.trim() ?? process.cwd();
  const toolRegistry = createCoreToolRegistry();
  const tools = createToolService(toolRegistry, workspaceRoot);

  // Persistent run store — saves every task to ~/.orca/runs.db
  // Override the path with ORCA_DB_PATH if needed.
  const dbPath = process.env["ORCA_DB_PATH"]?.trim() ??
    path.join(os.homedir(), ".orca", "runs.db");
  const store = new SqliteStore(dbPath);

  const runtime = createOrcaRuntime({
    maestro,
    pappy,
    llm,
    tools,
    store,
    getWorkspaceContext: () => getWorkspaceContext(workspaceRoot),
  });

  // Benson receives executeTask via injection — orca-core never depends on Benson.
  const benson = createBenson({
    executeTask: runtime.executeTask.bind(runtime),
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
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[runner] fatal: ${message}`);
  process.exit(1);
});
