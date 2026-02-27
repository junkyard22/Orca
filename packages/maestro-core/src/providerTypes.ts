/**
 * Provider Types and Constants — Pure type definitions.
 *
 * No external dependencies. Extracted from maestro-vscode/src/providerResolver.ts.
 * These types define the provider configuration contract for the core.
 */

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType =
  | 'openrouter'
  | 'deepseek'
  | 'siliconflow'
  | 'openai'
  | 'anthropic'
  | 'zai'
  | 'custom'
  | 'ollama';

export interface ProviderConfig {
  /** Stable provider ID (e.g., "openrouter_abc123") */
  id: string;
  /** Display name (e.g., "OpenRouter") */
  name: string;
  /** Provider type */
  type: ProviderType;
  /** API endpoint URL */
  baseUrl: string;
}

export interface RoleConfig {
  /** References ProviderConfig.id */
  providerId: string;
  /** Model name (e.g., "gpt-4o-mini") */
  model: string;
}

export interface ResolvedProvider {
  providerId: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ============================================================================
// Default Provider Base URLs
// ============================================================================

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  zai: 'https://api.z.ai/v1/chat/completions',
  custom: '',
  ollama: 'http://localhost:11434/v1/chat/completions'
};

// ============================================================================
// Provider ID Generation
// ============================================================================

/**
 * Generate a stable provider ID with a random hex suffix.
 * Uses crypto if available, falls back to Math.random.
 */
export function generateProviderId(type: string): string {
  const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${type}_${hex4()}${hex4()}`;
}
