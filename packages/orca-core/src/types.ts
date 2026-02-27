import type { PappyInput, PappyResult } from "@clawde/pappy-core";

// ---------------------------------------------------------------------------
// Task / result shapes
//
// Defined here in orca-core, NOT imported from benson-core.
// Benson depends on orca-core (by receiving executeTask at construction time).
// orca-core must never depend on Benson — keeps the speaker swappable.
//
// These interfaces are structurally compatible with benson-core's TaskSpec
// and ExecutionResult so TypeScript's structural typing handles wiring
// in the app shell without an explicit import.
// ---------------------------------------------------------------------------

export interface OrcaTaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface OrcaExecutionResult {
  status: "SUCCESS" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
}

// ---------------------------------------------------------------------------
// What Maestro returns to orca-core after running a task.
// Richer than Maestro's own PodMember.Result so Pappy can evaluate it fully.
// ---------------------------------------------------------------------------

export interface OrcaMaestroResult {
  outputText?: string;
  summary?: string;
  filesChanged?: Array<{ path: string; changeType: "A" | "M" | "D"; diff?: string }>;
  toolEvents?: Array<{ tool: string; ok: boolean; summary: string; raw?: unknown }>;
}

// ---------------------------------------------------------------------------
// Run context passed to Maestro on each call.
// Contains everything Maestro needs without coupling to any specific impl.
// ---------------------------------------------------------------------------

export interface OrcaLLMService {
  /**
   * Generate text for a prompt.
   * Implemented using Miranda's pipeline (PLAN→ANSWER→CRITIQUE→REWRITE)
   * so Maestro never calls a model directly.
   */
  complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<{ text: string }>;
}

export interface OrcaRunCtx {
  llm: OrcaLLMService;
  runId: string;
}

// ---------------------------------------------------------------------------
// Port interfaces — what orca-core needs; concrete implementations live
// in adapters/ (or can be custom-built in the app shell).
// ---------------------------------------------------------------------------

export interface MaestroPort {
  /**
   * Run a task end-to-end.
   * ctx.llm is Miranda-backed so Maestro never calls models directly.
   */
  run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult>;
}

export interface PappyPort {
  /**
   * Evaluate Maestro's output. Pure, synchronous, deterministic.
   * Uses pappy-core's PappyInput/PappyResult shapes directly.
   */
  evaluate(input: PappyInput): PappyResult;
}

// ---------------------------------------------------------------------------
// Runtime API
// ---------------------------------------------------------------------------

export interface OrcaRuntimeDeps {
  maestro: MaestroPort;
  pappy: PappyPort;
  llm: OrcaLLMService;
  /** Maximum repair passes before giving up on a FAIL verdict. Default: 2 */
  maxRepairPasses?: number;
}

export interface OrcaRuntime {
  executeTask(taskSpec: OrcaTaskSpec): Promise<OrcaExecutionResult>;
  /** Subscribe to internal progress events. Returns an unsubscribe fn. */
  on(eventType: OrcaEventType, handler: (e: OrcaEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type OrcaEventType = OrcaEvent["type"];

export type OrcaEvent =
  | { type: "task:start";    intent: string }
  | { type: "maestro:start" }
  | { type: "maestro:done";  hasOutput: boolean }
  | { type: "qc:result";     verdict: "PASS" | "WARN" | "FAIL"; issueCount: number }
  | { type: "repair:start";  pass: number; maxPasses: number }
  | { type: "task:done";     status: "SUCCESS" | "FAIL" };
