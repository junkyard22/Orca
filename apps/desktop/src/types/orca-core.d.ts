/**
 * Type declarations for @clawde/orca-core
 */
declare module '@clawde/orca-core' {
  import type { LLMAdapter, LLMMessage } from '@clawde/miranda-core';

  export interface OrcaEvent {
    type: OrcaEventType;
    taskId: string;
    [key: string]: unknown;
  }

  export type OrcaEventType =
    | 'task:start'
    | 'maestro:start'
    | 'maestro:done'
    | 'maestro:thought'
    | 'qc:result'
    | 'repair:start'
    | 'task:done'
    | 'stream:token'
    | 'stream:reset';

  export interface OrcaRunCtx {
    runId: string;
    emit?: (event: OrcaEvent) => void;
    llm: OrcaLLMService;
  }

  export interface OrcaTaskSpec {
    intent: string;
    goals?: string[];
    doneCriteria?: string[];
    originalUserMessage?: string;
    constraints?: Record<string, unknown>;
    permissions?: TaskPermissions | Permission[];
    context?: {
      conversationHistory?: LLMMessage[];
      hasImages?: boolean;
      errorOutput?: string;
      fileCount?: number;
      deepPlan?: boolean;
      filePath?: string;
      [key: string]: unknown;
    };
  }

  export interface TaskPermissions {
    fileRead?: boolean;
    fileWrite?: boolean;
    shellExec?: boolean;
    toolsAllowed?: string[];
  }

  export interface Permission {
    type: string;
    resource?: string;
  }

  export interface OrcaLLMService {
    complete(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<{ text: string }>;
  }

  export interface OrcaToolService {
    execute(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;
    formatForPrompt(): string;
  }

  export interface MaestroPort {
    run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult>;
  }

  export interface OrcaMaestroResult {
    outputText: string;
    summary: string;
    toolEvents: ToolEvent[];
    filesChanged: FileChange[];
    doneCriteria?: string[];
    metadata?: Record<string, unknown>;
  }

  export interface ToolEvent {
    tool: string;
    ok: boolean;
    summary: string;
    raw?: unknown;
  }

  export interface FileChange {
    path: string;
    changeType: 'A' | 'M' | 'D';
    diff?: string;
  }

  export interface OrcaRuntime {
    executeTask(spec: OrcaTaskSpec): Promise<OrcaExecutionResult>;
    on(event: OrcaEventType, handler: (e: OrcaEvent) => void): () => void;
  }

  export interface OrcaExecutionResult {
    success: boolean;
    output?: string;
    error?: string;
    status: 'SUCCESS' | 'FAIL';
  }

  export function createOrcaRuntime(options: {
    maestro: MaestroPort;
    pappy: PappyPort;
    llm: OrcaLLMService;
    maxRepairPasses?: number;
    tools?: OrcaToolService;
    store?: SqliteStore;
    requestToolApproval?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  }): OrcaRuntime;

  export function createDirectLLMService(
    adapter: LLMAdapter,
    model: string,
    options?: { maxTokens?: number; temperature?: number }
  ): OrcaLLMService;

  export function createPappyPort(): PappyPort;

  export function deriveFilesChangedFromToolEvents(
    toolEvents: ToolEvent[],
    filesChanged?: FileChange[]
  ): FileChange[];

  export interface PappyPort {
    validate?(output: string, context: unknown): Promise<{ valid: boolean; issues?: string[] }>;
  }

  export class SqliteStore {
    constructor(path: string);
    close(): void;
  }
}