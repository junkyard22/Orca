/**
 * Type declarations for @clawde/benson-core
 *
 * These types are designed to be structurally compatible with @clawde/orca-core
 * types since benson-core receives executeTask from orca-core at construction time.
 *
 * Note: TaskSpec and ExecutionResult are aligned with OrcaTaskSpec and OrcaExecutionResult
 * from orca-core to ensure type compatibility when passing runtime.executeTask to createBenson.
 */
declare module '@clawde/benson-core' {
  import type { LLMMessage } from '@clawde/miranda-core';

  export interface TaskPermissions {
    fileRead: boolean;
    fileWrite: boolean;
    shellExec: boolean;
    toolsAllowed?: string[];
  }

  export interface TaskSpec {
    originalUserMessage: string;
    intent: string;
    goals: string[];
    mode?: "default" | "project_audit";
    constraints?: Record<string, unknown>;
    context?: {
      conversationHistory?: LLMMessage[];
      hasImages?: boolean;
      errorOutput?: string;
      fileCount?: number;
      deepPlan?: boolean;
      filePath?: string;
      [key: string]: unknown;
    };
    permissions?: TaskPermissions;
  }

  export interface ExecutionResult {
    status: "SUCCESS" | "FAIL";
    userFacingText?: string;
    summary?: string;
    artifacts?: unknown;
    followUpQuestion?: string;
  }

  export interface ExecuteTaskFn {
    (task: TaskSpec, options?: { abortSignal?: AbortSignal }): Promise<ExecutionResult>;
  }

  export interface BensonOptions {
    executeTask: ExecuteTaskFn;
  }

  export function createBenson(options: BensonOptions): BensonHandle;

  export interface BensonHandle {
    handleUserMessage(message: string, options?: { abortSignal?: AbortSignal }): Promise<string>;
  }
}
