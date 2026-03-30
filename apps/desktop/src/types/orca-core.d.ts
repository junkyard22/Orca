/**
 * Type declarations for @clawde/orca-core
 *
 * These types mirror the actual types in orca-core/src/types.ts
 * to ensure type compatibility across the codebase.
 */
declare module '@clawde/orca-core' {
  import type { LLMAdapter, LLMMessage } from '@clawde/miranda-core';
  import type { MirandaGate } from '@clawde/miranda-core';
  import type { RoleName } from 'maestro-core';

  export type OutputFormat = "code" | "diff" | "json" | "prose";

  export interface TaskPermissions {
    fileRead: boolean;
    fileWrite: boolean;
    shellExec: boolean;
    toolsAllowed?: string[];
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
    status: "SUCCESS" | "WARN" | "FAIL";
    userFacingText?: string;
    summary?: string;
    artifacts?: unknown;
    followUpQuestion?: string;
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
      qcVerdict?: "PASS" | "WARN" | "FAIL";
      issueCount?: number;
      repairPasses: number;
      durationMs: number;
    };
  }

  export interface OrcaMaestroResult {
    outputText?: string;
    summary?: string;
    filesChanged?: OrcaFileChange[];
    toolEvents?: OrcaToolEvent[];
    metadata?: {
      role?: string;
      thoughts?: unknown[];
      iterationCount?: number;
      stoppedBecause?: "done" | "max_iterations" | "loop_detected" | "error";
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      filesChanged?: OrcaFileChange[];
    };
    doneCriteria?: string[];
    subagentRuns?: Array<{
      subagentId: string;
      role: string;
      task: string;
      status: "done" | "failed";
      outputText?: string;
      error?: string;
    }>;
  }

  export interface OrcaLLMService {
    complete(
      prompt: string,
      opts?: {
        maxTokens?: number;
        temperature?: number;
        onToken?: (chunk: string) => void;
        onStreamReset?: () => void;
        simple?: boolean;
        enableThinking?: boolean;
        abortSignal?: AbortSignal;
      },
    ): Promise<{ text: string }>;
  }

  export interface OrcaToolService {
    execute(
      name: string,
      input: Record<string, unknown>,
    ): Promise<{ ok: boolean; output: string; error?: string }>;
    formatForPrompt(): string;
  }

  export interface OrcaRunCtx {
    llm: OrcaLLMService;
    runId: string;
    abortSignal?: AbortSignal;
    recordTrace?: (stage: string, detail?: unknown) => void;
    tools?: OrcaToolService;
    toolNamesAllowed?: string[];
    emit?: (event: OrcaEvent) => void;
    subagentDepth?: number;
    workspaceContext?: unknown;
    gate?: MirandaGate;
    requestToolApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
    workspaceRoot?: string;
  }

  export interface MaestroPort {
    run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult>;
  }

  /** Pappy input shape for quality control evaluation */
  export interface PappyInput {
    task: OrcaTaskSpec;
    result: OrcaMaestroResult;
  }

  /** Pappy result from quality control evaluation */
  export interface PappyResult {
    verdict: "PASS" | "WARN" | "FAIL";
    issues?: string[];
  }

  export interface PappyPort {
    evaluate(input: PappyInput): PappyResult;
  }

  export interface OrcaRuntimeDeps {
    maestro: MaestroPort;
    pappy?: PappyPort;
    llm: OrcaLLMService;
    tools?: OrcaToolService;
    store?: unknown;
    writeTrace?: (trace: OrcaPipelineTrace) => void | Promise<void>;
    getWorkspaceContext?: () => unknown;
    maxRepairPasses?: number;
    gate?: MirandaGate;
    requestToolApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  }

  export interface OrcaRuntime {
    executeTask(taskSpec: OrcaTaskSpec, options?: { abortSignal?: AbortSignal }): Promise<OrcaExecutionResult>;
    on(eventType: OrcaEventType, handler: (e: OrcaEvent) => void): () => void;
  }

  export type OrcaEventType = OrcaEvent["type"];

  export type OrcaEvent =
    | { type: "task:start"; taskId: string; intent: string }
    | { type: "maestro:start"; taskId: string; attempt: number; isRepair: boolean }
    | { type: "maestro:done"; taskId: string; attempt: number; isRepair: boolean; hasOutput: boolean }
    | { type: "qc:result"; taskId: string; attempt: number; isRepair: boolean; verdict: "PASS" | "WARN" | "FAIL"; issueCount: number }
    | { type: "repair:start"; taskId: string; pass: number; maxPasses: number }
    | { type: "task:done"; taskId: string; status: "SUCCESS" | "FAIL" }
    | { type: "stream:token"; taskId: string; chunk: string }
    | { type: "stream:reset"; taskId: string }
    | { type: "subagent:spawned"; taskId: string; subagentId: string; role: string; task: string }
    | { type: "subagent:done"; taskId: string; subagentId: string; role: string; ok: boolean }
    | { type: "subagent:failed"; taskId: string; subagentId: string; role: string; error: string }
    | { type: 'maestro:thought'; taskId: string; iteration: number; thought: string; observation: string; next: string }
    | { type: 'maestro:agent_start'; taskId: string; role: RoleName; doneCriteria: string[] }
    | { type: 'maestro:agent_done'; taskId: string; role: RoleName; stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'error'; iterations: number; loopEvidence?: { repeatedCall: string; occurrences: number } };

  export interface OrcaStore {
    close(): void;
  }

  export function createOrcaRuntime(options: OrcaRuntimeDeps): OrcaRuntime;
  export function createDirectLLMService(
    adapter: LLMAdapter,
    model: string,
    options?: { maxTokens?: number; temperature?: number }
  ): OrcaLLMService;
  export function createPappyPort(): PappyPort;
  export function deriveFilesChangedFromToolEvents(
    toolEvents: OrcaToolEvent[],
    filesChanged?: OrcaFileChange[]
  ): OrcaFileChange[];

  export class SqliteStore {
    constructor(path: string);
    close(): void;
  }
}
