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
    mode?: "default" | "project_audit";
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
    qcResult?: PappyResult;
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

  export interface AHPInput {
    id: string;
    type: string;
    value: unknown;
  }

  export interface AHPConstraint {
    rule: string;
    enforcer: string;
  }

  export interface AHPExpectedOutput {
    schema: Readonly<Record<string, unknown>>;
    acceptanceCriteria: ReadonlyArray<string>;
  }

  export interface AHPTraceEntry {
    timestamp: string;
    state: string;
    actor: string;
    note?: string;
  }

  export interface AHPMeta {
    ackRequired: boolean;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
  }

  export interface AHPEvalMeta {
    taskType: string;
    derivedAcceptanceCriteria: ReadonlyArray<string>;
    mergedAcceptanceCriteria: ReadonlyArray<string>;
  }

  export interface AHPPacket {
    id: string;
    objective: string;
    lifecycle: string;
    inputs: ReadonlyArray<AHPInput>;
    constraints: ReadonlyArray<AHPConstraint>;
    expectedOutput: AHPExpectedOutput;
    trace: AHPTraceEntry[];
    meta: AHPMeta;
    verdict?: string;
    repairPrompt?: string;
    evalMeta?: AHPEvalMeta;
    role?: string;
    parentPacketId?: string;
    childPacketIds?: string[];
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
      brainDecision?: string;
      decomposition?: {
        synthesisHint?: string;
      };
      thoughts?: unknown[];
      iterationCount?: number;
      stoppedBecause?: "done" | "max_iterations" | "loop_detected" | "parse_failure_loop" | "no_final_output" | "error";
      loopEvidence?: { repeatedCall: string; occurrences: number };
      errorMessage?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      filesChanged?: OrcaFileChange[];
      auditResult?: unknown;
    };
    doneCriteria?: string[];
    ahpPacket?: AHPPacket;
    ahpChildPackets?: AHPPacket[];
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

  export interface LLMOptions {
    maxTokens?: number;
    temperature?: number;
    onToken?: (chunk: string) => void;
    onStreamReset?: () => void;
    simple?: boolean;
    enableThinking?: boolean;
    abortSignal?: AbortSignal;
  }

  export interface OrcaLLMService {
    complete(prompt: string, opts?: LLMOptions): Promise<{ text: string }>;
    stream(
      prompt: string,
      options: LLMOptions,
      onChunk: (chunk: string) => void,
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
    ahpRootPacket?: AHPPacket;
    ahpPacket?: AHPPacket;
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
    workspaceRoot?: string;
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
    | { type: 'maestro:agent_done'; taskId: string; role: RoleName; stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'parse_failure_loop' | 'no_final_output' | 'error'; iterations: number; loopEvidence?: { repeatedCall: string; occurrences: number } }
    | {
        type: 'pipeline:summary';
        taskId: string;
        role: string;
        verdict: 'PASS' | 'WARN' | 'FAIL';
        confidence: number;
        issueCount: number;
        issues: Array<{ severity: string; code: string; description: string }>;
        acceptanceCriteria: Array<{ id: string; text: string; required: boolean; met: boolean }>;
        durationMs: number;
        repairPasses: number;
        errorMessage?: string;
        traceStages?: string[];
        deweyBrief?: { userName: string; suggestedTone: string; relevantPreferences: string[]; relevantContext: string[] };
        mirandaCheckpoints?: Array<{ gate: string; allowed: boolean; reason: string }>;
        auditDetail?: {
          classification: { primary: string; categories: string[]; confidence: number };
          probes: Array<{ name: string; status: string; evidenceCount: number; missingCount: number }>;
          supportingEvidence: string[];
          missingEvidence: string[];
          riskFlags: string[];
          commandDecisions: Array<{ command: string; status: string; reason: string }>;
        };
      };

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
