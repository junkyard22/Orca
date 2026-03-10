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

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import { createBenson } from "@clawde/benson-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createDebugPappyPort,
  deriveFilesChangedFromToolEvents,
  SqliteStore,
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
  OrcaToolService,
  RunRecord,
} from "@clawde/orca-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
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
  LLMMessage as Message,
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

// ── Message detail toggle ─────────────────────────────────────────────────
// Set ORCA_MESSAGES=1 to dump full prompts and responses.
// Unset (or 0) for the normal terse summary view.

const SHOW_MESSAGES = process.env["ORCA_MESSAGES"] === "1";

// System prompts are written to files on first use so the trace stays readable.
// Subsequent calls for the same stage just say "see file" instead of re-printing.
const PROMPT_CACHE_DIR = join(import.meta.dirname ?? ".", "trace-prompts");
const savedSystemByStage = new Map<string, string>(); // stage → file path

function saveSystemPrompt(stage: string, content: string): string {
  if (!existsSync(PROMPT_CACHE_DIR)) mkdirSync(PROMPT_CACHE_DIR, { recursive: true });
  const slug = stage.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(PROMPT_CACHE_DIR, `${slug}-system.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function printMsg(label: string, color: string, text: string) {
  if (!SHOW_MESSAGES) return;
  const bar = "─".repeat(60);
  console.log(`\n${color}┌─ ${label} ${"─".repeat(Math.max(0, 60 - label.length - 3))}${C.reset}`);
  for (const line of text.split("\n")) {
    console.log(`${color}│${C.reset} ${line}`);
  }
  console.log(`${color}└${bar}${C.reset}\n`);
}


// Wraps the live adapter so every call is logged with role, model,
// latency, and token usage — without replacing the real network calls.

let adapterCallCount = 0;

// Track per-stage what we've already printed so repeated content is suppressed.
const shownUserLenByStage = new Map<string, number>();

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

  private printMessages(stage: string, messages: LLMRequest["messages"]) {
    if (!SHOW_MESSAGES) return;
    for (const m of messages) {
      if (m.role === "system") {
        const prevPath = savedSystemByStage.get(stage);
        if (prevPath) {
          // Already saved — just reference the file
          if (SHOW_MESSAGES) {
            const bar = "─".repeat(60);
            console.log(`\n${C.dim}┌─ → ${stage} [system — unchanged] ${"─".repeat(Math.max(0, 55 - stage.length))}${C.reset}`);
            console.log(`${C.dim}│${C.reset} (see ${prevPath})`);
            console.log(`${C.dim}└${bar}${C.reset}\n`);
          }
        } else {
          const filePath = saveSystemPrompt(stage, m.content);
          savedSystemByStage.set(stage, filePath);
          const bar = "─".repeat(60);
          console.log(`\n${C.magenta}┌─ → ${stage} [system → ${filePath}] ${"─".repeat(Math.max(0, 25 - stage.length))}${C.reset}`);
          for (const line of m.content.split("\n")) {
            console.log(`${C.magenta}│${C.reset} ${line}`);
          }
          console.log(`${C.magenta}└${bar}${C.reset}\n`);
        }
      } else if (m.role === "user") {
        const prevLen = shownUserLenByStage.get(stage) ?? 0;
        if (prevLen > 0 && m.content.length > prevLen) {
          printMsg(`→ ${stage} [user — new content]`, C.magenta, m.content.slice(prevLen));
        } else {
          printMsg(`→ ${stage} [user]`, C.magenta, m.content);
        }
        shownUserLenByStage.set(stage, m.content.length);
      } else {
        printMsg(`→ ${stage} [${m.role}]`, C.magenta, m.content);
      }
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;
    const t = Date.now();
    const sys = request.messages.find((m: any) => m.role === "system")?.content ?? "";
    const stage = this.detectStage(sys);

    trace("Adapter", C.magenta, `Call #${callNum}  stage=${stage}  model=${request.model}  msgs=${request.messages.length}`);
    const promptPreview = sys.slice(0, 150).replace(/\n/g, "\\n");
    trace("Adapter", C.dim, `  system[0..150]: "${promptPreview}…"`);
    this.printMessages(stage, request.messages);
    trace("Adapter", C.magenta, `  → calling API...`);

    const response = await this.inner.complete(request);
    const ms = Date.now() - t;
    trace("Adapter", C.magenta,
      `  ← ${ms}ms  ${response.usage?.totalTokens ?? "?"}tok` +
      `  (in=${response.usage?.promptTokens ?? "?"} out=${response.usage?.completionTokens ?? "?"})` +
      `  ${response.content.length} chars`);
    const preview = response.content.slice(0, 120).replace(/\n/g, "\\n");
    trace("Adapter", C.dim, `  content[0..120]: "${preview}…"`);
    printMsg(`← ${stage} [assistant]`, C.green, response.content);
    return response;
  }

  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;
    const t = Date.now();
    const sys = request.messages.find((m: any) => m.role === "system")?.content ?? "";
    const stage = this.detectStage(sys);
    trace("Adapter", C.magenta, `Call #${callNum}  stage=${stage} [stream]  model=${request.model}`);
    this.printMessages(stage, request.messages);

    let tokenCount = 0;
    let streamedContent = "";
    const innerStream = this.inner.stream;
    if (!innerStream) {
      // Fallback to complete if stream is not available
      const response = await this.inner.complete(request);
      onToken(response.content);
      return response;
    }
    const response = await innerStream(request, (chunk) => {
      tokenCount++;
      streamedContent += chunk;
      onToken(chunk);
    });
    const ms = Date.now() - t;
    trace("Adapter", C.magenta, `  ← ${ms}ms  ${tokenCount} chunks  ${response.usage?.totalTokens ?? "?"}tok`);
    printMsg(`← ${stage} [assistant] (stream)`, C.green, streamedContent || response.content);
    return response;
  }
}

// ── Decision logger ───────────────────────────────────────────────────────

function decision(desc: string, reason: string) {
  console.log(`${ts()} ${C.yellow}[Decision   ]${C.reset} ${C.white}${desc}${C.reset}`);
  console.log(`${"".padStart(13)} ${C.dim}Reason: ${reason}${C.reset}`);
}

function normalizeConversationHistory(rawHistory: unknown): Message[] {
  if (!Array.isArray(rawHistory)) return [];

  if (rawHistory.every((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "role" in entry &&
    "content" in entry,
  )) {
    return rawHistory as Message[];
  }

  const normalized: Message[] = [];
  for (const entry of rawHistory) {
    if (!entry || typeof entry !== "object") continue;
    const turn = entry as { user?: unknown; assistant?: unknown };
    if (typeof turn.user === "string" && turn.user.length > 0) {
      normalized.push({ role: "user", content: turn.user });
    }
    if (typeof turn.assistant === "string" && turn.assistant.length > 0) {
      normalized.push({ role: "assistant", content: turn.assistant });
    }
  }

  return normalized;
}

// ── Task prompt builder (mirrors main.ts buildTaskPrompt) ─────────────────

function buildTaskPrompt(task: OrcaTaskSpec, role?: string): string {
  const isRepair = task.intent === "repair";
  const header = isRepair
    ? "## Repair Task\nYou are fixing defects identified in a previous attempt.\n" +
      "Address every issue listed in the context below without changing unrelated behaviour."
    : role ? `## Task\nRole: **${role}**` : "## Task";

  // When the task involves writing a file, put a hard imperative first so
  // even models that skip the system prompt can't miss it.
  const needsFileWrite = /\.[a-z]{2,4}(\s|$)/i.test(task.originalUserMessage);
  const fileWriteDirective = needsFileWrite
    ? "**ACTION REQUIRED: Call write_file to save the file content to disk. Do NOT output the file content inline — use the tool.**\n\n"
    : "";

  const lines: string[] = [
    fileWriteDirective + header, "",
    "### Request", task.originalUserMessage, "",
    "### Goals", ...task.goals.map((g: string) => `- ${g}`),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  const history = normalizeConversationHistory(task.context?.["conversationHistory"]);
  if (history?.length) {
    lines.push(
      "",
      "### History usage",
      "Resolve references like 'it', 'that file', 'the file you just created', and 'same as before' from the conversation history below before deciding what to do.",
    );
    const transcript = history.map((message) => `${String(message.role).toUpperCase()}: ${message.content}`).join("\n\n");
    lines.push("", "### Conversation history", transcript);
  }

  return lines.join("\n");
}

// ── Agent loop helpers (mirrors main.ts) ───────────────────────────────

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseToolCalls(text: string): Array<{ tool: string; input: Record<string, unknown> }> {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  // Strict: closed <tool_call>...</tool_call>
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      const { tool, ...input } = parsed;
      if (typeof tool === 'string' && tool) calls.push({ tool, input });
    } catch {
      // XML-attribute style: TOOLNAME<arg_key>k</arg_key><arg_value>v</arg_value>
      const body = match[1]!;
      const toolNameMatch = /^([\w-]+)/.exec(body.trim());
      if (toolNameMatch) {
        const tool = toolNameMatch[1]!;
        const input: Record<string, unknown> = {};
        const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
        let m: RegExpExecArray | null;
        while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
        if (tool) calls.push({ tool, input });
      }
    }
  }
  // Lenient: unclosed <tool_call> at end of text (some models omit the closing tag)
  if (calls.length === 0) {
    const openTag = '<tool_call>';
    const idx = text.lastIndexOf(openTag);
    if (idx !== -1) {
      const body = text.slice(idx + openTag.length).replace(/<\/tool_call>[\s\S]*$/, '').trim();
      // Try JSON first
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const { tool, ...input } = parsed;
        if (typeof tool === 'string' && tool) calls.push({ tool, input });
      } catch {
        // Try XML-attribute style: <tool_call>tool_name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
        const toolNameMatch = /^([\w-]+)/.exec(body);
        if (toolNameMatch) {
          const tool = toolNameMatch[1]!;
          const input: Record<string, unknown> = {};
          const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
          let m: RegExpExecArray | null;
          while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
          if (tool) calls.push({ tool, input });
        }
      }
    }
  }
  return calls;
}

function fmtToolResult(tool: string, ok: boolean, output: string, error?: string): string {
  const status = ok ? 'ok="true"' : 'ok="false"';
  const body   = ok ? output : (error ?? output ?? 'unknown error');
  return `\n<tool_result tool="${tool}" ${status}>\n${body}\n</tool_result>`;
}

const REACT_PROMPT_BLOCK = `

After receiving a tool result, reason before acting again:

Thought: [what did I just learn? what does it mean for the task?]
Observation: [current state of the task based on everything so far]
Next: [what to do next and why — or "Task is complete" if done]

FILE WRITING — MANDATORY:
If your task involves creating or modifying a file (any filename with an extension, e.g. .ts .js .py .json):
1. Call write_file with the complete file content BEFORE writing your final answer
2. Your FINAL ANSWER must confirm what was written — it must NOT contain the file content itself
3. Never output source code inline as a substitute for calling write_file

CRITICAL RULES:
- Your Thought/Observation/Next blocks are INTERNAL REASONING ONLY
- They must NEVER appear in your final answer to the user
- Never call a tool without a preceding Thought block
- When the task is complete, write your final answer using EXACTLY this format:

FINAL ANSWER:
[your complete response to the user here — no thought blocks, no reasoning, just the answer]

- Everything before FINAL ANSWER: is thinking
- Everything after FINAL ANSWER: is what the user receives
- If you are done and have no tool calls, you MUST use the FINAL ANSWER: marker
`;

function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .trim();
}

function extractFinalAnswer(rawText: string): string | null {
  const marker = 'FINAL ANSWER:';
  const idx = rawText.indexOf(marker);
  if (idx !== -1) {
    return rawText.slice(idx + marker.length).trim();
  }
  return null;
}

function stripThoughtBlocks(text: string): string {
  return text
    .replace(/Thought:.*?(?=\n\n|\nObservation:|\nNext:|\nFINAL ANSWER:|$)/gs, '')
    .replace(/Observation:.*?(?=\n\n|\nThought:|\nNext:|\nFINAL ANSWER:|$)/gs, '')
    .replace(/Next:.*?(?=\n\n|\nThought:|\nObservation:|\nFINAL ANSWER:|$)/gs, '')
    .trim();
}

async function runAgentLoop(
  systemPrompt: string,
  taskPrompt: string,
  tools: OrcaToolService,
  llm: OrcaLLMService,
): Promise<{
  text: string;
  toolEvents: NonNullable<OrcaMaestroResult['toolEvents']>;
  filesChanged: NonNullable<OrcaMaestroResult['filesChanged']>;
}> {
  const MAX_ITER = 10;
  const toolEvents: NonNullable<OrcaMaestroResult['toolEvents']> = [];
  const fullSystemPrompt = `${systemPrompt}${REACT_PROMPT_BLOCK}`;
  let conversation = `${fullSystemPrompt}\n\n${tools.formatForPrompt()}\n\n---\n\n${taskPrompt}`;
  let lastText = '';

  for (let i = 0; i < MAX_ITER; i++) {
    const { text } = await llm.complete(conversation, { maxTokens: 4096 });
    lastText = text;
    const calls = parseToolCalls(text);
    if (calls.length === 0) break;
    trace("Maestro", C.yellow, `  [agentLoop] iteration ${i + 1}: ${calls.length} tool call(s)`);
    conversation += `\n\nAssistant:\n${text}`;
    for (const call of calls) {
      trace("Maestro", C.cyan, `    ➤ tool:${call.tool}  args=${JSON.stringify(call.input).slice(0, 80)}`);
      const result = await tools.execute(call.tool, call.input);
      trace("Maestro", result.ok ? C.green : C.red, `    ← ${result.ok ? 'ok' : 'FAIL'} (${result.output.length} chars)`);
      toolEvents.push({
        tool:    call.tool,
        ok:      result.ok,
        summary: result.ok
          ? `${call.tool}: ok (${result.output.length} chars)`
          : `${call.tool}: failed — ${result.error ?? 'unknown'}`,
        raw: call.input,
      });
      conversation += fmtToolResult(call.tool, result.ok, result.output, result.error);
    }
  }

  const filesChanged = deriveFilesChangedFromToolEvents(toolEvents);

  return {
    text: (() => {
      const cleanedOutput = stripToolCalls(lastText);
      const finalAnswer = extractFinalAnswer(cleanedOutput);
      return finalAnswer || stripThoughtBlocks(cleanedOutput);
    })(),
    toolEvents,
    filesChanged,
  };
}

// ── Tracing Maestro — uses new three-tier agent architecture ──────────────

function createTracingMaestro(
  roleAdapters: Partial<Record<string, OrcaLLMService>>,
  availableToolNames: string[],
  toolService: OrcaToolService,
): MaestroPort {
  const maestroCore = createMaestroCore();

  // Note: The tracer implements the ReAct loop directly instead of using RoleAgentAdapter
  // to avoid circular dependencies and keep the tracer self-contained.

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

      const history = normalizeConversationHistory(task.context?.["conversationHistory"]);
      if (history?.length) {
        trace("Maestro", C.green, `  ✓ conversationHistory: ${history.length} message(s)`);
      } else {
        trace("Maestro", C.yellow, `  ⚠ No conversationHistory (expected on turn 1)`);
      }

      const taskId = ctx.runId;
      const brainLLM = roleAdapters['brain'] ?? ctx.llm;

      // ── Step 1: Brain routing call ────────────────────────────────────────
      trace("Maestro", C.cyan, `  Step 1: Brain routing call (max 512 tok, temp 0.1)...`);
      let dec: DecomposeDecision;
      const brainPrompt = `${BRAIN_DECOMPOSE_SYSTEM}\n\n---\n\n${buildTaskPrompt(task)}`;
      try {
        printMsg("→ Brain [decompose]", C.cyan, brainPrompt);
        const { text: decisionJson } = await brainLLM.complete(
          brainPrompt,
          { maxTokens: 512, temperature: 0 },
        );
        printMsg("← Brain [decompose response]", C.green, decisionJson);
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

      // ── Step 2a: Direct routing with ReAct agent loop ─────────────────────
      if (dec.routing === 'direct') {
        const role = dec.role;
        trace("Maestro", C.cyan, `  Step 2a [direct]: running ${role} agent...`);

        // Emit agent start event
        ctx.emit?.({
          type: 'maestro:agent_start',
          taskId,
          role: role as RoleName,
          doneCriteria: dec.done_criteria || []
        });

        const baseSystemPrompt = getRolePrompt(role as RoleName);
        // Add ReAct system prompt block
        const systemPrompt = `${baseSystemPrompt}${REACT_PROMPT_BLOCK}`;
        const taskPrompt   = buildTaskPrompt(task, role);
        const llmForRole   = roleAdapters[role] ?? ctx.llm;

        // Fix 1: Strip tools for pure generation tasks to prevent exploration
        function isPureGenerationTask(taskText: string): boolean {
          // If task expects file output, always provide tools
          const needsFiles = /write to|save|create file|\.[a-z]{2,4}(\s|$)|add to|implement in/i;
          if (needsFiles.test(taskText)) return false;

          // If task references existing content, provide tools for reading
          const explorationSignals = /existing|current|read|check|look at|find|my (code|file|project)/i;
          if (explorationSignals.test(taskText)) return false;

          // Pure generation — text output only, no files needed
          const generationSignals = /create|implement|write|build|add|generate/i;
          return generationSignals.test(taskText);
        }

        const shouldStripTools = isPureGenerationTask(task.originalUserMessage);
        const toolsForAgent = shouldStripTools ? [] : availableToolNames;
        
        if (shouldStripTools) {
          trace("Maestro", C.yellow, `  Pure generation task detected — stripping tools to prevent exploration`);
        } else {
          trace("Maestro", C.blue, `  Passing ${availableToolNames.length} tools to ${role} agent: ${availableToolNames.join(', ')}`);
        }

        // System prompt: save to file on first use, reference thereafter
        if (SHOW_MESSAGES) {
          const prevPath = savedSystemByStage.get(role);
          if (prevPath) {
            trace("Maestro", C.dim, `  → ${role} [system] — see ${prevPath}`);
          } else {
            const filePath = saveSystemPrompt(role, systemPrompt);
            savedSystemByStage.set(role, filePath);
            printMsg(`→ ${role} [system → ${filePath}]`, C.yellow, systemPrompt);
          }
        }
        printMsg(`→ ${role} [task]`, C.yellow, taskPrompt);

        // Run the ReAct agent loop
        const MAX_ITER = 10;
        const toolEvents: NonNullable<OrcaMaestroResult['toolEvents']> = [];
        const thoughts: NonNullable<NonNullable<OrcaMaestroResult['metadata']>['thoughts']> = [];
        let conversation = `${systemPrompt}\n\n${toolService.formatForPrompt()}\n\n---\n\n${taskPrompt}`;
        let lastText = '';
        let currentOutputText = '';
        let iterationCount = 0;
        let stoppedBecause: 'done' | 'max_iterations' | 'error' = 'max_iterations';
        
        // Tool Use Discipline enforcement
        let cumulativeToolCallCount = 0;
        let toolLimitWarningInjected = false;
        let finalAnswerFound = false;

        try {
          for (let i = 0; i < MAX_ITER; i++) {
            iterationCount = i + 1;
            
            const { text } = await llmForRole.complete(conversation, { maxTokens: 4096 });
            lastText = text;
            
            // Extract Thought/Observation/Next blocks with proper multiline matching
            // Using [\s\S]*? with s flag (dotAll) to match across newlines
            const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?:\n|$)/i);
            const observationMatch = text.match(/Observation:\s*([\s\S]*?)(?:\n|$)/i);
            const nextMatch = text.match(/Next:\s*([\s\S]*?)(?:\n|$)/i);
            
            if (thoughtMatch || observationMatch || nextMatch) {
              const thought = thoughtMatch ? thoughtMatch[1].trim() : "";
              const observation = observationMatch ? observationMatch[1].trim() : "";
              const next = nextMatch ? nextMatch[1].trim() : "";
              thoughts.push({ iteration: iterationCount, thought, observation, next });
              
              // Emit thought event
              ctx.emit?.({
                type: 'maestro:thought',
                taskId,
                iteration: iterationCount,
                thought,
                observation,
                next
              });
              
              trace("Maestro", C.white, `  [Thought] iter=${iterationCount}`);
              if (thought) trace("Maestro", C.dim, `    Thought: ${thought}`);
              if (observation) trace("Maestro", C.dim, `    Observation: ${observation}`);
              if (next) trace("Maestro", C.dim, `    Next: ${next}`);
            } else {
              // Defensive logging: log when thought extraction fails
              trace("Maestro", C.yellow, `  [Thought] No Thought block found in iteration ${iterationCount} — model may have skipped format`);
              trace("Maestro", C.dim, `    Raw output[0..200]: "${text.slice(0, 200).replace(/\n/g, "\\n")}..."`);
            }
            
            // Check for FINAL ANSWER in any response to track if we've found one
            const cleanedOutput = stripToolCalls(text);
            const finalAnswer = extractFinalAnswer(cleanedOutput);
            if (finalAnswer) {
              finalAnswerFound = true;
            }
            
            // Tool Use Discipline: Check if we've hit 3 tool calls without final answer
            if (cumulativeToolCallCount >= 3 && !toolLimitWarningInjected && !finalAnswerFound) {
              // Inject warning message - do NOT execute any more tools this iteration
              toolLimitWarningInjected = true;
              conversation += `\n\nUser: You have reached your 3-tool orientation limit. Do not call any more tools. Your next response must be your final answer.`;
              trace("Maestro", C.yellow, `  [ToolLimit] 3-tool limit reached - warning injected`);
              continue; // Skip tool execution, wait for model's final answer next iteration
            }
            
            // If warning was already injected and this is the next iteration, extract output as final
            if (toolLimitWarningInjected && !finalAnswerFound) {
              // This is the iteration after warning injection - extract whatever we have as final answer
              currentOutputText = stripThoughtBlocks(cleanedOutput);
              stoppedBecause = 'done';
              trace("Maestro", C.yellow, `  [ToolLimit] Forcing output after warning - extracted ${currentOutputText.length} chars`);
              break;
            }
            
            const calls = parseToolCalls(text);

            if (calls.length === 0) {
              if (finalAnswer) {
                currentOutputText = finalAnswer;
                stoppedBecause = 'done';
                break;
              }
              currentOutputText = stripThoughtBlocks(cleanedOutput);
              conversation += `\n\nUser: Your response was not properly formatted. Please use the FINAL ANSWER: marker for your final response, or use tool calls to complete the task.`;
              continue;
            }
            
            trace("Maestro", C.yellow, `  [agentLoop] iteration ${i + 1}: ${calls.length} tool call(s)`);
            conversation += `\n\nAssistant:\n${text}`;
            
            for (const call of calls) {
              trace("Maestro", C.cyan, `    ➤ tool:${call.tool}  args=${JSON.stringify(call.input).slice(0, 80)}`);
              
              // Fix 1 (continued): Block tool execution if tools were stripped for generation task
              if (shouldStripTools && toolsForAgent.length === 0) {
                trace("Maestro", C.red, `    ✗ BLOCKED: Tools stripped for pure generation task`);
                conversation += fmtToolResult(call.tool, false, '', 'Tools unavailable for pure generation task — produce output directly');
                continue;
              }
              
              // Fix 2: write_file content validation guard
              if (call.tool === 'write_file' && typeof call.input.content !== 'string') {
                trace("Maestro", C.red, `    ✗ BLOCKED: write_file requires "content" string parameter`);
                conversation += fmtToolResult(call.tool, false, '', 'write_file requires a "content" string parameter');
                toolEvents.push({
                  tool:    call.tool,
                  ok:      false,
                  summary: `${call.tool}: failed — requires "content" string parameter`,
                  raw: call.input,
                });
                continue;
              }
              
              const result = await toolService.execute(call.tool, call.input);
              trace("Maestro", result.ok ? C.green : C.red, `    ← ${result.ok ? 'ok' : 'FAIL'} (${result.output.length} chars)`);
              
              // Fix 3: Capture file content in tool event for diff verification
              const enrichedRaw = { ...call.input };
              if (result.ok && call.tool === 'write_file' && typeof call.input.content === 'string') {
                // Store content in raw for deriveFilesChangedFromToolEvents to use
                (enrichedRaw as any)._contentForDiff = call.input.content;
              }
              
              toolEvents.push({
                tool:    call.tool,
                ok:      result.ok,
                summary: result.ok
                  ? `${call.tool}: ok (${result.output.length} chars)`
                  : `${call.tool}: failed — ${result.error ?? 'unknown'}`,
                raw: enrichedRaw,
              });
              conversation += fmtToolResult(call.tool, result.ok, result.output, result.error);
              
              // Tool Use Discipline: Increment cumulative counter
              cumulativeToolCallCount++;
            }
          }
        } catch (err) {
          stoppedBecause = 'error';
          trace("Maestro", C.red, `  Agent error: ${err}`);
        }

        // Emit agent done event
        ctx.emit?.({
          type: 'maestro:agent_done',
          taskId,
          role: role as RoleName,
          stoppedBecause,
          iterations: iterationCount
        });

        const text = currentOutputText || (() => {
          const cleanedOutput = stripToolCalls(lastText);
          const finalAnswer = extractFinalAnswer(cleanedOutput);
          return finalAnswer || stripThoughtBlocks(cleanedOutput);
        })();

        trace("Maestro", C.cyan, `  Agent stopped: ${stoppedBecause} after ${iterationCount} iterations`);
        trace("Maestro", C.dim,  `  Final text[0..120]: "${text.slice(0, 120).replace(/\n/g, "\\n")}…"`);
        printMsg(`← ${role} [response]`, C.green, text);

        if (dec.done_criteria?.length) {
          trace("Maestro", C.yellow, `  Done criteria (${dec.done_criteria.length}):`);
          for (const c of dec.done_criteria) trace("Maestro", C.dim, `    • ${c}`);
        }

        const filesChanged = deriveFilesChangedFromToolEvents(toolEvents);

        return {
          outputText: text,
          toolEvents,
          filesChanged,
          doneCriteria: dec.done_criteria,
          summary: `routing=direct role=${role} type=${type} risk=${riskScore.toFixed(2)} iterations=${iterationCount} stopped=${stoppedBecause}`,
          metadata: {
            role,
            thoughts,
            iterationCount,
            stoppedBecause,
            filesChanged,
          },
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
            const headTask   = [
              dept.context ? `## Context\n${dept.context}\n\n` : '',
              `## Subtask\n${dept.subtask}`,
              `\n\n## Original request\n${task.originalUserMessage}`,
            ].join('');

            printMsg(`→ ${dept.head} [task]`, C.yellow, headTask);
            if (SHOW_MESSAGES) {
              const prevPath = savedSystemByStage.get(dept.head);
              if (prevPath) {
                trace("Maestro", C.dim, `  → ${dept.head} [system] — see ${prevPath}`);
              } else {
                const filePath = saveSystemPrompt(dept.head, headSystem);
                savedSystemByStage.set(dept.head, filePath);
                printMsg(`→ ${dept.head} [system → ${filePath}]`, C.yellow, headSystem);
              }
            }

            let output: string;
            const res = await runAgentLoop(headSystem, headTask, toolService, headLLM);
            output = res.text;
            printMsg(`← ${dept.head} [response]`, C.green, output);
            ctx.emit?.({ type: 'subagent:done', taskId, subagentId, role: dept.head, ok: true });
            trace("Maestro", C.green, `    [${dept.head}] done — ${output.length} chars`);
            return {
              head: dept.head,
              subtask: dept.subtask,
              output,
              subagentId,
              ok: true as const,
              toolEvents: res.toolEvents,
              filesChanged: res.filesChanged,
            };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            ctx.emit?.({ type: 'subagent:failed', taskId, subagentId, role: dept.head, error });
            trace("Maestro", C.red, `    [${dept.head}] FAILED: ${error}`);
            return {
              head: dept.head,
              subtask: dept.subtask,
              output: '',
              subagentId,
              ok: false as const,
              error,
              toolEvents: [],
              filesChanged: [],
            };
          }
        }),
      );

      const combinedToolEvents = deptResults.flatMap((result) => result.toolEvents);
      const combinedFilesChanged = deriveFilesChangedFromToolEvents(
        combinedToolEvents,
        deptResults.flatMap((result) => result.filesChanged),
      );

      if (deptResults.length === 1) {
        return {
          outputText:   deptResults[0]!.output,
          toolEvents: combinedToolEvents,
          filesChanged: combinedFilesChanged,
          doneCriteria: dec.done_criteria,
          summary:      `routing=decompose depts=1`,
          metadata: {
            iterationCount: 1,
            stoppedBecause: deptResults[0]!.ok ? 'done' : 'error',
            filesChanged: combinedFilesChanged,
          },
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

      const synthFullPrompt = `${getRolePrompt('brain')}\n\n---\n\n${synthPrompt}`;
      trace("Maestro", C.dim, `  Synthesis prompt length: ${synthFullPrompt.length} chars`);
      printMsg("→ Brain [synthesis]", C.cyan, synthFullPrompt);

      let synthOutput: string;
      try {
        const res = await brainLLM.complete(
          synthFullPrompt,
          {
            maxTokens: 8192,
            onToken: ctx.emit
              ? (chunk) => ctx.emit!({ type: 'stream:token', taskId, chunk })
              : undefined,
          },
        );
        synthOutput = res.text;
      } catch (err) {
        trace("Maestro", C.yellow, `  ✗ Synthesis threw: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }

      trace("Maestro", C.cyan, `  Synthesis returned ${synthOutput.length} chars`);
      trace("Maestro", C.dim,  `  Synthesis[0..120]: "${synthOutput.slice(0, 120).replace(/\n/g, "\\n")}…"`);
      printMsg("← Brain [synthesis response]", C.green, synthOutput);

      if (dec.done_criteria?.length) {
        trace("Maestro", C.yellow, `  Done criteria (${dec.done_criteria.length}):`);
        for (const c of dec.done_criteria) trace("Maestro", C.dim, `    • ${c}`);
      }

      return {
        outputText:   synthOutput,
        toolEvents: combinedToolEvents,
        filesChanged: combinedFilesChanged,
        doneCriteria: dec.done_criteria,
        summary:      `routing=decompose depts=${departments.length}`,
        metadata: {
          role: 'brain',
          iterationCount: 1,
          stoppedBecause: 'done',
          filesChanged: combinedFilesChanged,
        },
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

  const toolRegistry = createCoreToolRegistry();
  const availableToolNames = toolRegistry.list().map((tool) => tool.name);
  trace("Init", C.blue, `Tool registry ready: ${availableToolNames.length} tools — ${availableToolNames.join(', ')}`);

  // Resolve workspace root: two dirs up from apps/desktop → monorepo root
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');

  const toolService: OrcaToolService = {
    execute(name, input) {
      const tool = toolRegistry.get(name);
      if (!tool) return Promise.resolve({
        ok: false, output: '',
        error: `Unknown tool: "${name}". Available: ${toolRegistry.list().map(t => t.name).join(', ')}`,
      });
      return tool.execute(input, { workspaceRoot, runId: '' });
    },
    formatForPrompt() {
      return `Workspace root: ${workspaceRoot}\n\n${toolRegistry.formatForPrompt()}`;
    },
  };

  trace("Init", C.blue, "Creating tracing Maestro adapter...");
  const maestro = createTracingMaestro(roleAdapters, availableToolNames, toolService);

  trace("Init", C.blue, "Creating Pappy QC port (debug trace enabled)...");
  const pappy = createDebugPappyPort();

  trace("Init", C.blue, "Creating Orca runtime...");
  
  // Create SQLite store for persistence (fallback path for CLI)
  const store = new SqliteStore(
    path.join(process.env["HOME"] || process.env["USERPROFILE"] || "", ".orca", "runs.db")
  );
  
  const runtime: OrcaRuntime = createOrcaRuntime({ maestro, llm, pappy, maxRepairPasses: 1, tools: toolService, store });

  // Subscribe to all non-stream events
  const events: OrcaEvent[] = [];
  const eventTypes: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result", "repair:start", "task:done",
    "stream:token", "stream:reset",
    "subagent:spawned", "subagent:done", "subagent:failed",
    "maestro:thought", "maestro:agent_start", "maestro:agent_done",
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

      if (e.type === "maestro:agent_start") {
        const ev = e as OrcaEvent & { role: string; doneCriteria: string[] };
        trace("Agent", C.cyan, `${ev.role} started  criteria=${ev.doneCriteria?.length ?? 0}`);
      }

      if (e.type === "maestro:thought") {
        const ev = e as OrcaEvent & { iteration: number; thought: string; observation: string; next: string };
        console.log(`${ts()} ${C.white}[Thought   ]${C.reset} iter=${ev.iteration}`);
        if (ev.thought) console.log(`${"".padStart(13)} ${C.dim}Thought: ${ev.thought}${C.reset}`);
        if (ev.observation) console.log(`${"".padStart(13)} ${C.dim}Observation: ${ev.observation}${C.reset}`);
        if (ev.next) console.log(`${"".padStart(13)} ${C.dim}Next: ${ev.next}${C.reset}`);
      }

      if (e.type === "maestro:agent_done") {
        const ev = e as OrcaEvent & { role: string; stoppedBecause: string; iterations: number; loopEvidence?: { repeatedCall: string; occurrences: number } };
        if (ev.stoppedBecause === 'loop_detected') {
          console.error(`${ts()} ${C.red}[Agent     ]${C.reset} ⚠ LOOP DETECTED — ${ev.role} stopped at iteration ${ev.iterations}`);
          if (ev.loopEvidence) {
            console.error(`${"".padStart(20)} ${C.dim}Repeated: ${ev.loopEvidence.repeatedCall} × ${ev.loopEvidence.occurrences}${C.reset}`);
          }
        } else {
          trace("Agent", C.green, `${ev.role} done  stopped=${ev.stoppedBecause}  iterations=${ev.iterations}`);
        }
      }

      if (e.type === "task:done") {
        const ev = e as OrcaEvent & { taskId: string; status: "SUCCESS" | "FAIL" };
        // Persist confirmation will be shown after the store.saveRun call
        // which happens internally in the runtime after this event
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

    // Print persist confirmation
    const lastRun = (await store.getRecentRuns(1))[0] as RunRecord | undefined;
    if (lastRun) {
      console.log(`${ts()} ${C.blue}[Persist   ]${C.reset} run saved → ${lastRun.id}  verdict=${lastRun.verdict ?? lastRun.status}  iterations=${lastRun.iterationCount ?? '?'}`);
    }

    // Print run history
    console.log(`\n${C.cyan}─── Run History ${"─".repeat(48)}${C.reset}`);
    const recentRuns = await store.getRecentRuns(5) as RunRecord[];
    for (const run of recentRuns) {
      const cost = run.costUsd ? `  $${run.costUsd.toFixed(4)}` : '';
      const verdict = run.verdict ?? (run.status === "SUCCESS" ? "PASS" : "FAIL");
      const intent = run.intent.length > 40 ? run.intent.slice(0, 40) + "..." : run.intent;
      console.log(`  ${run.id}  ${verdict}  "${intent}"  ${run.iterationCount ?? '?'} iter${cost}`);
    }
    console.log(`${"─".repeat(64)}\n`);

    unsubs.forEach(u => u());
    store.close();
    return;
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
          store.close();
          rl.close();
          return;
        }

        console.log(`\n${"─".repeat(72)}\n`);
        trace("Prompt", C.white, `"${msg}"`);
        console.log(`${"─".repeat(72)}\n`);
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
  process.exitCode = 1;
});
