/**
 * orca-tracer.ts — End-to-end prompt tracer
 *
 * Mirrors the real Maestro flow:
 *   Brain routing call → direct specialist OR parallel departments → synthesis
 * Uses REAL API keys loaded from the app's settings.json (or .env fallback).
 * Every LLM call is logged with role, model, token counts, and latency.
 *
 * Run:  node --experimental-strip-types --no-warnings apps/desktop/orca-tracer.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createBenson } from "@clawde/benson-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
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
  OrcaLLMService,
} from "@clawde/orca-core";
import {
  createMaestroCore,
  getRolePrompt,
  BRAIN_DECOMPOSE_SYSTEM,
  parseBrainDecision,
  buildSynthesisPrompt,
} from "maestro-core";
import type {
  RoleName,
  DecomposeDecision,
} from "maestro-core";
import {
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
interface SettingsRole {
  providerId: string;
  model: string;
}
interface Settings {
  providers?: (SettingsProvider & { id: string; name?: string })[];
  roles?: Record<string, SettingsRole>;
  budgetUsd?: number;
}

function loadSettings(): Settings {
  if (existsSync(SETTINGS_PATH)) {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings;
  }
  return {};
}

function buildRawAdapter(
  provider: SettingsProvider & { id: string; name?: string },
  model: string,
): LLMAdapter {
  return provider.type === "ollama"
    ? new OllamaAdapter({ baseUrl: provider.baseUrl || "http://localhost:11434", defaultModel: model })
    : new OpenAICompatAdapter({ baseUrl: provider.baseUrl, apiKey: provider.apiKey || undefined, defaultModel: model });
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
// Wraps the live adapter so every call is logged with role, model,
// latency, and token usage — without replacing the real network calls.

let adapterCallCount = 0;

class TracingLiveAdapter implements LLMAdapter {
  private inner: LLMAdapter;
  private roleLabel: string;

  constructor(inner: LLMAdapter, roleLabel: string = "?") {
    this.inner = inner;
    this.roleLabel = roleLabel;
  }

  get name() { return this.inner.name; }

  private detectStage(sys: string): string {
    if (sys.includes("task router"))       return "ROUTE";
    if (sys.includes("synthesising the")) return "SYNTH";
    return this.roleLabel;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;
    const t = Date.now();
    const sys = request.messages.find(m => m.role === "system")?.content ?? "";
    const stage = this.detectStage(sys);

    trace("Adapter", C.magenta, `Call #${callNum}  stage=${stage}  model=${request.model}  msgs=${request.messages.length}`);
    const promptPreview = sys.slice(0, 150).replace(/\n/g, "\\n");
    trace("Adapter", C.dim, `  system[0..150]: "${promptPreview}…"`);
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
    const stage = this.detectStage(sys);
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

function decision(desc: string, reason: string) {
  console.log(`${ts()} ${C.yellow}[Decision   ]${C.reset} ${C.white}${desc}${C.reset}`);
  console.log(`${"".padStart(13)} ${C.dim}Reason: ${reason}${C.reset}`);
}

// ── Task prompt builder (mirrors main.ts buildTaskPrompt) ─────────────────

function buildTaskPrompt(task: OrcaTaskSpec, role?: string): string {
  const isRepair = task.intent === "repair";
  const header = isRepair
    ? "## Repair Task\nYou are fixing defects identified in a previous attempt.\n" +
      "Address every issue listed in the context below without changing unrelated behaviour."
    : role ? `## Task\nRole: **${role}**` : "## Task";

  const lines: string[] = [
    header, "",
    "### Request", task.originalUserMessage, "",
    "### Goals", ...task.goals.map((g: string) => `- ${g}`),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  const history = task.context?.["conversationHistory"] as Array<{ user: string; assistant: string }> | undefined;
  if (history?.length) {
    const transcript = history.map(h => `USER: ${h.user}\nASSISTANT: ${h.assistant}`).join("\n\n");
    lines.push("", "### Conversation history", transcript);
  }

  return lines.join("\n");
}

// ── Tracing Maestro — mirrors buildMaestroAdapter() from main.ts ──────────

function createTracingMaestro(
  roleAdapters: Partial<Record<string, OrcaLLMService>>,
): MaestroPort {
  const maestroCore = createMaestroCore();

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      trace("Maestro", C.cyan, `═══ Received task: intent="${task.intent}" ═══`);
      trace("Maestro", C.cyan, `  message: "${task.originalUserMessage}"`);
      trace("Maestro", C.cyan, `  goals: [${task.goals.map(g => `"${g}"`).join(", ")}]`);

      const orch = maestroCore.orchestrate(task.originalUserMessage);
      const { type, estimatedImpact, multiStep } = orch.classification;
      const { riskScore } = orch.risk;

      decision(
        `Task classified as ${type}`,
        `impact=${estimatedImpact.toFixed(2)} multiStep=${multiStep} riskScore=${riskScore.toFixed(2)}`,
      );

      const history = task.context?.["conversationHistory"] as Array<{ user: string; assistant: string }> | undefined;
      if (history?.length) {
        trace("Maestro", C.green, `  ✓ conversationHistory: ${history.length} turn(s)`);
      } else {
        trace("Maestro", C.yellow, `  ⚠ No conversationHistory (expected on turn 1)`);
      }

      const taskId = ctx.runId;
      const brainLLM = roleAdapters['brain'] ?? ctx.llm;

      // ── Step 1: Brain routing call ────────────────────────────────────────
      trace("Maestro", C.cyan, `  Step 1: Brain routing call (max 512 tok, temp 0.1)...`);
      let dec: DecomposeDecision;
      try {
        const { text: decisionJson } = await brainLLM.complete(
          `${BRAIN_DECOMPOSE_SYSTEM}\n\n---\n\n${buildTaskPrompt(task)}`,
          { maxTokens: 512, temperature: 0 },
        );
        trace("Maestro", C.dim, `  Raw routing JSON: ${decisionJson.slice(0, 200)}`);
        dec = parseBrainDecision(decisionJson);
      } catch (err) {
        trace("Maestro", C.yellow, `  ⚠ Brain routing failed (${err}) — falling back to direct:brain`);
        dec = { routing: 'direct', role: 'brain' };
      }

      decision(
        `Brain routing: ${dec.routing.toUpperCase()}${
          dec.routing === 'direct'
            ? ` → ${dec.role}`
            : ` → ${(dec as any).departments?.length ?? 0} departments`
        }`,
        dec.routing === 'direct'
          ? `Brain chose single-role dispatch: ${dec.role}`
          : `Brain decomposed into ${(dec as any).departments?.length ?? 0} parallel departments`,
      );

      // ── Step 2a: Direct routing ───────────────────────────────────────────
      if (dec.routing === 'direct') {
        const role = dec.role;
        trace("Maestro", C.cyan, `  Step 2a [direct]: calling ${role}...`);

        const systemPrompt = getRolePrompt(role as RoleName);
        const taskPrompt   = buildTaskPrompt(task, role);
        const llmForRole   = roleAdapters[role] ?? ctx.llm;

        const { text } = await llmForRole.complete(
          `${systemPrompt}\n\n---\n\n${taskPrompt}`,
          {
            maxTokens: 4096,
            onToken: ctx.emit
              ? (chunk) => ctx.emit!({ type: 'stream:token', taskId, chunk })
              : undefined,
          },
        );

        trace("Maestro", C.cyan, `  LLM returned ${text.length} chars`);
        trace("Maestro", C.dim,  `  Final text[0..120]: "${text.slice(0, 120).replace(/\n/g, "\\n")}…"`);

        if (dec.done_criteria?.length) {
          trace("Maestro", C.yellow, `  Done criteria (${dec.done_criteria.length}):`);
          for (const c of dec.done_criteria) trace("Maestro", C.dim, `    • ${c}`);
        }

        return {
          outputText: text,
          doneCriteria: dec.done_criteria,
          summary: `routing=direct role=${role} type=${type} risk=${riskScore.toFixed(2)}`,
        };
      }

      // ── Step 2b: Decompose — parallel departments ─────────────────────────
      const { departments, synthesis_hint } = dec;
      trace("Maestro", C.cyan, `  Step 2b [decompose]: spawning ${departments.length} departments in parallel...`);
      for (const dept of departments) {
        trace("Maestro", C.cyan, `    • ${dept.head}: "${dept.subtask.slice(0, 80)}"`);
      }

      const deptResults = await Promise.all(
        departments.map(async (dept, i) => {
          const subagentId = `${taskId}_sa${i}`;
          ctx.emit?.({ type: 'subagent:spawned', taskId, subagentId, role: dept.head, task: dept.subtask });
          trace("Maestro", C.dim, `    [${dept.head}] spawned (${subagentId})`);

          try {
            const headSystem = getRolePrompt(dept.head as RoleName);
            const headLLM    = roleAdapters[dept.head] ?? ctx.llm;
            const prompt = [
              headSystem,
              '\n\n---\n\n',
              dept.context ? `## Context\n${dept.context}\n\n` : '',
              `## Subtask\n${dept.subtask}`,
              `\n\n## Original request\n${task.originalUserMessage}`,
            ].join('');

            const { text: output } = await headLLM.complete(prompt, { maxTokens: 8192 });
            ctx.emit?.({ type: 'subagent:done', taskId, subagentId, role: dept.head, ok: true });
            trace("Maestro", C.green, `    [${dept.head}] done — ${output.length} chars`);
            return { head: dept.head, subtask: dept.subtask, output, subagentId, ok: true as const };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            ctx.emit?.({ type: 'subagent:failed', taskId, subagentId, role: dept.head, error });
            trace("Maestro", C.red, `    [${dept.head}] FAILED: ${error}`);
            return { head: dept.head, subtask: dept.subtask, output: '', subagentId, ok: false as const, error };
          }
        }),
      );

      if (deptResults.length === 1) {
        return {
          outputText:   deptResults[0]!.output,
          doneCriteria: dec.done_criteria,
          summary:      `routing=decompose depts=1`,
          subagentRuns: deptResults.map(d => ({
            subagentId: d.subagentId, role: d.head, task: d.subtask,
            status: d.ok ? 'done' : 'failed', outputText: d.output,
            error: 'error' in d ? d.error : undefined,
          })),
        };
      }

      // ── Step 3: Synthesis ─────────────────────────────────────────────────
      trace("Maestro", C.cyan, `  Step 3 [synthesis]: Brain merging ${deptResults.length} outputs...`);
      const synthPrompt = buildSynthesisPrompt(
        task.originalUserMessage,
        deptResults.map(d => ({ head: d.head, subtask: d.subtask, output: d.output })),
        synthesis_hint,
      );

      const { text: synthOutput } = await brainLLM.complete(
        `${getRolePrompt('brain')}\n\n---\n\n${synthPrompt}`,
        {
          maxTokens: 4096,
          onToken: ctx.emit
            ? (chunk) => ctx.emit!({ type: 'stream:token', taskId, chunk })
            : undefined,
        },
      );

      trace("Maestro", C.cyan, `  Synthesis returned ${synthOutput.length} chars`);
      trace("Maestro", C.dim,  `  Synthesis[0..120]: "${synthOutput.slice(0, 120).replace(/\n/g, "\\n")}…"`);

      if (dec.done_criteria?.length) {
        trace("Maestro", C.yellow, `  Done criteria (${dec.done_criteria.length}):`);
        for (const c of dec.done_criteria) trace("Maestro", C.dim, `    • ${c}`);
      }

      return {
        outputText:   synthOutput,
        doneCriteria: dec.done_criteria,
        summary:      `routing=decompose depts=${departments.length}`,
        subagentRuns: deptResults.map(d => ({
          subagentId: d.subagentId, role: d.head, task: d.subtask,
          status: d.ok ? 'done' : 'failed', outputText: d.output,
          error: 'error' in d ? d.error : undefined,
        })),
      };
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const ALL_ROLES = [
  'brain', 'coder_strong', 'coder_cheap', 'utility',
  'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader', 'vision',
] as const;

async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ORCA PIPELINE TRACER — live API run`);
  console.log(`${"═".repeat(72)}\n`);

  trace("Init", C.blue, `Loading settings from: ${SETTINGS_PATH}`);
  const settings = loadSettings();

  // Build per-role LLM services — all backed by TracingLiveAdapter for logging.
  // Mirrors initOrca() in main.ts so the tracer exercises the exact same path.
  const roleAdapters: Partial<Record<string, OrcaLLMService>> = {};
  let brainLLM: OrcaLLMService | null = null;

  if (existsSync(SETTINGS_PATH)) {
    for (const roleName of ALL_ROLES) {
      const roleEntry = settings.roles?.[roleName];
      if (!roleEntry?.providerId || !roleEntry?.model) continue;
      const prov = (settings.providers ?? []).find((p: any) => p.id === roleEntry.providerId);
      if (!prov) continue;
      if (prov.type !== 'ollama' && !(prov as any).apiKey) continue;

      const raw     = buildRawAdapter(prov, roleEntry.model);
      const wrapped = new TracingLiveAdapter(raw, roleName);
      const svc     = createDirectLLMService(wrapped, roleEntry.model, { maxTokens: 8192, temperature: 0.7 });

      roleAdapters[roleName] = svc;
      if (roleName === 'brain') brainLLM = svc;
      trace("Init", C.blue, `  role=${roleName.padEnd(12)} model=${roleEntry.model}  provider=${(prov as any).name ?? prov.type}`);
    }
  }

  // Fallback to OPENROUTER_API_KEY env var when no settings are configured
  if (!brainLLM) {
    const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
    if (!apiKey) throw new Error(
      "No settings.json found and OPENROUTER_API_KEY not set.\n" +
      "Run the Orca app first to configure a provider, or set OPENROUTER_API_KEY.",
    );
    const defaultModel = "qwen/qwen-2.5-72b-instruct";
    const raw     = new OpenAICompatAdapter({ baseUrl: "https://openrouter.ai/api/v1", apiKey, defaultModel });
    const wrapped = new TracingLiveAdapter(raw, "brain");
    brainLLM = createDirectLLMService(wrapped, defaultModel, { maxTokens: 8192, temperature: 0.7 });
    roleAdapters['brain'] = brainLLM;
    trace("Init", C.yellow, `  Fallback: brain → ${defaultModel} via OPENROUTER_API_KEY`);
  }

  const llm = brainLLM;
  trace("Init", C.blue, `Configured ${Object.keys(roleAdapters).length} role adapter(s): ${Object.keys(roleAdapters).join(', ')}`);

  trace("Init", C.blue, "Creating tracing Maestro adapter...");
  const maestro = createTracingMaestro(roleAdapters);

  trace("Init", C.blue, "Creating Pappy QC port (debug trace enabled)...");
  const pappy = createDebugPappyPort();

  trace("Init", C.blue, "Creating Orca runtime...");
  const runtime: OrcaRuntime = createOrcaRuntime({ maestro, llm, pappy, maxRepairPasses: 1 });

  // Subscribe to all non-stream events
  const events: OrcaEvent[] = [];
  const eventTypes: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result", "repair:start", "task:done",
    "stream:token", "stream:reset",
    "subagent:spawned", "subagent:done", "subagent:failed",
  ];
  const unsubs = eventTypes.map(type =>
    runtime.on(type, (e: OrcaEvent) => {
      events.push(e);
      if (e.type === "stream:token") return;  // too noisy

      trace("Event", C.green, `${e.type} → ${JSON.stringify(e)}`);

      if (e.type === "qc:result") {
        const ev = e as OrcaEvent & { verdict?: string; issueCount?: number };
        const verdict = ev.verdict ?? "?";
        const issues  = ev.issueCount ?? 0;
        if (verdict === "PASS" || verdict === "WARN") {
          decision(
            `QC verdict: ${verdict} — output accepted`,
            issues === 0 ? "No issues found by Pappy" : `${issues} minor issue(s) but below failure threshold`,
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
          `Previous attempt failed Pappy QC — re-running task`,
        );
      }
    })
  );

  trace("Init", C.blue, "Creating Benson speaker...");
  const benson = createBenson({ executeTask: runtime.executeTask.bind(runtime) });

  // ── Determine mode ─────────────────────────────────────────────────────
  const cliPrompt = process.argv[2]?.trim();

  if (cliPrompt) {
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
