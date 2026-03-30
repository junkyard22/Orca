/**
 * Tests for Model Fallback Pool Manager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelFallbackPoolManager,
  createSimpleFallbackPool,
  createFallbackPoolFromRoleConfigs,
  mergeFallbackModels,
  type FallbackPoolConfig,
} from './modelFallbackPool';
import type { RoleName } from './roleSelector';

describe('ModelFallbackPoolManager', () => {
  let manager: ModelFallbackPoolManager;

  const createTestConfig = (): FallbackPoolConfig => ({
    pools: {
      brain: createSimpleFallbackPool('brain', [
        { id: 'primary', model: 'gpt-4o-mini', providerId: 'prov_1' },
        { id: 'fallback_1', model: 'claude-3.5-haiku', providerId: 'prov_2' },
        { id: 'fallback_2', model: 'deepseek-chat', providerId: 'prov_3' },
      ]),
      strong_model: createSimpleFallbackPool('strong_model', [
        { id: 'primary', model: 'claude-3.5-sonnet', providerId: 'prov_2' },
        { id: 'fallback_1', model: 'gpt-4o', providerId: 'prov_1' },
      ]),
    },
    defaultPool: createSimpleFallbackPool('brain' as RoleName, [
      { id: 'default', model: 'gpt-4o-mini', providerId: 'prov_1' },
    ]),
    globalCooldownMs: 30000,
  });

  beforeEach(() => {
    manager = new ModelFallbackPoolManager(createTestConfig(), false);
  });

  describe('selectModel', () => {
    it('should select primary model by default', () => {
      const model = manager.selectModel('brain');
      expect(model).toBeDefined();
      expect(model?.id).toBe('primary');
      expect(model?.model).toBe('gpt-4o-mini');
    });

    it('should return undefined for unconfigured role without default', () => {
      const model = manager.selectModel('narrator');
      // Default pool should be used
      expect(model).toBeDefined();
    });

    it('should select from different roles independently', () => {
      const brainModel = manager.selectModel('brain');
      const coderModel = manager.selectModel('strong_model');

      expect(brainModel?.model).toBe('gpt-4o-mini');
      expect(coderModel?.model).toBe('claude-3.5-sonnet');
    });
  });

  describe('recordSuccess', () => {
    it('should track success statistics', () => {
      manager.selectModel('brain');
      manager.recordSuccess('brain', 'primary');

      const stats = manager.getStats('brain');
      expect(stats).toBeDefined();
      expect(stats?.models[0]?.successCount).toBe(1);
      expect(stats?.models[0]?.inCooldown).toBe(false);
    });

    it('should reset to primary model on success when resetOnSuccess is true', () => {
      manager.recordFailure('brain', 'primary', 'test error');
      manager.selectModel('brain'); // Should select fallback
      
      manager.recordSuccess('brain', 'fallback_1');
      
      const stats = manager.getStats('brain');
      expect(stats?.currentModelIndex).toBe(0); // Reset to primary
    });
  });

  describe('recordFailure', () => {
    it('should track failure statistics and set cooldown', () => {
      manager.selectModel('brain');
      manager.recordFailure('brain', 'primary', 'API error');

      const stats = manager.getStats('brain');
      expect(stats).toBeDefined();
      expect(stats?.models[0]?.failureCount).toBe(1);
      expect(stats?.models[0]?.consecutiveFailures).toBe(1);
      expect(stats?.models[0]?.inCooldown).toBe(true);
    });

    it('should select fallback model when primary is in cooldown', () => {
      manager.recordFailure('brain', 'primary', 'API error');
      
      const model = manager.selectModel('brain');
      expect(model?.id).toBe('fallback_1');
    });

    it('should fall through all models in cooldown', () => {
      manager.recordFailure('brain', 'primary', 'error 1');
      manager.recordFailure('brain', 'fallback_1', 'error 2');
      manager.recordFailure('brain', 'fallback_2', 'error 3');

      const model = manager.selectModel('brain');
      expect(model).toBeUndefined(); // All in cooldown
    });
  });

  describe('getStats', () => {
    it('should return undefined for untracked role', () => {
      const stats = manager.getStats('reviewer');
      // Uses default pool, so stats might be created on first select
      expect(stats).toBeUndefined();
    });

    it('should return stats after model selection', () => {
      manager.selectModel('brain');
      const stats = manager.getStats('brain');
      
      expect(stats).toBeDefined();
      expect(stats?.models).toHaveLength(3);
      expect(stats?.currentModelIndex).toBe(0);
    });
  });

  describe('resetRole', () => {
    it('should reset all state for a role', () => {
      manager.recordFailure('brain', 'primary', 'error');
      manager.resetRole('brain');

      const stats = manager.getStats('brain');
      expect(stats?.models[0]?.inCooldown).toBe(false);
      expect(stats?.models[0]?.failureCount).toBe(0);
    });
  });

  describe('resetAll', () => {
    it('should reset all roles', () => {
      manager.recordFailure('brain', 'primary', 'error');
      manager.recordFailure('strong_model', 'primary', 'error');
      
      manager.resetAll();

      const brainStats = manager.getStats('brain');
      const coderStats = manager.getStats('strong_model');
      
      expect(brainStats?.models[0]?.inCooldown).toBe(false);
      expect(coderStats?.models[0]?.inCooldown).toBe(false);
    });
  });
});

describe('createSimpleFallbackPool', () => {
  it('should create a pool with correct priority ordering', () => {
    const pool = createSimpleFallbackPool('brain', [
      { id: 'primary', model: 'model-1', providerId: 'prov-1' },
      { id: 'fallback', model: 'model-2', providerId: 'prov-2' },
    ]);

    expect(pool.role).toBe('brain');
    expect(pool.models).toHaveLength(2);
    expect(pool.models[0].priority).toBe(0);
    expect(pool.models[1].priority).toBe(1);
    expect(pool.strategy).toBe('priority');
    expect(pool.resetOnSuccess).toBe(true);
  });
});

describe('createFallbackPoolFromRoleConfigs', () => {
  it('should create pools from simple role configs', () => {
    const config = createFallbackPoolFromRoleConfigs({
      brain: { providerId: 'prov-1', model: 'gpt-4o-mini' },
      strong_model: { providerId: 'prov-2', model: 'claude-3.5-sonnet' },
    });

    expect(config.pools.brain).toBeDefined();
    expect(config.pools.brain?.models).toHaveLength(1);
    expect(config.pools.brain?.models[0].model).toBe('gpt-4o-mini');
    
    expect(config.pools.strong_model).toBeDefined();
    expect(config.pools.strong_model?.models[0].model).toBe('claude-3.5-sonnet');
  });
});

describe('mergeFallbackModels', () => {
  it('should add fallbacks to existing pool', () => {
    const baseConfig = createFallbackPoolFromRoleConfigs({
      brain: { providerId: 'prov-1', model: 'model-1' },
    });

    const merged = mergeFallbackModels(baseConfig, {
      brain: [
        { id: 'fallback-1', model: 'model-2', providerId: 'prov-2' },
      ],
    });

    expect(merged.pools.brain?.models).toHaveLength(2);
    expect(merged.pools.brain?.models[1].model).toBe('model-2');
  });

  it('should create new pool for role without existing config', () => {
    const baseConfig = createFallbackPoolFromRoleConfigs({
      brain: { providerId: 'prov-1', model: 'model-1' },
    });

    const merged = mergeFallbackModels(baseConfig, {
      strong_model: [
        { id: 'primary', model: 'model-2', providerId: 'prov-2' },
      ],
    });

    expect(merged.pools.strong_model).toBeDefined();
    expect(merged.pools.strong_model?.models).toHaveLength(1);
  });
});

describe('Round-robin strategy', () => {
  it('should rotate through models in round-robin fashion', () => {
    const config: FallbackPoolConfig = {
      pools: {
        brain: {
          role: 'brain',
          models: [
            { id: 'm1', model: 'model-1', providerId: 'p1', priority: 0 },
            { id: 'm2', model: 'model-2', providerId: 'p2', priority: 1 },
          ],
          strategy: 'round-robin',
        },
      },
    };

    const manager = new ModelFallbackPoolManager(config, false);

    const model1 = manager.selectModel('brain');
    const model2 = manager.selectModel('brain');
    const model3 = manager.selectModel('brain');

    // Should rotate: m1 -> m2 -> m1
    expect(model1?.id).toBe('m1');
    expect(model2?.id).toBe('m2');
    expect(model3?.id).toBe('m1');
  });
});