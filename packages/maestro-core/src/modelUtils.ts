/**
 * Model Utilities — Pure functions for model ID normalization,
 * config keyword detection, and config snapshot formatting.
 *
 * No external dependencies. Extracted from maestro-vscode/src/effectiveConfig.ts.
 */

import { ProviderType, ProviderConfig } from './providerTypes';
import { RoleName, CoreRoleName, OptionalRoleName, getCoreRoles, getOptionalRoles, OPTIONAL_ROLE_METADATA } from './roleSelector';

// ============================================================================
// Model ID Normalization
// ============================================================================

export interface NormalizedModelId {
  providerPrefix?: string;
  modelIdNormalized: string;
}

/**
 * Normalize model ID by removing redundant provider prefix.
 *
 * Examples:
 * - "openai:gpt-4o-mini" + providerType="openai" → "gpt-4o-mini"
 * - "gpt-4o-mini" + providerType="openai" → "gpt-4o-mini"
 * - "openai/gpt-4o-mini" + providerType="openrouter" → "openai/gpt-4o-mini"
 * - "siliconflow:Qwen/Qwen2.5-72B" + providerType="siliconflow" → "Qwen/Qwen2.5-72B"
 */
export function normalizeModelId(modelRaw: string, providerType: ProviderType): NormalizedModelId {
  if (!modelRaw || typeof modelRaw !== 'string') {
    return { modelIdNormalized: '' };
  }

  const colonIndex = modelRaw.indexOf(':');
  if (colonIndex > 0) {
    const prefix = modelRaw.substring(0, colonIndex).toLowerCase();
    const modelId = modelRaw.substring(colonIndex + 1);

    if (prefix === providerType.toLowerCase()) {
      return {
        providerPrefix: prefix,
        modelIdNormalized: modelId
      };
    }

    return {
      providerPrefix: prefix,
      modelIdNormalized: modelRaw
    };
  }

  return { modelIdNormalized: modelRaw };
}

// ============================================================================
// Effective Config Types
// ============================================================================

export interface RoleEffectiveConfig {
  providerType: ProviderType;
  providerId?: string;
  baseUrl: string;
  modelRaw: string;
  modelNormalized: string;
  keyStatus: 'SET' | 'MISSING';
  source: 'providersFirst' | 'legacy' | 'fallback';
  isOptional?: boolean;
  isConfigured?: boolean;
}

export type ConfigMode = 'providersFirst' | 'legacy' | 'mixed';

export interface EffectiveConfig {
  mode: ConfigMode;
  roles: Record<RoleName, RoleEffectiveConfig>;
  providers: ProviderConfig[];
  warnings: string[];
  timestamp: number;
}

// ============================================================================
// Configuration Keyword Detection
// ============================================================================

const CONFIG_QUERY_PATTERNS = [
  /what\s+(?:is|are)\s+(?:my|the)\s+(?:current\s+)?(?:settings?|config|configuration|providers?|models?)/i,
  /show\s+(?:me\s+)?(?:my|the)\s+(?:settings?|config|configuration|providers?|models?)/i,
  /check\s+(?:my|the)\s+(?:settings?|config|configuration|providers?|models?)/i,
  /display\s+(?:my|the)\s+(?:settings?|config|configuration|providers?|models?)/i,
  /list\s+(?:my|the)\s+(?:providers?|models?|api\s+keys?)/i,
  /(?:configure|setup|change|update|modify|set)\s+maestro/i,
  /maestro\s+(?:settings?|config|configuration|setup)/i,
  /(?:sync|migrate)\s+(?:settings?|config|to\s+yaml)/i,
  /(?:configure|setup|add|change)\s+(?:my\s+)?(?:brain|coder|utility|reviewer|narrator)\s+(?:model|provider|role)/i,
  /(?:openrouter|deepseek|siliconflow|anthropic|openai)\s+(?:setup|config|api\s+key)/i,
  /validate\s+(?:my\s+)?(?:settings?|config|configuration)/i,
  /check\s+(?:my\s+)?(?:maestro\s+)?(?:settings?|config)/i,
];

const BUG_FIX_INDICATORS = [
  /fix\s+(?:line|syntax|error|issue|bug|these)/i,
  /add\s+(?:missing|to)\s+(?:dependencies|package\.json)/i,
  /(?:dockerfile|server\.js|package\.json|\.env)/i,
  /line\s+\d+/i,
  /missing\s+(?:comma|value|parameter|dependency)/i,
];

/**
 * Check if a user prompt is querying Maestro's own configuration.
 */
export function shouldAttachConfigSnapshot(userPrompt: string): boolean {
  const isBugFix = BUG_FIX_INDICATORS.some(pattern => pattern.test(userPrompt));
  if (isBugFix) {
    return false;
  }

  return CONFIG_QUERY_PATTERNS.some(pattern => pattern.test(userPrompt));
}

/**
 * Format effective config as human-readable text for Brain context.
 */
export function formatEffectiveConfigForBrain(config: EffectiveConfig): string {
  const lines: string[] = [];

  lines.push('=== EFFECTIVE CONFIGURATION STATE (Source of Truth) ===');
  lines.push(`Mode: ${config.mode}`);
  lines.push(`Timestamp: ${new Date(config.timestamp).toISOString()}`);
  lines.push('');

  if (config.warnings.length > 0) {
    lines.push('WARNINGS:');
    config.warnings.forEach(w => lines.push(`  - ${w}`));
    lines.push('');
  }

  lines.push('CORE ROLES (Always Available):');
  const coreRoles = getCoreRoles();
  for (const role of coreRoles) {
    const rc = config.roles[role];
    if (!rc) { continue; }
    lines.push(`  ${role}:`);
    lines.push(`    Provider: ${rc.providerType}${rc.providerId ? ` (${rc.providerId})` : ''}`);
    lines.push(`    Model: ${rc.modelNormalized} ${rc.modelRaw !== rc.modelNormalized ? `(raw: ${rc.modelRaw})` : ''}`);
    lines.push(`    Base URL: ${rc.baseUrl || 'NOT SET'}`);
    lines.push(`    API Key: ${rc.keyStatus}`);
    lines.push(`    Source: ${rc.source}`);
    lines.push('');
  }

  lines.push('OPTIONAL SPECIALIST ROLES:');
  const optionalRoles = getOptionalRoles();
  for (const role of optionalRoles) {
    const rc = config.roles[role];
    const metadata = OPTIONAL_ROLE_METADATA[role];

    lines.push(`  ${role}:`);
    lines.push(`    Purpose: ${metadata.purpose}`);
    lines.push(`    Trigger: ${metadata.trigger}`);
    lines.push(`    Fallback: ${metadata.fallback}`);

    if (rc?.isConfigured) {
      lines.push(`    Status: CONFIGURED`);
      lines.push(`    Provider: ${rc.providerType}${rc.providerId ? ` (${rc.providerId})` : ''}`);
      lines.push(`    Model: ${rc.modelNormalized}`);
      lines.push(`    API Key: ${rc.keyStatus}`);
    } else {
      lines.push(`    Status: NOT CONFIGURED (will use fallback: ${metadata.fallback})`);
    }
    lines.push('');
  }

  if (config.mode === 'providersFirst' && config.providers.length > 0) {
    lines.push('CONFIGURED PROVIDERS:');
    config.providers.forEach(p => {
      lines.push(`  - ${p.name} (${p.type})`);
      lines.push(`    ID: ${p.id}`);
      lines.push(`    Base URL: ${p.baseUrl}`);
    });
    lines.push('');
  }

  lines.push('IMPORTANT: This is the actual persisted state. Use this information to answer config questions.');
  lines.push('DO NOT guess or assume different values. If something is MISSING, state that clearly.');

  return lines.join('\n');
}
