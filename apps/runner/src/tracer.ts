/**
 * tracer.ts — Full pipeline trace from prompt to output.
 *
 * Two modes:
 *   npx tsx src/tracer.ts "prompt"                  → clean event table
 *   ORCA_DEBUG=true npx tsx src/tracer.ts "prompt"  → full message content
 *
 * Instruments:
 *   1. Benson       → intent parsing, TaskSpec
 *   2. orca-core    → task lifecycle events
 *   3. Maestro      → role selection, Dewey brief/review, agent loop
 *   4. LLM calls    → system prompt + user message, response
 *   5. Tool calls   → args + result
 *   6. Miranda gate → every checkpoint
 *   7. Pappy        → verdict, AC results, all issues
 *   8. Benson reply → cleaned user-facing output
 */

import "dotenv/config";

import * as os from "os";
import * as path from "path";
import {
  OpenRouterAdapter,
  OllamaAdapter,
  createMirandaGate,
} from "@clawde/miranda-core";
import type { LLMAdapter, GateName, GateResult, LLMCallGateContext, ToolGateContext, QCGateContext } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
  getWorkspaceContext,
  SqliteStore,
  createRunAnalysisWriter,
} from "@clawde/orca-core";
import type {
  OrcaRuntime,
  OrcaEvent,
  OrcaEventType,
  OrcaLLMService,
  OrcaTaskSpec,
  PappyPort,
} from "@clawde/orca-core";
import { createBenson } from "@clawde/benson-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
import { createMaestroAdapter } from "./adapters/maestroAdapter.js";
import { createToolService } from "./adapters/toolService.js";
import { setTracerHook } from "./adapters/tracerHooks.js";
import type { TracerEvent } from "./adapters/tracerHooks.js";

const DEBUG = process.env["ORCA_DEBUG"] !== "false";

// ── Colour helpers ────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  yellow:  "\x1b[33m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
};

const T0 = Date.now();

function ts(): string {
  return `${C.gray}+${((Date.now() - T0) / 1000).toFixed(2)}s${C.reset}`;
}

function box(label: string, color: string): void {
  const width = 72;
  const pad = Math.max(0, width - label.length - 4);
  const border = "─".repeat(width);
  process.stdout.write(
    `\n${color}┌${border}┐${C.reset}\n` +
    `${color}│ ${C.bold}${label}${C.reset}${color}${" ".repeat(pad)} ${ts()} │${C.reset}\n` +
    `${color}└${border}┘${C.reset}\n`,
  );
}

function line(label: string, value: string, color = C.white): void {
  process.stdout.write(`  ${C.dim}${label}:${C.reset} ${color}${value}${C.reset}\n`);
}

function detail(label: string, value: string, color = C.gray): void {
  if (!DEBUG) return;
  process.stdout.write(`  ${C.dim}${label}:${C.reset} ${color}${value}${C.reset}\n`);
}

function detailList(label: string, items: string[], color = C.gray): void {
  if (!DEBUG || items.length === 0) return;
  process.stdout.write(`  ${C.dim}${label}:${C.reset}\n`);
  for (const item of items) {
    process.stdout.write(`    ${color}• ${item}${C.reset}\n`);
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}${C.dim}…(+${s.length - n})${C.reset}` : s;
}

// ── LLM wrapper ───────────────────────────────────────────────────────────────
const SEP = "\n\n---\n\n";

function createTracingLLMService(adapter: LLMAdapter, modelId: string): OrcaLLMService {
  const direct = createDirectLLMService(adapter, modelId);
  let idx = 0;

  return {
    async complete(prompt, opts) {
      const n = ++idx;
      const maxTok = opts?.maxTokens ?? 4096;
      const simple = opts?.simple ?? false;
      box(`[LLM Call #${n}]  model=${modelId}  maxTokens=${maxTok}  simple=${simple}`, C.cyan);

      if (DEBUG) {
        const sepIdx = prompt.indexOf(SEP);
        if (sepIdx !== -1) {
          detail(`system`, prompt.slice(0, sepIdx));
          detail(`user`, prompt.slice(sepIdx + SEP.length));
        } else {
          detail(`prompt`, prompt);
        }
      }

      const t0 = Date.now();
      const result = await direct.complete(prompt, opts);
      const ms = Date.now() - t0;

      line("duration", `${ms}ms`, C.yellow);
      line("response", `${result.text.length} chars`, C.white);
      if (DEBUG) detail(`response`, result.text);

      return result;
    },

    async stream(prompt, options, onChunk) {
      const n = ++idx;
      const maxTok = options?.maxTokens ?? 4096;
      box(`[LLM Stream #${n}]  model=${modelId}  maxTokens=${maxTok}`, C.cyan);

      if (DEBUG) {
        const sepIdx = prompt.indexOf(SEP);
        if (sepIdx !== -1) {
          detail(`system`, prompt.slice(0, sepIdx));
          detail(`user`, prompt.slice(sepIdx + SEP.length));
        } else {
          detail(`prompt`, prompt);
        }
      }

      const t0 = Date.now();
      const result = await direct.stream(prompt, options, onChunk);
      const ms = Date.now() - t0;

      line("duration", `${ms}ms`, C.yellow);
      line("response", `${result.text.length} chars`, C.white);
      if (DEBUG) detail(`response`, result.text);

      return result;
    },
  };
}

// ── Pappy wrapper ─────────────────────────────────────────────────────────────
function createTracingPappyPort(inner: PappyPort): PappyPort {
  return {
    evaluate(input) {
      const result = inner.evaluate(input);
      const verdictColor = result.verdict === "PASS" ? C.green : result.verdict === "WARN" ? C.yellow : C.red;
      box(`[Pappy]  verdict=${result.verdict}  confidence=${Math.round(result.confidence * 100)}%  issues=${result.issues.length}`, verdictColor);

      if (DEBUG) {
        if (result.acceptance_criteria && result.acceptance_criteria.length > 0) {
          process.stdout.write(`  ${C.dim}acceptance criteria:${C.reset}\n`);
          for (const ac of result.acceptance_criteria) {
            process.stdout.write(`    ${C.dim}${ac.required ? "[required]" : "[optional]"} ${ac.text.slice(0, 120)}${C.reset}\n`);
          }
        }
        if (result.issues.length > 0) {
          process.stdout.write(`  ${C.dim}issues:${C.reset}\n`);
          for (const issue of result.issues) {
            const sev = issue.severity === "HIGH" || issue.severity === "CRITICAL" ? C.red : C.yellow;
            process.stdout.write(`    ${sev}${issue.severity} ${issue.code}: ${issue.description.slice(0, 120)}${C.reset}\n`);
          }
        }
      } else {
        // Always show issues count breakdown even outside DEBUG
        if (result.issues.length > 0) {
          const codes = result.issues.map(i => `${i.severity}:${i.code}`).join(", ");
          line("issues", codes, C.yellow);
        }
      }

      return result;
    },
  };
}

// ── Tool wrapper ──────────────────────────────────────────────────────────────
import type { OrcaToolService } from "@clawde/orca-core";

function createTracingToolService(inner: OrcaToolService): OrcaToolService {
  return {
    execute(name, input) {
      box(`[Tool →]  ${name}`, C.magenta);
      if (DEBUG) {
        for (const [k, v] of Object.entries(input)) {
          const val = String(v);
          detail(`  ${k}[0..200]`, val.slice(0, 200));
        }
      }
      return inner.execute(name, input).then(result => {
        const icon = result.ok ? `${C.green}✓` : `${C.red}✗`;
        process.stdout.write(`  ${icon} ${C.dim}[Tool ←]  ${name}  ok=${result.ok}  ${result.output.length} chars${C.reset}\n`);
        if (DEBUG && !result.ok && result.error) {
          detail("error", result.error, C.red);
        }
        return result;
      });
    },
    formatForPrompt() {
      return inner.formatForPrompt();
    },
  };
}

// ── Tracer hook handler ───────────────────────────────────────────────────────
function handleTracerEvent(event: TracerEvent): void {
  switch (event.type) {
    case "brain:route":
      box(`[Brain]  Routing → path=${event.data.path}${event.data.role ? ` role=${event.data.role}` : ""}${event.data.isFallback ? " (fallback)" : ""}`, C.blue);
      if (event.data.source) line("source", event.data.source);
      break;

    case "brain:route_fallback":
      box(`[Brain]  Routing fallback → heuristic role=${event.data.heuristicRole}`, C.yellow);
      line("reason", event.data.reason);
      break;

    case "dewey:brief":
      box(`[Dewey]  Brief for ${event.data.userName}`, C.blue);
      line("suggestedTone", event.data.suggestedTone);
      detailList("relevantPreferences", event.data.relevantPreferences);
      detailList("relevantContext", event.data.relevantContext);
      detailList("availableApps", event.data.availableApps);
      break;

    case "dewey:review": {
      const approved = event.data.approved;
      const color = approved ? C.green : C.yellow;
      box(`[Dewey]  Plan review: ${approved ? "APPROVED" : "CONCERNS"}`, color);
      if (DEBUG) {
        detailList("concerns", event.data.concerns, C.yellow);
        detailList("suggestions", event.data.suggestions, C.gray);
      }
      break;
    }

    case "tool:call":
    case "tool:result":
      // These are handled directly in the tool wrapper
      break;
  }
}

// ── Event listener helper ─────────────────────────────────────────────────────
type EventOfType<T extends OrcaEventType> = Extract<OrcaEvent, { type: T }>;
function listenFor<T extends OrcaEventType>(
  runtime: OrcaRuntime, type: T,
  handler: (e: EventOfType<T>) => void,
): void {
  runtime.on(type, (e) => { if (e.type === type) handler(e as EventOfType<T>); });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const userText = process.argv.slice(2).join(" ").trim() || "Write a greet function that takes a name and returns Hello, name";

  box(`ORCA TRACER${!DEBUG ? "  [COMPACT — set ORCA_DEBUG=false to disable]" : ""}`, C.magenta);
  line("prompt", userText, C.white);
  line("time", new Date().toISOString(), C.gray);
  // Display model from env or default (matches VS Code Maestro BRAIN role)
  const displayModel = process.env["LLM_MODEL"]?.trim() ?? "openai/gpt-4o-mini";
  line("model", displayModel, C.gray);
  if (!DEBUG) line("note", "ORCA_DEBUG=false — compact mode (set ORCA_DEBUG=false to suppress content)", C.gray);

  // ── Install tracer hook for adapter events ─────────────────────────────────
  setTracerHook(handleTracerEvent);

  // ── Build adapter ──────────────────────────────────────────────────────────
  const provider = process.env["LLM_PROVIDER"]?.trim().toLowerCase();
  let adapter: LLMAdapter;
  if (provider === "ollama") {
    adapter = new OllamaAdapter({
      baseUrl:      process.env["OLLAMA_BASE_URL"]  ?? "http://localhost:11434",
      defaultModel: process.env["OLLAMA_MODEL"]     ?? "llama3.2",
    });
  } else {
    const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
    if (!apiKey) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }
    adapter = new OpenRouterAdapter({
      apiKey,
      siteUrl: process.env["OPENROUTER_SITE_URL"] ?? "http://localhost",
      appName: process.env["OPENROUTER_APP_NAME"] ?? "orca-tracer",
    });
  }

  // ── Wire LLM + Miranda gate ────────────────────────────────────────────────
  // Default model matches VS Code Maestro BRAIN role setting
  const modelId = process.env["LLM_MODEL"]?.trim() ?? "openai/gpt-4o-mini";
  const llm = createTracingLLMService(adapter, modelId);

  const gate = createMirandaGate({
    verbose: false,  // suppress Miranda's own stderr; we print via onGate
    onGate: (gateName: GateName, result: GateResult, _ctx: LLMCallGateContext | ToolGateContext | QCGateContext) => {
      const icon = result.allowed ? `${C.green}✓` : `${C.red}✗`;
      const color = result.allowed ? C.green : C.red;
      process.stdout.write(`  ${icon} ${C.dim}[Miranda]  ${gateName}  ${color}${result.allowed ? "ALLOWED" : "BLOCKED"}${C.reset}  ${C.gray}${result.reason}${C.reset}\n`);
      if (DEBUG && !result.allowed && result.violations?.length) {
        for (const v of result.violations) {
          process.stdout.write(`    ${C.red}⚠ ${v}${C.reset}\n`);
        }
      }
    },
  });

  // ── Wire the pod ───────────────────────────────────────────────────────────
  const pappy = createTracingPappyPort(createPappyPort());
  const maestro = createMaestroAdapter();
  const workspaceRoot = process.env["WORKSPACE_ROOT"]?.trim() ?? process.cwd();
  const toolRegistry = createCoreToolRegistry();
  const rawTools = createToolService(toolRegistry, workspaceRoot);
  const tools = createTracingToolService(rawTools);
  const dbPath = process.env["ORCA_DB_PATH"]?.trim() ?? path.join(os.homedir(), ".orca", "runs.db");
  const store = new SqliteStore(dbPath);

  // Run analysis artifacts — written to ORCA_RUNS_DIR (default ~/.orca/runs/)
  const runsDir = process.env["ORCA_RUNS_DIR"]?.trim() ??
    path.join(os.homedir(), ".orca", "runs");
  const analysisWriter = createRunAnalysisWriter(runsDir);

  const runtime = createOrcaRuntime({
    maestro, pappy, llm, tools, store, gate,
    getWorkspaceContext: () => getWorkspaceContext(workspaceRoot),
    writeTrace: (trace) => analysisWriter.writeTrace(trace),
  });

  // Must be called after createOrcaRuntime and before executeTask
  analysisWriter.attachRuntime(runtime);

  // Track the real taskId so we can print the exact artifact path at the end.
  let currentTaskId = "";

  // ── Orca event hooks ───────────────────────────────────────────────────────
  listenFor(runtime, "task:start", (e) => {
    currentTaskId = e.taskId;
    box(`[orca]  task:start  ${e.taskId}`, C.blue);
    line("intent", e.intent, C.white);
  });

  listenFor(runtime, "maestro:start", (e) => {
    const label = e.isRepair ? `repair pass #${e.attempt}` : "initial pass";
    box(`[orca]  maestro:start  attempt=${e.attempt}  (${label})`, C.cyan);
  });

  listenFor(runtime, "maestro:done", (e) => {
    box(`[orca]  maestro:done  hasOutput=${e.hasOutput}`, C.cyan);
  });

  listenFor(runtime, "qc:result", (e) => {
    // High-level verdict already shown by Pappy wrapper; just show repair context
    if (e.isRepair) line("repair context", `attempt=${e.attempt}`, C.gray);
  });

  listenFor(runtime, "repair:start", (e) => {
    box(`[orca]  repair:start  pass=${e.pass}/${e.maxPasses}`, C.yellow);
  });

  listenFor(runtime, "subagent:spawned", (e) => {
    box(`[orca]  subagent:spawned  ${e.subagentId}  role=${e.role}`, C.magenta);
    detail("task", e.task);
  });

  listenFor(runtime, "subagent:done", (e) => {
    const icon = e.ok ? `${C.green}✓` : `${C.red}✗`;
    process.stdout.write(`  ${icon} ${C.dim}[orca]  subagent:done  ${e.subagentId}  role=${e.role}${C.reset}\n`);
  });

  listenFor(runtime, "subagent:failed", (e) => {
    process.stdout.write(`  ${C.red}✗ [orca]  subagent:failed  ${e.subagentId}  error=${e.error}${C.reset}\n`);
  });

  listenFor(runtime, "task:done", (e) => {
    const color = e.status === "SUCCESS" ? C.green : C.red;
    box(`[orca]  task:done  status=${e.status}`, color);
  });

  listenFor(runtime, "maestro:agent_start", (e) => {
    box(`[orca]  agent_start  role=${e.role}`, C.cyan);
    detailList("doneCriteria", e.doneCriteria);
  });

  listenFor(runtime, "maestro:agent_done", (e) => {
    box(`[orca]  agent_done  role=${e.role}  stoppedBecause=${e.stoppedBecause}  iters=${e.iterations}`, C.cyan);
  });

  // ── Benson ─────────────────────────────────────────────────────────────────
  box("LAYER 1 — Benson: parse intent", C.blue);

  const benson = createBenson({
    executeTask: (spec) => {
      box("LAYER 2 — orca-core: executeTask", C.blue);
      line("intent", spec.intent);
      line("goals", spec.goals.join(" | "), C.gray);
      if (spec.permissions?.length) {
        line("permissions", spec.permissions.join(", "), C.gray);
      }
      return runtime.executeTask(spec as unknown as OrcaTaskSpec);
    },
    maxHistoryTurns: 8,
  });

  const reply = await benson.handleUserMessage(userText);

  // ── Final output ───────────────────────────────────────────────────────────
  box(`[Benson]  presenting result  (${reply.kind})`, C.green);
  if (reply.kind === "CLARIFY") {
    line("kind", "CLARIFY");
    process.stdout.write(`\n${reply.text}\n`);
    reply.options?.forEach((opt, i) => process.stdout.write(`  ${i + 1}. ${opt}\n`));
  } else {
    line("chars", `${reply.text.length}`, C.gray);
    if (DEBUG) detail("preview", reply.text);
    process.stdout.write(`\n${C.white}${reply.text}${C.reset}\n`);
  }

  const totalSec = ((Date.now() - T0) / 1000).toFixed(2);
  box(`TRACE COMPLETE  total=${totalSec}s`, C.magenta);

  const artifactDir = path.join(runsDir, currentTaskId);
  line("artifacts", `${artifactDir}\\run-analysis.md`, C.gray);

  store.close();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${C.red}[tracer] fatal: ${msg}${C.reset}`);
  process.exit(1);
});
