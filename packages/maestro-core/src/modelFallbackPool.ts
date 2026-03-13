/**
 * Model Fallback Pool — Per-role model pools with fallback support.
 *
 * Allows configuring multiple models per role with priority ordering.
 * When a model fails, the pool automatically falls back to the next model.
 *
 * No external dependencies. Pure TypeScript.
 */

import { ProviderType } from './providerTypes';
import { RoleName } from './roleSelector';

// ============================================================================
// Pool Types
// ============================================================================

/**
 * A single model entry in a fallback pool.
 */
export interface PoolModelEntry {
  /** Unique identifier for this model entry (e.g., "primary", "fallback-1") */
  id: string;
  /** Model identifier (e.g., "gpt-4o-mini", "deepseek/deepseek-chat") */
  model: string;
  /** Provider ID reference */
  providerId: string;
  /** Priority (lower = higher priority, 0 = primary) */
  priority: number;
  /** Optional weight for load balancing (0-100, default: 100) */
  weight?: number;
  /** Maximum retries before falling back */
  maxRetries?: number;
  /** Timeout in ms before considering the call failed */
  timeoutMs?: number;
}

/**
 * A fallback pool configuration for a single role.
 */
export interface RoleFallbackPool {
  /** Role this pool is for */
  role: RoleName;
  /** Ordered list of models (primary first, fallbacks after) */
  models: PoolModelEntry[];
  /** Strategy for selecting models: "priority" (ordered) or "round-robin" (load balanced) */
  strategy: 'priority' | 'round-robin';
  /** Cooldown in ms after a failure before retrying the same model */
  cooldownMs?: number;
  /** Whether to reset to primary after a successful call */
  resetOnSuccess?: boolean;
}

/**
 * Full fallback pool configuration for all roles.
 */
export interface FallbackPoolConfig {
  /** Per-role fallback pools */
  pools: Partial<Record<RoleName, RoleFallbackPool>>;
  /** Default pool to use for roles without explicit configuration */
  defaultPool?: RoleFallbackPool;
  /** Global cooldown in ms */
  globalCooldownMs?: number;
}

// ============================================================================
// Pool State (Runtime)
// ============================================================================

/**
 * Runtime state for tracking model health and cooldowns.
 */
export interface PoolModelState {
  /** Model entry ID */
  modelId: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Last failure timestamp (ms since epoch) */
  lastFailureTime: number;
  /** Whether the model is currently in cooldown */
  inCooldown: boolean;
  /** Total successful calls */
  successCount: number;
  /** Total failed calls */
  failureCount: number;
}

/**
 * Runtime pool state for a single role.
 */
export interface PoolRuntimeState {
  /** Role this state is for */
  role: RoleName;
  /** Per-model state */
  modelStates: Map<string, PoolModelState>;
  /** Currently active model index */
  currentModelIndex: number;
  /** Last selected model ID */
  lastSelectedModel?: string;
}

// ============================================================================
// Pool Manager
// ============================================================================

/**
 * Manages fallback pools and model selection for all roles.
 */
export class ModelFallbackPoolManager {
  private config: FallbackPoolConfig;
  private runtimeStates: Map<RoleName, PoolRuntimeState> = new Map();
  private verbose: boolean;

  constructor(config: FallbackPoolConfig, verbose: boolean = false) {
    this.config = config;
    this.verbose = verbose;
    this.initializeRuntimeStates();
  }

  private initializeRuntimeStates(): void {
    // Initialize state for each configured role pool
    for (const [role, pool] of Object.entries(this.config.pools)) {
      if (!pool) continue;
      this.runtimeStates.set(role as RoleName, this.createRuntimeState(pool));
    }

    // Initialize default pool state if configured
    if (this.config.defaultPool) {
      // Default pool is used for roles without explicit configuration
      // No need to pre-initialize states
    }
  }

  private createRuntimeState(pool: RoleFallbackPool): PoolRuntimeState {
    const modelStates = new Map<string, PoolModelState>();
    for (const model of pool.models) {
      modelStates.set(model.id, {
        modelId: model.id,
        consecutiveFailures: 0,
        lastFailureTime: 0,
        inCooldown: false,
        successCount: 0,
        failureCount: 0,
      });
    }
    return {
      role: pool.role,
      modelStates,
      currentModelIndex: 0,
    };
  }

  /**
   * Get the pool for a role, falling back to default pool if not configured.
   */
  getPool(role: RoleName): RoleFallbackPool | undefined {
    return this.config.pools[role] ?? this.config.defaultPool;
  }

  /**
   * Select the best available model for a role.
   * Returns undefined if no models are available.
   */
  selectModel(role: RoleName): PoolModelEntry | undefined {
    const pool = this.getPool(role);
    if (!pool || pool.models.length === 0) return undefined;

    let state = this.runtimeStates.get(role);
    if (!state) {
      // Create state on-demand for roles using default pool
      state = this.createRuntimeState(pool);
      this.runtimeStates.set(role, state);
    }

    const now = Date.now();
    const globalCooldown = this.config.globalCooldownMs ?? 30000;

    // Try models in order based on strategy
    if (pool.strategy === 'priority') {
      for (let i = 0; i < pool.models.length; i++) {
        const model = pool.models[i];
        const modelState = state.modelStates.get(model.id);
        
        if (!modelState) continue;

        // Check cooldown
        const cooldownMs = pool.cooldownMs ?? globalCooldown;
        if (modelState.inCooldown && (now - modelState.lastFailureTime) < cooldownMs) {
          if (this.verbose) {
            console.log(`[FallbackPool] Model ${model.id} for role ${role} is in cooldown`);
          }
          continue;
        }

        // Reset cooldown if enough time has passed
        if (modelState.inCooldown) {
          modelState.inCooldown = false;
          modelState.consecutiveFailures = 0;
        }

        // Select this model
        state.currentModelIndex = i;
        state.lastSelectedModel = model.id;
        return model;
      }
    } else if (pool.strategy === 'round-robin') {
      // Round-robin with weight consideration
      const startIndex = state.currentModelIndex;
      for (let i = 0; i < pool.models.length; i++) {
        const index = (startIndex + i) % pool.models.length;
        const model = pool.models[index];
        const modelState = state.modelStates.get(model.id);
        
        if (!modelState) continue;

        // Check cooldown
        const cooldownMs = pool.cooldownMs ?? globalCooldown;
        if (modelState.inCooldown && (now - modelState.lastFailureTime) < cooldownMs) {
          continue;
        }

        // Reset cooldown if enough time has passed
        if (modelState.inCooldown) {
          modelState.inCooldown = false;
          modelState.consecutiveFailures = 0;
        }

        // Select this model and advance index
        state.currentModelIndex = (index + 1) % pool.models.length;
        state.lastSelectedModel = model.id;
        return model;
      }
    }

    // All models in cooldown or unavailable
    if (this.verbose) {
      console.warn(`[FallbackPool] All models for role ${role} are unavailable`);
    }
    return undefined;
  }

  /**
   * Record a successful call for a model.
   */
  recordSuccess(role: RoleName, modelId: string): void {
    const state = this.runtimeStates.get(role);
    if (!state) return;

    const modelState = state.modelStates.get(modelId);
    if (!modelState) return;

    modelState.successCount++;
    modelState.consecutiveFailures = 0;
    modelState.inCooldown = false;

    const pool = this.getPool(role);
    if (pool?.resetOnSuccess) {
      // Reset to primary model after success
      state.currentModelIndex = 0;
    }

    if (this.verbose) {
      console.log(`[FallbackPool] Model ${modelId} for role ${role} succeeded`);
    }
  }

  /**
   * Record a failed call for a model.
   */
  recordFailure(role: RoleName, modelId: string, error?: string): void {
    const state = this.runtimeStates.get(role);
    if (!state) return;

    const modelState = state.modelStates.get(modelId);
    if (!modelState) return;

    modelState.failureCount++;
    modelState.consecutiveFailures++;
    modelState.lastFailureTime = Date.now();
    modelState.inCooldown = true;

    if (this.verbose) {
      console.warn(
        `[FallbackPool] Model ${modelId} for role ${role} failed: ${error ?? 'unknown error'}`
      );
    }
  }

  /**
   * Get runtime statistics for a role.
   */
  getStats(role: RoleName): {
    models: Array<{
      id: string;
      successCount: number;
      failureCount: number;
      consecutiveFailures: number;
      inCooldown: boolean;
    }>;
    currentModelIndex: number;
  } | undefined {
    const state = this.runtimeStates.get(role);
    if (!state) return undefined;

    const models = Array.from(state.modelStates.values()).map((ms) => ({
      id: ms.modelId,
      successCount: ms.successCount,
      failureCount: ms.failureCount,
      consecutiveFailures: ms.consecutiveFailures,
      inCooldown: ms.inCooldown,
    }));

    return {
      models,
      currentModelIndex: state.currentModelIndex,
    };
  }

  /**
   * Reset all state for a role.
   */
  resetRole(role: RoleName): void {
    const pool = this.getPool(role);
    if (!pool) return;

    this.runtimeStates.set(role, this.createRuntimeState(pool));
  }

  /**
   * Reset all state.
   */
  resetAll(): void {
    this.initializeRuntimeStates();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a simple fallback pool from a list of models.
 */
export function createSimpleFallbackPool(
  role: RoleName,
  models: Array<{ id: string; model: string; providerId: string }>,
  strategy: 'priority' | 'round-robin' = 'priority'
): RoleFallbackPool {
  return {
    role,
    models: models.map((m, index) => ({
      id: m.id,
      model: m.model,
      providerId: m.providerId,
      priority: index,
      weight: 100,
      maxRetries: 3,
      timeoutMs: 60000,
    })),
    strategy,
    cooldownMs: 30000,
    resetOnSuccess: true,
  };
}

/**
 * Create a default fallback pool configuration from role configs.
 * This is useful for backward compatibility with single-model role configs.
 */
export function createFallbackPoolFromRoleConfigs(
  roleConfigs: Partial<Record<RoleName, { providerId: string; model: string }>>
): FallbackPoolConfig {
  const pools: Partial<Record<RoleName, RoleFallbackPool>> = {};

  for (const [role, config] of Object.entries(roleConfigs)) {
    if (!config) continue;
    pools[role as RoleName] = createSimpleFallbackPool(
      role as RoleName,
      [{ id: 'primary', model: config.model, providerId: config.providerId }]
    );
  }

  return { pools };
}

/**
 * Merge additional fallback models into an existing pool config.
 */
export function mergeFallbackModels(
  baseConfig: FallbackPoolConfig,
  fallbacks: Partial<Record<RoleName, Array<{ id: string; model: string; providerId: string }>>>
): FallbackPoolConfig {
  const newPools: Partial<Record<RoleName, RoleFallbackPool>> = { ...baseConfig.pools };

  for (const [role, models] of Object.entries(fallbacks)) {
    if (!models || models.length === 0) continue;

    const existingPool = newPools[role as RoleName];
    if (existingPool) {
      // Add fallbacks to existing pool
      const startIndex = existingPool.models.length;
      existingPool.models.push(
        ...models.map((m, i) => ({
          id: m.id,
          model: m.model,
          providerId: m.providerId,
          priority: startIndex + i,
          weight: 100,
          maxRetries: 3,
          timeoutMs: 60000,
        }))
      );
    } else {
      // Create new pool
      newPools[role as RoleName] = createSimpleFallbackPool(role as RoleName, models);
    }
  }

  return { ...baseConfig, pools: newPools };
}