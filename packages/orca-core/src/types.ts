import type { PappyInput, PappyResult } from "@clawde/pappy-core";
import type { MirandaGate } from "@clawde/miranda-core";
import type { WorkspaceContext } from "./workspaceContext.js";
import type { OrcaStore } from "./persistence/types.js";
import type { ThoughtRecord } from "./persistence/types.js";
import type { RoleName } from "maestro-core";
import type { AHPPacket } from "./ahp/types.js";

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

export type OutputFormat = "bullets" | "table" | "code" | "diff" | "file_diff" | "json" | "prose";
export type TaskMode = "default" | "project_audit";

export interface TaskPermissions {
  fileRead:     boolean;
  fileWrite:    boolean;
  shellExec:    boolean;
  toolsAllowed?: string[];
}

export interface OrcaTaskSpec {
  originalUserMessage: string;
  intent: string;
  goals: string[];
  mode?: TaskMode;
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
  permissions?: TaskPermissions;
  outputFormat?: OutputFormat;
}

export interface OrcaExecutionResult {
  status: "SUCCESS" | "WARN" | "FAIL";
  userFacingText?: string;
  summary?: string;
  artifacts?: unknown;
  followUpQuestion?: string;
  /**
   * Root AHP packet for this run.
   * Present when AHP is enabled (i.e. when the runtime created one).
   * Carries the orchestration-level lifecycle, objective, and trace.
   */
  ahpRootPacket?: AHPPacket;
  /**
   * Child AHP packets linked to the root packet (one per worker branch).
   * Empty or absent for single-run (non-decomposed) tasks where the root
   * was finalized directly (Option A single-run behaviour).
   */
  ahpChildPackets?: AHPPacket[];
}

export interface OrcaFileChange {
  path: string;
  changeType: "A" | "M" | "D";
  diff?: string;
}

export interface OrcaToolEvent {
  tool: string;
  ok: boolean;
  summary: string;
  raw?: unknown;
}

export interface OrcaPipelineTraceEntry {
  at: string;
  stage: string;
  detail?: unknown;
}

export interface OrcaPipelineTrace {
  version: 1;
  taskId: string;
  createdAt: string;
  task: OrcaTaskSpec;
  entries: OrcaPipelineTraceEntry[];
  finalResult?: {
    status: OrcaExecutionResult["status"] | "ABORTED";
    summary?: string;
    userFacingText?: string;
    role?: string;
    qcVerdict?: PappyResult["verdict"];
    issueCount?: number;
    repairPasses: number;
    durationMs: number;
    ahpPacketGraph?: import("./ahp/graph.js").AHPPacketGraph;
  };
}

// ---------------------------------------------------------------------------
// What Maestro returns to orca-core after running a task.
// Richer than Maestro's own PodMember.Result so Pappy can evaluate it fully.
// ---------------------------------------------------------------------------

export interface OrcaMaestroResult {
  outputText?: string;
  summary?: string;
  filesChanged?: OrcaFileChange[];
  toolEvents?: OrcaToolEvent[];
  metadata?: {
    role?: string;
    /** Raw Brain routing JSON (e.g. '{"routing":"direct","role":"strong_model"}').
     * Populated only when Brain made a successful LLM routing call.
     * Used by exportTrainingData to emit Moonshiner examples tagged role:"brain". */
    brainDecision?: string;
    decomposition?: {
      synthesisHint?: string;
    };
    thoughts?: ThoughtRecord[];
    iterationCount?: number;
    stoppedBecause?: "done" | "max_iterations" | "loop_detected" | "parse_failure_loop" | "no_final_output" | "error";
    loopEvidence?: { repeatedCall: string; occurrences: number };
    /** Exception message captured when stoppedBecause === 'error'. */
    errorMessage?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    filesChanged?: OrcaFileChange[];
    auditResult?: unknown;
  };
  /**
   * Acceptance criteria Brain defined for this task.
   * Passed to Pappy so it can enforce them instead of deriving generic ones.
   */
  doneCriteria?: string[];
  /**
   * Agent Handoff Protocol packet threaded through the Maestro role pipeline.
   * Brain creates it (PENDING) → Miranda transitions to RUNNING → worker
   * appends trace entries → transitions to COMPLETE/FAILED after execution.
   * Pappy receives this via the host runtime for final verification.
   */
  ahpPacket?: AHPPacket;
  /**
   * Child AHP packets when Maestro performed decomposed/parallel execution.
   * Each element is a child packet linked to `ahpPacket` (the root).
   * Absent (or empty) for single-run non-decomposed tasks.
   */
  ahpChildPackets?: AHPPacket[];
  /** Populated when Maestro decomposed the task into parallel subagents (Phase 2). */
  subagentRuns?: Array<{
    subagentId: string;
    packetId?: string;
    role: string;
    task: string;
    status: "done" | "failed";
    outputText?: string;
    filesChanged?: OrcaFileChange[];
    toolEvents?: OrcaToolEvent[];
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Run context passed to Maestro on each call.
// Contains everything Maestro needs without coupling to any specific impl.
// ---------------------------------------------------------------------------

/** Shared options for LLM calls — used by both complete() and stream(). */
export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  /** Incremental token callback. complete() uses this for optional streaming. */
  onToken?: (chunk: string) => void;
  /** Called before a stream restart so callers can clear partial output. */
  onStreamReset?: () => void;
  simple?: boolean;
  enableThinking?: boolean;
  abortSignal?: AbortSignal;
}

export interface OrcaLLMService {
  /**
   * Generate text for a prompt.
   * The concrete implementation is injected by the app shell at startup.
   * Currently the runner uses createDirectLLMService (single call, no stage
   * pipeline). Miranda's PLAN→ANSWER→CRITIQUE→REWRITE pipeline is the
   * intended future implementation but is not yet the live path.
   *
   * Pass `onToken` inside opts to receive incremental chunks as they stream
   * from the LLM. Falls back to a single buffered response when the adapter
   * does not support SSE streaming.
   */
  complete(prompt: string, opts?: LLMOptions): Promise<{ text: string }>;

  /**
   * Streaming variant — fires onChunk for every incremental token and
   * resolves with the full assembled response when the stream closes.
   *
   * Falls back to complete() (single buffered call → single onChunk
   * invocation) when the underlying adapter does not support SSE streaming.
   */
  stream(
    prompt: string,
    options: LLMOptions,
    onChunk: (chunk: string) => void,
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
  abortSignal?: AbortSignal;
  /**
   * Append a structured entry to the per-run pipeline trace.
   * Adapters should use this instead of ad hoc logging when recording
   * prompts, routing decisions, tool calls, and repair-loop details.
   */
  recordTrace?: (stage: string, detail?: unknown) => void;
  /** Optional — when present, Maestro runs in agent-loop mode with tool calling. */
  tools?: OrcaToolService;
  /**
   * Tool names permitted for this task after Benson permissions are normalized.
   * Undefined means no explicit restriction; [] means no tools are permitted.
   */
  toolNamesAllowed?: string[];
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
  /**
   * Root AHP packet for the current run.
   * Populated by the runtime before invoking Maestro so that adapters,
   * workers, and the repair loop can reference the orchestration-level packet
   * without needing to pass it as an explicit argument.
   * Never write worker-level execution traces directly to this packet;
   * those belong on child packets.
   */
  ahpRootPacket?: AHPPacket;
  /**
   * Active AHP packet for the current worker branch.
   * For decomposed runs this is the child packet that carries the worker's
   * actual assignment, constraints, and acceptance criteria.
   */
  ahpPacket?: AHPPacket;
  /**
   * Optional approval hook — when set, the agent loop calls this before
   * executing each tool. Return false to deny the call.
   * Used by the desktop app to show the tool-approval dialog.
   * When absent (CLI mode), tools execute without prompting.
   */
  requestToolApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  /**
   * Absolute path to the user's configured workspace folder.
   * Passed through to tool execution so write_file resolves relative paths
   * against the workspace root rather than process.cwd().
   */
  workspaceRoot?: string;
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
   * Configured workspace root for tool execution. Runtime may override this
   * per task when the user explicitly names an existing absolute workspace path.
   */
  workspaceRoot?: string;
  /**
   * Persist every completed run to a durable store.
   * Inject SqliteStore from @clawde/orca-core/persistence for production use.
   */
  store?: OrcaStore;
  /**
   * Persist the structured per-run pipeline trace.
   * Called after each task completes or aborts.
   */
  writeTrace?: (trace: OrcaPipelineTrace) => void | Promise<void>;
  /**
   * Called once at the start of each task to capture workspace state.
   * Inject getWorkspaceContext from orca-core for automatic git + file info.
   */
  getWorkspaceContext?: () => WorkspaceContext;
  /** Maximum repair passes before giving up on a FAIL verdict. Default: 2 */
  maxRepairPasses?: number;
  /**
   * Per-run cost ceiling in USD. When accumulated spend across all LLM calls
   * for a single task reaches this limit, repair passes are skipped and the
   * best result so far is returned with status WARN.
   * Undefined or 0 means no limit.
   */
  budgetUsd?: number;
  /**
   * Miranda's gate — the compliance and governance layer.
   * Wraps every LLM call, tool execution, and QC run with validation checkpoints.
   * Injected here so it flows through OrcaRunCtx to every adapter.
   */
  gate?: MirandaGate;
  /**
   * Per-tool approval hook. When supplied, every agent tool call is gated
   * behind this function before execution. Return false to deny.
   * Inject requestToolApproval from apps/desktop/src/main.ts for the UI dialog.
   */
  requestToolApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface OrcaRuntime {
  executeTask(
    taskSpec: OrcaTaskSpec,
    options?: { abortSignal?: AbortSignal },
  ): Promise<OrcaExecutionResult>;
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
  | { type: "task:done";          taskId: string; status: "SUCCESS" | "WARN" | "FAIL" }
  | { type: "stream:token";       taskId: string; chunk: string }
  | { type: "stream:reset";       taskId: string }
  | { type: "dewey:brief";        taskId: string; userName: string; suggestedTone: string; relevantPreferences: string[]; relevantContext: string[] }
  | { type: "miranda:checkpoint"; taskId: string; gate: "before_qc" | "after_qc"; allowed: boolean; reason: string }
  | { type: "subagent:spawned";   taskId: string; subagentId: string; role: string; task: string }
  | { type: "subagent:done";      taskId: string; subagentId: string; role: string; ok: boolean }
  | { type: "subagent:failed";    taskId: string; subagentId: string; role: string; error: string }
  | { type: 'maestro:thought'; taskId: string; iteration: number; thought: string; observation: string; next: string }
  | { type: 'maestro:agent_start'; taskId: string; role: RoleName; doneCriteria: string[] }
  | { type: 'maestro:agent_done'; taskId: string; role: RoleName; stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'parse_failure_loop' | 'no_final_output' | 'error'; iterations: number; loopEvidence?: { repeatedCall: string; occurrences: number } }
  /**
   * Emitted once per task after task:done, summarising the final pipeline outcome.
   * Carries everything the UI needs to render the collapsed pipeline-summary badge
   * without the renderer having to aggregate individual events itself.
   */
  | {
      type: "pipeline:summary";
      taskId: string;
      /** Role that generated the final answer (after any repair passes). */
      role: string;
      verdict: "PASS" | "WARN" | "FAIL";
      /** 0-1 confidence score from QC, or audit readiness in project-audit mode. */
      confidence: number;
      issueCount: number;
      issues: Array<{ severity: string; code: string; description: string }>;
      acceptanceCriteria: Array<{ id: string; text: string; required: boolean; met: boolean }>;
      durationMs: number;
      repairPasses: number;
      /** Exception message from the agent worker, present when stoppedBecause === 'error'. */
      errorMessage?: string;
      /** Runtime trace stages captured during the run; useful when UI event logs arrive late or are unavailable. */
      traceStages?: string[];
      deweyBrief?: { userName: string; suggestedTone: string; relevantPreferences: string[]; relevantContext: string[] };
      mirandaCheckpoints?: Array<{ gate: string; allowed: boolean; reason: string }>;
      /** Structured detail from a project_audit run — probes, evidence, risk flags, command decisions. */
      auditDetail?: {
        classification: { primary: string; categories: string[]; confidence: number };
        probes: Array<{ name: string; status: string; evidenceCount: number; missingCount: number }>;
        supportingEvidence: string[];
        missingEvidence: string[];
        riskFlags: string[];
        commandDecisions: Array<{ command: string; status: string; reason: string }>;
      };
    };
