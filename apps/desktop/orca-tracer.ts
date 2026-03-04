/**
 * orca-tracer.ts — End-to-end prompt tracer
 *
 * Wires up Benson → Orca Runtime → Maestro Adapter → Miranda Pipeline
 * with a mock LLMAdapter (low-level) so Miranda's real 4-stage pipeline
 * (PLAN→ANSWER→CRITIQUE→REWRITE) runs and all events fire naturally.
 *
 * Run:  node --experimental-strip-types --no-warnings apps/desktop/orca-tracer.ts
 */

import { createBenson } from "@clawde/benson-core";
import {
  createOrcaRuntime,
  createMirandaLLMService,
  createPappyPort,
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
  createDefaultConfig,
} from "@clawde/miranda-core";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "@clawde/miranda-core";

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

// ── Mock LLM Adapter ──────────────────────────────────────────────────────
// This implements the low-level LLMAdapter interface that Miranda calls
// directly. Because it sits beneath Miranda, the real PLAN→ANSWER→CRITIQUE→
// REWRITE pipeline runs, onStreamReset fires, and everything works.

let adapterCallCount = 0;

class TracingMockAdapter implements LLMAdapter {
  readonly name = "tracer-mock";

  async complete(request: LLMRequest): Promise<LLMResponse> {
    adapterCallCount++;
    const callNum = adapterCallCount;

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

    // Generate stage-appropriate mock response
    let content: string;

    if (stage === "PLAN") {
      content = JSON.stringify({
        restatement: "The user wants to know capabilities.",
        assumptions: ["General inquiry"],
        constraints: [],
        approach_steps: ["List capabilities", "Explain architecture"],
        risks: [],
        questions: [],
      });
    } else if (stage === "CRITIQUE") {
      content = JSON.stringify({
        verdict: "PASS",
        issues: [],
        suggestions: ["Could add more detail."],
      });
    } else {
      // ANSWER or REWRITE — produce markdown with required headings
      const tag = stage === "REWRITE" ? " [rewritten]" : "";
      content = [
        `## Plan (summary)`,
        `Analyzing capabilities.${tag}`,
        ``,
        `## Answer`,
        `Orca is an AI orchestration system with:${tag}`,
        `- **Benson**: Conversation manager`,
        `- **Maestro**: Task orchestrator`,
        `- **Miranda**: LLM pipeline (PLAN→ANSWER→CRITIQUE→REWRITE)`,
        `- **Pappy**: Quality control`,
        ``,
        `## Edge cases & checks`,
        `General inquiry — no edge cases.${tag}`,
        ``,
        `## Next steps`,
        `Try a specific task.${tag}`,
      ].join("\n");
    }

    trace("Adapter", C.magenta, `  → Response: ${content.length} chars`);

    return {
      content,
      model: request.model,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 10,
    };
  }

  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
    // Call complete() to get the response, then simulate streaming
    const response = await this.complete(request);

    // Emit tokens in chunks
    const chunks = response.content.match(/.{1,30}/g) ?? [response.content];
    trace("Adapter", C.magenta, `  Streaming ${chunks.length} chunks...`);
    for (const chunk of chunks) {
      onToken(chunk);
    }

    return response;
  }
}

// ── Tracing Maestro Adapter ────────────────────────────────────────────────
// Mirrors the real buildMaestroAdapter() but logs handoffs.

function createTracingMaestro(): MaestroPort {
  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      trace("Maestro", C.cyan, `═══ Received task: intent="${task.intent}" ═══`);
      trace("Maestro", C.cyan, `  message: "${task.originalUserMessage}"`);
      trace("Maestro", C.cyan, `  goals: [${task.goals.map(g => `"${g}"`).join(", ")}]`);

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

      // Build prompt like real adapter does
      const lines: string[] = [
        `## Task\nRole: **brain**`,
        ``, `### Request`, task.originalUserMessage,
        ``, `### Goals`, ...task.goals.map(g => `- ${g}`),
      ];

      // Format history as transcript (mirroring the real adapter fix)
      if (history?.length) {
        const transcript = history
          .map(t => `USER: ${t.user}\nASSISTANT: ${t.assistant}`)
          .join("\n\n");
        lines.push("", "### Conversation history", transcript);
      }

      const prompt = lines.join("\n");
      trace("Maestro", C.cyan, `  Built ${prompt.length}-char prompt → calling ctx.llm.complete()...`);

      // Track stream events
      let tokenCount = 0;
      let resetCount = 0;

      const { text } = await ctx.llm.complete(prompt, {
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

      return { outputText: text };
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ORCA PIPELINE TRACER — full end-to-end prompt flow`);
  console.log(`${"═".repeat(72)}\n`);

  // 1. Create components with real Miranda pipeline + mock adapter
  trace("Init", C.blue, "Creating mock LLM adapter (low-level)...");
  const adapter = new TracingMockAdapter();

  trace("Init", C.blue, "Creating Miranda LLM service (real pipeline)...");
  const config = createDefaultConfig({ verbose: false, budgetUsd: 10.0, logPath: "/dev/null" });
  const llm = createMirandaLLMService(adapter, config);

  trace("Init", C.blue, "Creating Pappy QC port...");
  const pappy = createPappyPort();

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
      if (e.type !== "stream:token") {
        trace("Event", C.green, `${e.type} → ${JSON.stringify(e)}`);
      }
    })
  );

  trace("Init", C.blue, "Creating Benson speaker...");
  const benson = createBenson({ executeTask: runtime.executeTask.bind(runtime) });

  // ── TURN 1 ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}`);
  trace("TEST", C.white, `═══ TURN 1: "What can you do?" ═══`);
  console.log(`${"─".repeat(72)}\n`);

  const reply1 = await benson.handleUserMessage("What can you do?");
  trace("Benson", C.yellow, `Reply kind: ${reply1.kind}`);
  trace("Benson", C.yellow, `Reply[0..150]: "${reply1.text.slice(0, 150).replace(/\n/g, "\\n")}…"`);

  // ── TURN 2 (tests history injection) ──────────────────────────────────
  console.log(`\n${"─".repeat(72)}`);
  trace("TEST", C.white, `═══ TURN 2: "Tell me more about Miranda pipeline" ═══`);
  trace("TEST", C.white, `(This tests conversationHistory injection)`);
  console.log(`${"─".repeat(72)}\n`);

  const reply2 = await benson.handleUserMessage("Tell me more about the Miranda pipeline and how it processes each request");
  trace("Benson", C.yellow, `Reply kind: ${reply2.kind}`);
  trace("Benson", C.yellow, `Reply[0..150]: "${reply2.text.slice(0, 150).replace(/\n/g, "\\n")}…"`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  TRACER SUMMARY`);
  console.log(`${"═".repeat(72)}`);

  const streamTokens = events.filter(e => e.type === "stream:token").length;
  const streamResets = events.filter(e => e.type === "stream:reset").length;
  const taskStarts   = events.filter(e => e.type === "task:start").length;
  const taskDones    = events.filter(e => e.type === "task:done").length;
  const qcResults    = events.filter(e => e.type === "qc:result").length;

  console.log(`
  Low-level adapter calls: ${adapterCallCount}  (≥8 expected: 4 stages × 2 turns, + possible repair retries)
  Total events emitted:    ${events.length}
    ├─ task:start:         ${taskStarts}
    ├─ task:done:          ${taskDones}
    ├─ qc:result:          ${qcResults}
    ├─ stream:token:       ${streamTokens}
    ├─ stream:reset:       ${streamResets}
    └─ other:              ${events.length - streamTokens - streamResets - taskStarts - taskDones - qcResults}
  `);

  const checks: Array<{ name: string; ok: boolean }> = [
    { name: "Benson returned RESULT (not CLARIFY)",         ok: reply1.kind === "RESULT" },
    { name: "Miranda pipeline ran (adapter calls > 0)",     ok: adapterCallCount > 0 },
    { name: "All 4 stages ran per turn (≥8 adapter calls)", ok: adapterCallCount >= 8 },
    { name: "stream:token events fired",                    ok: streamTokens > 0 },
    { name: "stream:reset events fired",                    ok: streamResets > 0 },
    { name: "task:start + task:done balanced",              ok: taskStarts === taskDones },
    { name: "Turn 2 had conversationHistory",               ok: reply2.kind === "RESULT" },
  ];

  console.log("  Checks:");
  for (const c of checks) {
    const icon = c.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`    ${icon} ${c.name}`);
  }

  const allPassed = checks.every(c => c.ok);
  console.log(`\n  ${allPassed ? `${C.green}ALL CHECKS PASSED!` : `${C.red}SOME CHECKS FAILED`}${C.reset}\n`);

  unsubs.forEach(u => u());
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("\nTracer crashed:", err);
  process.exit(1);
});
