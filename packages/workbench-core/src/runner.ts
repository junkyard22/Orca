/**
 * Runner Interface - Foundation for language-agnostic tool execution
 * 
 * Runners execute tools in specific environments (shell, Python, Node, Go, etc.)
 * Core does not implement language logic. Runners do.
 * 
 * Phase 1: Only ShellRunner exists. All tools route through it.
 * Future: PythonRunner, NodeRunner, GoRunner, etc.
 */

export interface ToolSpec {
  name: string;
  command?: string;
  script?: string;
  input?: any;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecutionPlan {
  runner: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout: number;
  shell: boolean;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  error?: string;
}

export interface VerificationOutcome {
  status: 'PASS' | 'WARN' | 'FAIL';
  reason?: string;
  suggestion?: string;
}

/**
 * Runner Interface
 * All tool execution must flow through a Runner implementation
 */
export interface Runner {
  readonly name: string;
  
  /**
   * Can this runner execute the given tool?
   */
  canRun(toolSpec: ToolSpec): boolean;
  
  /**
   * Prepare execution plan from tool specification
   */
  prepare(toolSpec: ToolSpec, input: any): ExecutionPlan;
  
  /**
   * Execute the plan and return results
   */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;
  
  /**
   * Verify execution results against tool specification
   */
  verify(result: ExecutionResult, toolSpec: ToolSpec): VerificationOutcome;
}

/**
 * ShellRunner - Wraps current execution behavior
 * 
 * Phase 1: This is the ONLY runner. All existing tools route through it.
 * No behavior changes. No new error handling. Just routing.
 */
export class ShellRunner implements Runner {
  readonly name = 'shell';

  canRun(toolSpec: ToolSpec): boolean {
    // Phase 1: Accept all tools (wraps existing behavior)
    return true;
  }

  prepare(toolSpec: ToolSpec, input: any): ExecutionPlan {
    // Wrap current execution path - no changes to logic
    const command = toolSpec.command || toolSpec.script || '';
    
    return {
      runner: this.name,
      command: command,
      args: [], // Phase 1: command is already formatted with args
      cwd: toolSpec.cwd,
      env: toolSpec.env,
      timeout: toolSpec.timeout || 30000,
      shell: true // Current behavior uses shell execution
    };
  }

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    // Phase 1: This will be called by tool-dispatch.ts
    // For now, this is a placeholder - actual execution still happens in tool-dispatch
    // This allows gradual migration without breaking existing code
    throw new Error('ShellRunner.execute() - not yet migrated. Execution still in tool-dispatch.ts');
  }

  verify(result: ExecutionResult, toolSpec: ToolSpec): VerificationOutcome {
    // Phase 1: Simple exit code verification (matches current behavior)
    if (result.exitCode === 0) {
      return {
        status: 'PASS',
        reason: 'Exit code 0'
      };
    }
    
    if (result.error) {
      return {
        status: 'FAIL',
        reason: result.error,
        suggestion: 'Check stderr for details'
      };
    }
    
    return {
      status: 'FAIL',
      reason: `Non-zero exit code: ${result.exitCode}`,
      suggestion: 'Check stderr for error details'
    };
  }
}

/**
 * RunnerRegistry - Singleton for runner management
 * 
 * Phase 1: Only ShellRunner registered.
 * Future: PythonRunner, NodeRunner, etc.
 */
export class RunnerRegistry {
  private static instance: RunnerRegistry;
  private runners: Map<string, Runner> = new Map();

  private constructor() {
    // Phase 1: Auto-register ShellRunner
    this.register(new ShellRunner());
  }

  static getInstance(): RunnerRegistry {
    if (!RunnerRegistry.instance) {
      RunnerRegistry.instance = new RunnerRegistry();
    }
    return RunnerRegistry.instance;
  }

  register(runner: Runner): void {
    this.runners.set(runner.name, runner);
    console.log(`[RunnerRegistry] Registered runner: ${runner.name}`);
  }

  findRunner(toolSpec: ToolSpec): Runner | null {
    // Phase 1: Always return ShellRunner
    // This ensures zero behavior change during migration
    const runnerArray = Array.from(this.runners.values());
    for (let i = 0; i < runnerArray.length; i++) {
      const runner = runnerArray[i];
      if (runner.canRun(toolSpec)) {
        // GUARDRAIL: Log which runner selected
        console.log(`[RunnerRegistry] Selected runner: ${runner.name} for tool`);
        
        // ASSERTION: Phase 1 - must always be ShellRunner
        if (runner.name !== 'shell') {
          console.warn(`[RunnerRegistry] WARNING: Non-shell runner selected during Phase 1. This should not happen.`);
        }
        
        return runner;
      }
    }
    
    console.error('[RunnerRegistry] No runner found for tool spec');
    return null;
  }

  getRunner(name: string): Runner | null {
    return this.runners.get(name) || null;
  }

  listRunners(): string[] {
    return Array.from(this.runners.keys());
  }
}

// Export singleton instance for convenience
export const runnerRegistry = RunnerRegistry.getInstance();
