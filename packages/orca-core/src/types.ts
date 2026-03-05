import type { PappyInput, PappyResult } from "@clawde/pappy-core";
import type { MirandaGate } from "@clawde/miranda-core";
import type { WorkspaceContext } from "./workspaceContext.js";
import type { RunStore } from "./persistence/types.js";

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

export type OutputFormat = "code" | "diff" | "json" | "prose";

export interface TaskPermissions {
  fileRead:     boolean;
  fileWrite:    boolean;
  shellExec:    boolean;
  toolsAllowed: string[];
}

export interface OrcaTaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions?: TaskPermissions;
  outputFormat?: OutputFormat;
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
  /**
   * Acceptance criteria Brain defined for this task.
   * Passed to Pappy so it can enforce them instead of deriving generic ones.
   */
  doneCriteria?: string[];
  /** Populated when Maestro decomposed the task into parallel subagents (Phase 2). */
  subagentRuns?: Array<{
    subagentId: string;
    role: string;
    task: string;
    status: "done" | "failed";
    outputText?: string;
    error?: string;
  }>;
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
   *
   * Pass `onToken` to receive incremental chunks as they stream from the LLM.
   * Falls back to a single buffered response when the adapter does not support
   * SSE streaming.
   */
  complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; onToken?: (chunk: string) => void; onStreamReset?: () => void; simple?: boolean },
  ): Promise<{ text: string }>;
}

/**
 * Abstract interface for tool execution — satisfied by workbench-core's
 * ToolRegistry via createToolService() in the app shell.
 *
 * Kept independent of workbench-core types so orca-core stays generic.
 * The concrete bridge lives in apps/runner/src/adapters/toolService.ts.
 */
export interface OrcaToolService {
  /**
   * Execute a named tool and return a plain result object.
   * The agent loop in MaestroAdapter calls this after parsing <tool_call> blocks.
   */
  execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; error?: string }>;

  /**
   * Returns a prompt-ready block describing every available tool.
   * Injected into the LLM system prompt before each agent run.
   */
  formatForPrompt(): string;
}

export interface OrcaRunCtx {
  llm: OrcaLLMService;
  runId: string;
  /** Optional — when present, Maestro runs in agent-loop mode with tool calling. */
  tools?: OrcaToolService;
  /**
   * Emit an OrcaEvent directly from inside an adapter.
   * Populated by createOrcaRuntime so adapters can fire subagent events
   * without depending on the OrcaEmitter internals.
   */
  emit?: (event: OrcaEvent) => void;
  /**
   * Subagent nesting depth. 0 = top-level task, 1+ = inside a subagent.
   * Prevents infinite recursive decomposition.
   */
  subagentDepth?: number;
  /**
   * Workspace state captured once at task start.
   * Adapters can inject it into prompts for grounding (branch, recent files, etc.).
   */
  workspaceContext?: WorkspaceContext;
  /**
   * Miranda's gate — guards before/after every tool call and QC run.
   * before_tool_run / after_tool_run: validates tool allowlist and receipts.
   * before_qc / after_qc: validates QC preconditions and verdict shape.
   * The LLM gates (before/after_llm_call) live inside the Miranda pipeline.
   */
  gate?: MirandaGate;
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
  /**
   * When omitted, QC is skipped entirely (Maestro-only mode).
   * Restore to enable Pappy quality control.
   */
  pappy?: PappyPort;
  llm: OrcaLLMService;
  /** When supplied, ctx.tools is populated and the agent loop activates. */
  tools?: OrcaToolService;
  /**
   * Persist every completed run to a durable store.
   * Inject createSqliteRunStore() from apps/runner for production use.
   */
  store?: RunStore;
  /**
   * Called once at the start of each task to capture workspace state.
   * Inject getWorkspaceContext from orca-core for automatic git + file info.
   */
  getWorkspaceContext?: () => WorkspaceContext;
  /** Maximum repair passes before giving up on a FAIL verdict. Default: 2 */
  maxRepairPasses?: number;
  /**
   * Miranda's gate — the compliance and governance layer.
   * Wraps every LLM call, tool execution, and QC run with validation checkpoints.
   * Injected here so it flows through OrcaRunCtx to every adapter.
   */
  gate?: MirandaGate;
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
  /**
   * taskId  — stable per-task identifier (= ctx.runId).
   * attempt — 0 for initial generation, 1..n for repair passes.
   * isRepair — false on attempt 0, true on all repair passes.
   *
   * Doctor query examples:
   *   "Which models fail most on PLAN stage?" → group maestro:done by model
   *   "Average repairs per task?"             → count repair:start per taskId
   *   "Did issue X get fixed?"                → track issueId across qc:result events
   */
  | { type: "task:start";         taskId: string; intent: string }
  | { type: "maestro:start";      taskId: string; attempt: number; isRepair: boolean }
  | { type: "maestro:done";       taskId: string; attempt: number; isRepair: boolean; hasOutput: boolean }
  | { type: "qc:result";          taskId: string; attempt: number; isRepair: boolean; verdict: "PASS" | "WARN" | "FAIL"; issueCount: number }
  | { type: "repair:start";       taskId: string; pass: number; maxPasses: number }
  | { type: "task:done";          taskId: string; status: "SUCCESS" | "FAIL" }
  | { type: "stream:token";       taskId: string; chunk: string }
  | { type: "stream:reset";       taskId: string }
  | { type: "subagent:spawned";   taskId: string; subagentId: string; role: string; task: string }
  | { type: "subagent:done";      taskId: string; subagentId: string; role: string; ok: boolean }
  | { type: "subagent:failed";    taskId: string; subagentId: string; role: string; error: string };
