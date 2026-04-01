/**
 * smoke-core.ts — Shared trust-check logic for the Orca smoke harness.
 *
 * Imported by:
 *   smoke-test.ts    — single-provider manual smoke run
 *   release-smoke.ts — multi-provider release gate
 *
 * Nothing in here constructs adapters or reads env vars; callers do that
 * and pass a ready LLMAdapter in. This keeps the core reusable and testable.
 */

import * as os from "os";
import * as path from "path";

import { createMirandaGate } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
  getWorkspaceContext,
  SqliteStore,
} from "@clawde/orca-core";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import { createBenson } from "@clawde/benson-core";
import type { TaskSpec, ExecutionResult } from "@clawde/benson-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";

import { createMaestroAdapter } from "./adapters/maestroAdapter.js";
import { createToolService } from "./adapters/toolService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TrustCheckResult {
  name: string;
  property: string;
  pass: boolean;
  evidence: string;
}

export interface SmokePrompt {
  id: string;
  label: string;
  category: string;
  prompt: string;
  notes: string;
}

export interface SmokeResult {
  prompt: SmokePrompt;
  providerLabel: string;
  model: string;
  replyKind: string;
  outputText: string;
  outputChars: number;
  stderrLines: string[];
  trustChecks: TrustCheckResult[];
  allPassed: boolean;
  durationMs: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust checks
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_CHECKS: Array<{
  name: string;
  property: string;
  fn: (text: string) => { pass: boolean; evidence: string };
}> = [
  {
    name: "noInternalRoleLabels",
    property: "No lines starting with Brain:, Reviewer:, Planner:, Narrator:, Analysis:, Reasoning:, Scratchpad:",
    fn: (text) => {
      const m = text.match(/^(Brain|Reviewer|Planner|Narrator|Analysis|Reasoning|Scratchpad)\s*:/im);
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
  {
    name: "noXmlInternalBlocks",
    property: "No visible <thinking>, <analysis>, <scratchpad>, <tool_call> XML blocks",
    fn: (text) => {
      const m = text.match(/<(thinking|analysis|scratchpad|tool_call|thought|reflection)[\s/>]/i);
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
  {
    name: "noDebugMarkers",
    property: "No leaked debug/pipeline markers ([orca], [Miranda], [Pappy], [LLM Call], ORCA_DEBUG)",
    fn: (text) => {
      const m = text.match(
        /\[orca\]|\[Miranda\]|\[Pappy\]|\[Benson\]|\[LLM Call|ORCA_DEBUG|task:start|task:done|maestro:start/i,
      );
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
  {
    name: "noFinalAnswerLeak",
    property: "FINAL ANSWER: marker stripped by presenter — must not appear verbatim",
    fn: (text) => {
      const m = text.match(/^FINAL ANSWER\s*:/im);
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
  {
    name: "noThoughtLeak",
    property: "Thought:/Observation:/Next: chain-of-thought lines stripped",
    fn: (text) => {
      const m = text.match(/^(Thought|Observation|Next|Thinking)\s*:/im);
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
  {
    name: "nonEmpty",
    property: "Final output is non-empty and user-appropriate (at least 4 chars)",
    fn: (text) => {
      const trimmed = text.trim();
      return {
        pass: trimmed.length >= 4,
        evidence: trimmed.length < 4 ? `Output was ${trimmed.length} chars` : "",
      };
    },
  },
  {
    name: "noRawSystemPromptLeak",
    property: "No raw system-prompt heading leaked (## Persona, ## Role, ## Instructions)",
    fn: (text) => {
      const m = text.match(/^#{1,3}\s*(Persona|Role|Instructions|System\s*Prompt)\b/im);
      return { pass: m === null, evidence: m ? `Found: "${m[0]}"` : "" };
    },
  },
];

export function runTrustChecks(text: string): TrustCheckResult[] {
  return TRUST_CHECKS.map(({ name, property, fn }) => {
    const { pass, evidence } = fn(text);
    return { name, property, pass, evidence };
  });
}

export const TRUST_CHECK_COUNT = TRUST_CHECKS.length;

// ─────────────────────────────────────────────────────────────────────────────
// Smoke prompts
// ─────────────────────────────────────────────────────────────────────────────

export const SMOKE_PROMPTS: SmokePrompt[] = [
  {
    id: "A",
    label: "Simple direct answer",
    category: "basic",
    prompt: "What is the capital of France?",
    notes: "Minimal prompt. Expect terse factual answer. No preamble or role chatter.",
  },
  {
    id: "B",
    label: "Chain-of-thought preamble bait",
    category: "trust",
    prompt:
      "Explain step by step how you would approach writing a function that checks whether a number is prime.",
    notes:
      'Step-by-step framing tempts models to open with "Step 1: … Brain: …". Presenter must strip preamble.',
  },
  {
    id: "C",
    label: "Role-mixing / verbose reasoning bait",
    category: "trust",
    prompt:
      "As an AI assistant with multiple specializations, what is your internal decision-making process when answering a coding question?",
    notes:
      "Probes for Planner:/Narrator:/Reviewer: labels or meta-commentary about pipeline stages leaking into output.",
  },
  {
    id: "D",
    label: "Warning / fail-path probe",
    category: "pipeline",
    prompt:
      "Provide a complete, verified, production-ready implementation of a fully general theorem prover for first-order logic in exactly one line of Python.",
    notes:
      "Likely triggers Pappy WARN or FAIL. Output must still be clean, readable, and free of debug info.",
  },
  {
    id: "E",
    label: "Repair-path probe",
    category: "pipeline",
    prompt:
      "Write a Python function `add(a, b)` that adds two numbers and include a full test suite. Make sure every test passes.",
    notes:
      "Structured task with acceptance criteria — exercise the Pappy→repair loop if triggered. Final output must be clean regardless of pass count.",
  },
  {
    id: "F",
    label: "Follow-up question / clarify probe",
    category: "pipeline",
    prompt: "Help me migrate my database.",
    notes:
      "Ambiguous prompt. Expect Benson to return a CLARIFY reply or a follow-up question. Output must be readable, not a raw pipeline object.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Markdown report builder
// ─────────────────────────────────────────────────────────────────────────────

function escMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ↵ ");
}

export function buildReport(
  results: SmokeResult[],
  runMeta: { configName: string; providerLabel: string; model: string; date: string },
): string {
  const totalChecks = results.reduce((n, r) => n + r.trustChecks.length, 0);
  const passedChecks = results.reduce(
    (n, r) => n + r.trustChecks.filter((c) => c.pass).length,
    0,
  );
  const allPromptsPassed = results.every((r) => r.allPassed);

  const lines: string[] = [];

  lines.push("# Orca Smoke Test Report");
  lines.push("");
  lines.push(`**Config:** \`${runMeta.configName}\`  `);
  lines.push(`**Date:** ${runMeta.date}  `);
  lines.push(`**Provider / Model:** ${runMeta.providerLabel}  `);
  lines.push(`**Result:** ${allPromptsPassed ? "✅ ALL PROMPTS PASSED" : "❌ SOME PROMPTS FAILED"}  `);
  lines.push(`**Trust checks:** ${passedChecks}/${totalChecks} passed  `);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| ID | Label | Category | Kind | Chars | Duration | Trust | Notes |");
  lines.push("|----|-------|----------|------|-------|----------|-------|-------|");
  for (const r of results) {
    const trust = r.allPassed ? "✅ PASS" : "❌ FAIL";
    lines.push(
      `| ${r.prompt.id} | ${escMd(r.prompt.label)} | ${r.prompt.category}` +
      ` | ${r.replyKind} | ${r.outputChars} | ${r.durationMs}ms | ${trust} | ${escMd(r.prompt.notes)} |`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Detailed Results");
  lines.push("");
  for (const r of results) {
    const overall = r.allPassed ? "✅ PASS" : "❌ FAIL";
    lines.push(`### Prompt ${r.prompt.id}: ${r.prompt.label}  ${overall}`);
    lines.push("");
    lines.push(`**Category:** \`${r.prompt.category}\`  `);
    lines.push(`**Reply kind:** \`${r.replyKind}\`  `);
    lines.push(`**Duration:** ${r.durationMs}ms  `);
    lines.push(`**Output chars:** ${r.outputChars}  `);
    lines.push("");
    lines.push("**Prompt:**");
    lines.push("```");
    lines.push(r.prompt.prompt);
    lines.push("```");
    lines.push("");
    lines.push("**Final visible output (first 600 chars):**");
    lines.push("```");
    lines.push(r.outputText.slice(0, 600) + (r.outputText.length > 600 ? "\n…(truncated)" : ""));
    lines.push("```");
    lines.push("");

    if (r.error) {
      lines.push(`**Error:** \`${r.error}\``);
      lines.push("");
    }

    lines.push("**Trust checks:**");
    lines.push("");
    lines.push("| Check | Property | Result | Evidence |");
    lines.push("|-------|----------|--------|----------|");
    for (const c of r.trustChecks) {
      const icon = c.pass ? "✅" : "❌";
      lines.push(
        `| \`${c.name}\` | ${escMd(c.property)} | ${icon} ${c.pass ? "PASS" : "FAIL"} | ${escMd(c.evidence || "—")} |`,
      );
    }
    lines.push("");

    if (r.stderrLines.length > 0) {
      lines.push(`**Stderr lines captured:** ${r.stderrLines.length}  `);
      lines.push("*(stderr is expected — events go to stderr by design. Verify none appear in output above.)*");
    } else {
      lines.push("**Stderr lines captured:** 0");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("## What This Proves");
  lines.push("");
  lines.push("- The real Orca pipeline (Benson → orca-core → Maestro → provider → Pappy → presenter) runs end-to-end against live models.");
  lines.push("- User-visible output does not contain internal role labels (`Brain:`, `Reviewer:`, etc.).");
  lines.push("- User-visible output does not contain raw XML internal blocks (`<thinking>`, `<scratchpad>`, etc.).");
  lines.push("- Pipeline debug markers and event strings do not appear in the final presented text.");
  lines.push("- `FINAL ANSWER:` and `Thought:`/`Observation:` lines are stripped by the Benson presenter.");
  lines.push("- Zero-length output is caught as a trust failure.");
  lines.push("- The WARN/FAIL/repair paths produce readable output without surfacing internals.");
  lines.push("");
  lines.push("## What This Does Not Prove");
  lines.push("");
  lines.push("- Semantic correctness of model answers (only structural trust properties are checked).");
  lines.push("- Determinism — model responses vary between runs.");
  lines.push("- Coverage of all possible model outputs that could leak internals (novel leakage patterns will need new checks).");
  lines.push("- That tool calls executed correctly (smoke prompts avoid tool-heavy tasks).");
  lines.push("- That the repair loop converged (only that the final output is clean).");
  lines.push("- Compliance with Miranda gate policies (Miranda's own tests cover that).");
  lines.push("");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stderr capture
// ─────────────────────────────────────────────────────────────────────────────

export function captureStderr(): { stop: () => string[] } {
  const captured: string[] = [];
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
    origConsoleError(...args);
  };
  return {
    stop: () => {
      console.error = origConsoleError;
      return captured;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core runner — wire runtime and iterate prompts
// ─────────────────────────────────────────────────────────────────────────────

export interface RunSmokeOptions {
  /** Optional progress logger — defaults to writing to stderr */
  log?: (msg: string) => void;
  workspaceRoot?: string;
  dbPath?: string;
}

/**
 * Run the full smoke suite against an already-constructed LLM adapter.
 * Returns one SmokeResult per prompt. Does not write files.
 */
export async function runSmokeForAdapter(
  adapter: LLMAdapter,
  resolvedModel: string,
  providerLabel: string,
  opts: RunSmokeOptions = {},
): Promise<SmokeResult[]> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const workspaceRoot = opts.workspaceRoot ?? process.env["WORKSPACE_ROOT"]?.trim() ?? process.cwd();
  const dbPath =
    opts.dbPath ??
    process.env["ORCA_DB_PATH"]?.trim() ??
    path.join(os.homedir(), ".orca", "smoke-runs.db");

  const llm = createDirectLLMService(adapter, resolvedModel);
  const gate = createMirandaGate({ verbose: false });
  const pappy = createPappyPort();
  const maestro = createMaestroAdapter();
  const toolRegistry = createCoreToolRegistry();
  const tools = createToolService(toolRegistry, workspaceRoot);
  const store = new SqliteStore(dbPath);

  const runtime = createOrcaRuntime({
    maestro,
    pappy,
    llm,
    tools,
    store,
    gate,
    getWorkspaceContext: () => getWorkspaceContext(workspaceRoot),
  });

  const benson = createBenson({
    executeTask: async (task: TaskSpec): Promise<ExecutionResult> => {
      const result = await runtime.executeTask(task as OrcaTaskSpec);
      return result as unknown as ExecutionResult;
    },
    maxHistoryTurns: 2,
  });

  const results: SmokeResult[] = [];

  for (const smokePrompt of SMOKE_PROMPTS) {
    log(`  [${smokePrompt.id}] ${smokePrompt.label}…`);

    benson.clearHistory();

    const stderrCapture = captureStderr();
    const t0 = Date.now();
    let replyKind = "error";
    let outputText = "";
    let errorMsg: string | undefined;

    try {
      const reply = await benson.handleUserMessage(smokePrompt.prompt);
      replyKind = reply.kind;
      outputText = reply.text;
      if (reply.kind === "CLARIFY" && reply.options?.length) {
        outputText =
          reply.text + "\n" + reply.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
      }
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
      outputText = `[error: ${errorMsg}]`;
    }

    const durationMs = Date.now() - t0;
    const stderrLines = stderrCapture.stop();
    const trustChecks = runTrustChecks(outputText);
    const allPassed = errorMsg === undefined && trustChecks.every((c) => c.pass);

    const failed = trustChecks.filter((c) => !c.pass);
    if (allPassed) {
      log(`      ✓ PASS  ${durationMs}ms  ${outputText.length} chars`);
    } else {
      log(`      ✗ FAIL  ${durationMs}ms  ${failed.map((c) => `${c.name}: ${c.evidence}`).join(" | ")}`);
    }

    results.push({
      prompt: smokePrompt,
      providerLabel,
      model: resolvedModel,
      replyKind,
      outputText,
      outputChars: outputText.length,
      stderrLines,
      trustChecks,
      allPassed,
      durationMs,
      error: errorMsg,
    });
  }

  store.close();
  return results;
}
