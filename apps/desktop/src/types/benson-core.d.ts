/**
 * Type declarations for @clawde/benson-core
 */
declare module '@clawde/benson-core' {
  export interface TaskSpec {
    intent: string;
    goals?: string[];
    permissions?: TaskPermissions | Permission[];
    context?: Record<string, unknown>;
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

  export interface ExecutionResult {
    success: boolean;
    output?: string;
    error?: string;
    status: 'SUCCESS' | 'FAIL';
  }

  export interface ExecuteTaskFn {
    (task: TaskSpec): Promise<ExecutionResult>;
  }

  export interface BensonOptions {
    executeTask: ExecuteTaskFn;
  }

  export function createBenson(options: BensonOptions): BensonHandle;

  export interface BensonHandle {
    handleUserMessage(message: string): Promise<string>;
  }
}