/**
 * Type declarations for maestro-core
 */
declare module 'maestro-core' {
  export interface RoleMetadata {
    purpose: string;
    trigger: string;
    fallback: CoreRoleName;
  }

  export type CoreRoleName = 'brain' | 'coder_strong' | 'coder_cheap' | 'utility' | 'reviewer' | 'narrator';
  export type OptionalRoleName = 'planner_deep' | 'debugger' | 'reader' | 'vision';
  export type RoleName = CoreRoleName | OptionalRoleName;

  export interface TaskContext {
    task: string;
    filePath?: string;
    fileCount?: number;
    hasImages?: boolean;
    errorOutput?: string;
    textLength?: number;
    isDeepPlanRequested?: boolean;
  }

  export interface DecomposeDecision {
    routing: 'direct' | 'decompose';
    role?: RoleName;
    done_criteria?: string[];
    departments?: DepartmentTask[];
  }

  export interface DepartmentTask {
    department: string;
    task: string;
    done_criteria: string[];
  }

  export type HeadName = 'code' | 'plan' | 'review' | 'test' | 'docs';

  // Maestro Core exports
  export function createMaestroCore(): MaestroCore;
  export function getRolePrompt(role: RoleName): string;
  export function selectRole(
    context: TaskContext,
    availableOptionalRoles: Set<OptionalRoleName>,
    defaultRole?: CoreRoleName,
    logger?: Logger
  ): { role: RoleName; isFallback: boolean; warning?: string };

  export const BRAIN_DECOMPOSE_SYSTEM: string;
  export function parseBrainDecision(text: string): DecomposeDecision;
  export function buildSynthesisPrompt(results: unknown[]): string;

  export const OPTIONAL_ROLE_METADATA: Record<OptionalRoleName, RoleMetadata>;

  // Model Fallback Pool exports
  export interface PoolModelEntry {
    id: string;
    model: string;
    providerId: string;
    priority: number;
    weight?: number;
    maxRetries?: number;
    timeoutMs?: number;
  }

  export interface RoleFallbackPool {
    role: RoleName;
    models: PoolModelEntry[];
    strategy: 'priority' | 'round-robin';
    cooldownMs?: number;
    resetOnSuccess?: boolean;
  }

  export interface FallbackPoolConfig {
    pools: Partial<Record<RoleName, RoleFallbackPool>>;
    defaultPool?: RoleFallbackPool;
    globalCooldownMs?: number;
  }

  export class ModelFallbackPoolManager {
    constructor(config: FallbackPoolConfig, verbose?: boolean);
    selectModel(role: RoleName): PoolModelEntry | undefined;
    recordSuccess(role: RoleName, modelId: string): void;
    recordFailure(role: RoleName, modelId: string, error?: string): void;
    getStats(role: RoleName): {
      models: Array<{
        id: string;
        successCount: number;
        failureCount: number;
        consecutiveFailures: number;
        inCooldown: boolean;
      }>;
      currentModelIndex: number;
    } | undefined;
    resetRole(role: RoleName): void;
    resetAll(): void;
  }

  export function createSimpleFallbackPool(
    role: RoleName,
    models: Array<{ id: string; model: string; providerId: string }>,
    strategy?: 'priority' | 'round-robin'
  ): RoleFallbackPool;

  // Logger interface
  export interface Logger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, error?: Error, ...args: any[]): void;
  }

  // MaestroCore class
  export interface MaestroCore {
    orchestrate(intent: string): {
      classification: { type: string; estimatedImpact: number; multiStep: boolean };
      risk: { riskScore: number; requiresPlan: boolean };
    };
  }
}