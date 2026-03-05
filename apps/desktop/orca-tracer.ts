/**
 * orca-tracer.ts — End-to-end prompt tracer
 *
 * Wires up Benson → Orca Runtime → Maestro Adapter → Miranda Pipeline
 * using REAL API keys loaded from the app's settings.json (or .env fallback).
 * Miranda's 4-stage pipeline (PLAN→ANSWER→CRITIQUE→REWRITE) runs live and
 * every adapter call is logged with stage, model, token counts, and latency.
 *
 * Run:  node --experimental-strip-types --no-warnings apps/desktop/orca-tracer.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createBenson } from "@clawde/benson-core";
import {
  createOrcaRuntime,
  createMirandaLLMService,
  createDebugPappyPort,
} from "@clawde/orca-core";
import type {
  OrcaRuntime,
  OrcaEvent,
  OrcaEventType,
  MaestroPort,
  OrcaMaestroResult,
  OrcaRunCtx,
  OrcaTaskSpec,
} from "@clawde/orca-core";
import {
  createMaestroCore,
  selectRole,
  getRolePrompt,
} from "maestro-core";
import type {
  RoleName,
  OptionalRoleName,
} from "maestro-core";
import {
  createDefaultConfig,
  OpenAICompatAdapter,
  OllamaAdapter,
} from "@clawde/miranda-core";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "@clawde/miranda-core";

// ── Load real settings ─────────────────────────────────────────────────────

const SETTINGS_PATH = join(
  process.env["APPDATA"] ?? process.env["HOME"] ?? "",
  "@clawde", "desktop", "orca-settings.json",
);

interface SettingsProvider { type: string; baseUrl: string; apiKey: string; }
interface SettingsRole    { providerId: string; model: string; }
interface Settings {
  providers?: SettingsProvider & { id: string }[];
  roles?: Record<string, SettingsRole>;
  budgetUsd?: number;
  verbose?: boolean;
}

function loadRealAdapter(): { adapter: LLMAdapter; model: string; budgetUsd: number } {
  // Try app settings first
  if (existsSync(SETTINGS_PATH)) {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings;
    const brain = s.roles?.["brain"];
    const provider = (s.providers ?? []).find((p: any) => p.id === brain?.providerId) as any;
    if (brain && provider) {
      const model = brain.model;
      const adapter = provider.type === "ollama"
        ? new OllamaAdapter({ baseUrl: provider.baseUrl || "http://localhost:11434", defaultModel: model })
        : new OpenAICompatAdapter({ baseUrl: provider.baseUrl, apiKey: provider.apiKey || undefined, defaultModel: model });
      return { adapter, model, budgetUsd: s.budgetUsd ?? 0.5 };
    }
  }
  // Fallback: OPENROUTER_API_KEY env var
  const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!apiKey) throw new Error("No settings.json found and OPENROUTER_API_KEY not set.\nRun the Orca app first to configure a provider, or set OPENROUTER_API_KEY.");
  return {
    adapter: new OpenAICompatAdapter({ baseUrl: "https://openrouter.ai/api/v1", apiKey, defaultModel: "qwen/qwen-2.5-72b-instruct" }),
    model:   "qwen/qwen-2.5-72b-instruct",
    budgetUsd: 0.5,
  };
}

// ── Pretty logging ─────────────────────────────────────────────────────────

const t0 = Date.now();
const C = {
  reset:   "\x1b[0m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  magenta: "\x1b[35m",
  red:     "\x1b[31m",
  blue:    "\x1b[34m",
  white:   "\x1b[97m",
};

function ts() {
  return `${C.dim}+${(Date.now() - t0).toString().padStart(6)}ms${C.reset}`;
}

function trace(layer: string, color: string, msg: string) {
  console.log(`${ts()} ${color}[${layer.padEnd(10)}]${C.reset} ${msg}`);
}

// ── Tracing wrapper around the real adapter ─────────────────────────────
// Wraps the live OpenAICompatAdapter so every call is logged with stage,
// model, latency, and token usage — without replacing the real network calls.

let adapterCallCount = 0;

class TracingLiveAdapter implements LLMAdapter {
  private inner: LLMAdapter;
  constructor(inner: LLMAdapter) { this.inner = inner; }
  get name() { return this.inner.name; }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;
    const t = Date.now();

    // Detect stage from the system prompt content
    const sys = request.messages.find(m => m.role === "system")?.content ?? "";
    let stage = "?";
    if (sys.includes("structured plan"))       stage = "PLAN";
    else if (sys.includes("Plan output"))      stage = "ANSWER";
    else if (sys.includes("Critique"))         stage = "CRITIQUE";
    else if (sys.includes("Rewrite"))          stage = "REWRITE";

    trace("Adapter", C.magenta, `Call #${callNum}  stage=${stage}  model=${request.model}  msgs=${request.messages.length}`);

    // Log the prompt reaching the adapter
    const promptPreview = sys.slice(0, 150).replace(/\n/g, "\\n");
    trace("Adapter", C.dim, `  system[0..150]: "${promptPreview}…"`);

    // Check for conversation history in prompt
    if (sys.includes("Conversation history") || sys.includes("USER:")) {
      trace("Adapter", C.green, `  ✓ Conversation history detected in prompt!`);
    }

    // Hit the real API
    trace("Adapter", C.magenta, `  → calling API...`);
    const response = await this.inner.complete(request);
    const ms = Date.now() - t;
    trace("Adapter", C.magenta,
      `  ← ${ms}ms  ${response.usage?.totalTokens ?? "?"}tok` +
      `  (in=${response.usage?.promptTokens ?? "?"} out=${response.usage?.completionTokens ?? "?"})` +
      `  ${response.content.length} chars`);
    const preview = response.content.slice(0, 120).replace(/\n/g, "\\n");
    trace("Adapter", C.dim, `  content[0..120]: "${preview}…"`);
    return response;
  }

  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;
    const t = Date.now();
    const sys = request.messages.find(m => m.role === "system")?.content ?? "";
    let stage = "?";
    if (sys.includes("structured plan"))  stage = "PLAN";
    else if (sys.includes("Plan output")) stage = "ANSWER";
    else if (sys.includes("Critique"))    stage = "CRITIQUE";
    else if (sys.includes("Rewrite"))     stage = "REWRITE";
    trace("Adapter", C.magenta, `Call #${callNum}  stage=${stage} [stream]  model=${request.model}`);

    let tokenCount = 0;
    const response = await this.inner.stream(request, (chunk) => {
      tokenCount++;
      onToken(chunk);
    });
    const ms = Date.now() - t;
    trace("Adapter", C.magenta, `  ← ${ms}ms  ${tokenCount} chunks  ${response.usage?.totalTokens ?? "?"}tok`);
    return response;
  }
}

// ── Decision logger ───────────────────────────────────────────────────────
// Prints a highlighted Decision / Reason pair to the trace output.

function decision(desc: string, reason: string) {
  console.log(
    `${ts()} ${C.yellow}[Decision   ]${C.reset} ${C.white}${desc}${C.reset}`,
  );
  console.log(
    `${"".padStart(13)} ${C.dim}Reason: ${reason}${C.reset}`,
  );
}

// ── Core-role heuristic (mirrors main.ts pickCoreRole) ────────────────────

type CoreRoleName = "brain" | "coder_strong" | "coder_cheap" | "reviewer" | "narrator" | "utility";

function pickCoreRole(task: OrcaTaskSpec): { role: CoreRoleName; reason: string } {
  if (task.intent === "repair") return { role: "coder_strong", reason: "Task intent is repair" };

  const msg = task.originalUserMessage.toLowerCase();

  if (/\b(implement|build|create|add feature|write code|develop)\b/.test(msg))
    return { role: "coder_strong", reason: `Task contains code-generation verb (implement/build/create/develop)` };

  if (/\b(rename|reformat|fix typo|small (fix|change|edit)|update import|add field)\b/.test(msg))
    return { role: "coder_cheap", reason: "Task is a small/trivial edit" };

  if (/\b(review|audit|critique|check for (bugs|issues|problems)|is this (correct|right|good))\b/.test(msg))
    return { role: "reviewer", reason: "Task requests review or audit" };

  if (/\b(document|write (a |the )?(readme|docs?|comment|jsdoc|tsdoc)|explain (to others|in plain))\b/.test(msg))
    return { role: "narrator", reason: "Task requests documentation or explanation" };

  return { role: "brain", reason: "No specialised trigger matched — default reasoning role" };
}

// ── Optional-role trigger reasons (mirrors roleSelector.ts logic) ─────────

const ALL_OPTIONAL_ROLES = new Set<OptionalRoleName>(["planner_deep", "debugger", "reader", "vision"]);

function deriveRoleReason(
  role: RoleName,
  isFallback: boolean,
  coreReason: string,
  ctx: { hasImages?: boolean; errorOutput?: string; textLength?: number; fileCount?: number; isRisky?: boolean },
): string {
  if (isFallback) return `Preferred role not configured — fell back to ${role}`;
  if (role === "vision")       return "User input contains images";
  if (role === "debugger")     return "Error output detected in context (compile/test/lint failure)";
  if (role === "reader")       return `Large text input (${ctx.textLength ?? "?"} chars > 2000)`;
  if (role === "planner_deep") {
    if (ctx.isRisky)           return `High-risk change detected (multi-file, refactor, or deep-plan flag)`;
    return "Task classified as risky or deep-plan requested";
  }
  return coreReason;
}

// ── Tracing Maestro Adapter ────────────────────────────────────────────────
// Mirrors the real buildMaestroAdapter() — includes full role-selection
// and task-classification logic so all decisions show in the trace.

function createTracingMaestro(): MaestroPort {
  const maestroCore = createMaestroCore();

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      trace("Maestro", C.cyan, `═══ Received task: intent="${task.intent}" ═══`);
      trace("Maestro", C.cyan, `  message: "${task.originalUserMessage}"`);
      trace("Maestro", C.cyan, `  goals: [${task.goals.map(g => `"${g}"`).join(", ")}]`);

      // ── Task classification ──────────────────────────────────────────────
      const orch = maestroCore.orchestrate(task.originalUserMessage);
      const { type, estimatedImpact, multiStep } = orch.classification;
      const { riskScore, requiresPlan } = orch.risk;

      decision(
        `Task classified as ${type}`,
        `Heuristic pattern match on "${task.originalUserMessage.slice(0, 60)}" ` +
        `| impact=${estimatedImpact.toFixed(2)} multiStep=${multiStep}`,
      );
      decision(
        `Risk score: ${riskScore.toFixed(2)} — plan gate ${requiresPlan ? "REQUIRED" : "not required"}`,
        `Risk scorer weighs task type (${type}), impact (${estimatedImpact.toFixed(2)}), and multi-step flag`,
      );

      // ── Role selection ───────────────────────────────────────────────────
      const taskCtx = task.context ?? {};
      const roleSelectorCtx = {
        task:                task.originalUserMessage,
        hasImages:           Boolean(taskCtx["hasImages"]),
        errorOutput:         typeof taskCtx["errorOutput"] === "string" ? taskCtx["errorOutput"] as string : undefined,
        textLength:          task.originalUserMessage.length,
        fileCount:           typeof taskCtx["fileCount"] === "number" ? taskCtx["fileCount"] as number : undefined,
        isDeepPlanRequested: typeof taskCtx["deepPlan"] === "boolean" ? taskCtx["deepPlan"] as boolean : undefined,
        filePath:            typeof taskCtx["filePath"] === "string" ? taskCtx["filePath"] as string : undefined,
      };

      const { role: coreRole, reason: coreReason } = pickCoreRole(task);
      const { role, isFallback, warning } = selectRole(roleSelectorCtx, ALL_OPTIONAL_ROLES, coreRole);

      const isRisky = riskScore > 0.5 || requiresPlan || Boolean(roleSelectorCtx.isDeepPlanRequested);
      const roleReason = deriveRoleReason(role as RoleName, isFallback, coreReason, {
        hasImages:   roleSelectorCtx.hasImages,
        errorOutput: roleSelectorCtx.errorOutput,
        textLength:  roleSelectorCtx.textLength,
        fileCount:   roleSelectorCtx.fileCount,
        isRisky,
      });

      decision(
        `Role selected: ${role}${isFallback ? " (fallback)" : ""}`,
        roleReason,
      );

      if (warning) {
        trace("Maestro", C.yellow, `  ⚠ Role warning: ${warning}`);
      }

      // Check conversation history
      const history = task.context?.["conversationHistory"] as Array<{user: string; assistant: string}> | undefined;
      if (history?.length) {
        trace("Maestro", C.green, `  ✓ conversationHistory: ${history.length} turn(s)`);
        for (const turn of history) {
          trace("Maestro", C.dim, `    USER: "${turn.user.slice(0, 60)}…"`);
          trace("Maestro", C.dim, `    ASST: "${turn.assistant.slice(0, 60)}…"`);
        }
      } else {
        trace("Maestro", C.yellow, `  ⚠ No conversationHistory (expected on turn 1)`);
      }

      // Build prompt (same as real adapter)
      const systemPrompt = getRolePrompt(role as RoleName);
      const lines: string[] = [
        `## Task\nRole: **${role}**${isFallback ? " (fallback — preferred role unavailable)" : ""}`,
        ``, `### Request`, task.originalUserMessage,
        ``, `### Goals`, ...task.goals.map(g => `- ${g}`),
      ];

      if (history?.length) {
        const transcript = history
          .map(t => `USER: ${t.user}\nASSISTANT: ${t.assistant}`)
          .join("\n\n");
        lines.push("", "### Conversation history", transcript);
      }

      const taskPrompt = lines.join("\n");
      const fullPrompt = `${systemPrompt}\n\n---\n\n${taskPrompt}`;
      trace("Maestro", C.cyan, `  Built ${fullPrompt.length}-char prompt (${systemPrompt.length} sys + ${taskPrompt.length} task) → calling ctx.llm.complete()...`);

      // Track stream events
      let tokenCount = 0;
      let resetCount = 0;

      const { text } = await ctx.llm.complete(fullPrompt, {
        maxTokens: 4096,
        onToken: ctx.emit
          ? (chunk: string) => {
              tokenCount++;
              ctx.emit!({ type: "stream:token", taskId: ctx.runId, chunk });
            }
          : undefined,
        onStreamReset: ctx.emit
          ? () => {
              resetCount++;
              trace("Maestro", C.yellow, `  ◄ stream:reset fired! (#${resetCount})`);
              ctx.emit!({ type: "stream:reset", taskId: ctx.runId });
            }
          : undefined,
      });

      trace("Maestro", C.cyan, `  LLM returned ${text.length} chars  |  ${tokenCount} stream tokens  |  ${resetCount} resets`);
      trace("Maestro", C.dim, `  Final text[0..120]: "${text.slice(0, 120).replace(/\n/g, "\\n")}…"`);

      return {
        outputText: text,
        summary: `role=${role}${isFallback ? "(fallback)" : ""} type=${type} risk=${riskScore.toFixed(2)}`,
      };
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ORCA PIPELINE TRACER — live API run`);
  console.log(`${"═".repeat(72)}\n`);

  // 1. Load real provider settings and wrap with tracing
  trace("Init", C.blue, `Loading settings from: ${SETTINGS_PATH}`);
  const { adapter: rawAdapter, model, budgetUsd } = loadRealAdapter();
  trace("Init", C.blue, `Using model: ${C.cyan}${model}${C.reset}  budget: $${budgetUsd}`);
  const adapter = new TracingLiveAdapter(rawAdapter);

  trace("Init", C.blue, "Creating Miranda LLM service (real pipeline)...");
  const config = createDefaultConfig({ verbose: true, budgetUsd, logPath: "orca-tracer.log" });
  const llm = createMirandaLLMService(adapter, config);

  trace("Init", C.blue, "Creating Pappy QC port (debug trace enabled)...");
  const pappy = createDebugPappyPort();

  trace("Init", C.blue, "Creating tracing Maestro adapter...");
  const maestro = createTracingMaestro();

  trace("Init", C.blue, "Creating Orca runtime...");
  const runtime: OrcaRuntime = createOrcaRuntime({ maestro, pappy, llm, maxRepairPasses: 1 });

  // Subscribe to ALL event types
  const events: OrcaEvent[] = [];
  const eventTypes: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result", "repair:start", "task:done",
    "stream:token", "stream:reset",
  ];
  const unsubs = eventTypes.map(type =>
    runtime.on(type, (e: OrcaEvent) => {
      events.push(e);
      if (e.type === "stream:token") return;  // too noisy

      trace("Event", C.green, `${e.type} → ${JSON.stringify(e)}`);

      // Print a highlighted Decision line for key routing decisions
      if (e.type === "qc:result") {
        const ev = e as OrcaEvent & { verdict?: string; issueCount?: number; attempt?: number; isRepair?: boolean };
        const verdict = ev.verdict ?? "?";
        const issues  = ev.issueCount ?? 0;
        if (verdict === "PASS" || verdict === "WARN") {
          decision(
            `QC verdict: ${verdict} — output accepted`,
            issues === 0
              ? "No issues found by Pappy"
              : `${issues} minor issue(s) found but below failure threshold`,
          );
        } else {
          decision(
            `QC verdict: FAIL — triggering repair loop`,
            `Pappy found ${issues} issue(s) that require correction`,
          );
        }
      }

      if (e.type === "repair:start") {
        const ev = e as OrcaEvent & { pass?: number; maxPasses?: number };
        decision(
          `Repair pass ${ev.pass ?? "?"}/${ev.maxPasses ?? "?"} started`,
          `Previous attempt failed Pappy QC — re-running task as intent:repair with coder_strong role`,
        );
      }
    })
  );

  trace("Init", C.blue, "Creating Benson speaker...");
  const benson = createBenson({ executeTask: runtime.executeTask.bind(runtime) });

  // ── Determine mode ─────────────────────────────────────────────────────
  // If a prompt is passed as a CLI arg, run it once and exit.
  // Otherwise, enter interactive REPL mode.
  const cliPrompt = process.argv[2]?.trim();

  if (cliPrompt) {
    // ── Single-shot mode ─────────────────────────────────────────────────
    console.log(`\n${"─".repeat(72)}`);
    trace("Prompt", C.white, `"${cliPrompt}"`);
    console.log(`${"─".repeat(72)}\n`);

    const reply = await benson.handleUserMessage(cliPrompt);
    console.log(`\n${"─".repeat(72)}`);
    trace("Reply", C.yellow, `kind: ${reply.kind}`);
    console.log(`\n${reply.text}\n`);
    console.log(`${"─".repeat(72)}\n`);

    unsubs.forEach(u => u());
    process.exit(0);
  }

  // ── Interactive REPL mode ───────────────────────────────────────────────
  // Prompts the user for input, runs it through the full pipeline, then
  // loops. Type "exit" or press Ctrl+C to quit.
  import("node:readline").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const askNext = () => {
      process.stdout.write(`\n${C.cyan}You>${C.reset} `);
      rl.once("line", async (line: string) => {
        const msg = line.trim();
        if (!msg || msg.toLowerCase() === "exit" || msg.toLowerCase() === "quit") {
          console.log(`\n${C.dim}Exiting tracer.${C.reset}\n`);
          unsubs.forEach(u => u());
          rl.close();
          process.exit(0);
        }

        console.log(`\n${"─".repeat(72)}\n`);
        const reply = await benson.handleUserMessage(msg);
        console.log(`\n${"─".repeat(72)}`);
        trace("Reply", C.yellow, `kind: ${reply.kind}`);
        console.log(`\n${reply.text}\n`);
        console.log(`${"─".repeat(72)}`);

        askNext();
      });
    };

    console.log(`\n${C.cyan}Interactive mode${C.reset} — type your prompt and press Enter. Type ${C.dim}exit${C.reset} to quit.\n`);
    askNext();
  });
}

main().catch((err) => {
  console.error("\nTracer crashed:", err);
  process.exit(1);
});
