/**
 * Which provider/model combinations accept a `temperature` request field.
 *
 * Anthropic removed sampling parameters starting with the Claude 4.7
 * generation: Opus 4.7/4.8, Opus 5/5.5, Sonnet 5, Fable 5/5.1 reject
 * `temperature` with a 400 ("temperature is deprecated for this model"), and
 * Sonnet 5.5 rejects any non-default value. Claude 4.6 and earlier (Opus 4.6,
 * Sonnet 4.6, Haiku 4.5, the 3.x and 4.x families) still accept it. Omitting
 * the field is always valid — the API applies its default — so for Anthropic
 * endpoints `temperature` is sent only to models positively identified as a
 * generation that accepts it, and omitted for newer or unrecognised IDs.
 *
 * Every other provider keeps its existing behaviour (temperature always sent),
 * including OpenRouter and other gateways that front Claude models: they
 * translate or drop the field themselves.
 *
 * This is a request-shape policy for the adapter layer. It never changes
 * which model a role uses.
 */

export interface SamplingProvider {
  type: string;
  baseUrl?: string;
}

/** Last Claude generation that still accepts `temperature`, as [major, minor]. */
export const LAST_ANTHROPIC_TEMPERATURE_GENERATION: readonly [number, number] = [4, 6];

/** True for Anthropic's own endpoint, by provider type or by host. */
export function isAnthropicEndpoint(provider: SamplingProvider): boolean {
  if (provider.type === "anthropic") return true;
  try {
    return new URL(provider.baseUrl ?? "").hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Parse a Claude model ID into its [major, minor] generation, or null when the
 * ID isn't a recognisable Claude model. Handles both naming schemes:
 *   claude-3-5-sonnet-20241022, claude-3-opus-latest   (version before family)
 *   claude-sonnet-4-6, claude-opus-4-1-20250805,
 *   claude-sonnet-4-20250514, claude-opus-5-5          (family before version)
 * A trailing 8-digit date is a snapshot suffix, not a minor version.
 */
export function claudeGeneration(model: string): [number, number] | null {
  const id = model.trim().toLowerCase().replace(/^anthropic[./]/, "");

  const versionFirst = /^claude-(\d+)(?:-(\d{1,2}))?-[a-z]/.exec(id);
  if (versionFirst) {
    return [Number(versionFirst[1]), Number(versionFirst[2] ?? 0)];
  }

  const familyFirst = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:$|[-@])/.exec(id);
  if (familyFirst) {
    return [Number(familyFirst[1]), Number(familyFirst[2] ?? 0)];
  }

  return null;
}

export function anthropicModelAcceptsTemperature(model: string): boolean {
  const generation = claudeGeneration(model);
  if (!generation) return false;
  const [major, minor] = generation;
  const [lastMajor, lastMinor] = LAST_ANTHROPIC_TEMPERATURE_GENERATION;
  return major < lastMajor || (major === lastMajor && minor <= lastMinor);
}

export function providerAcceptsTemperature(provider: SamplingProvider, model: string): boolean {
  if (!isAnthropicEndpoint(provider)) return true;
  return anthropicModelAcceptsTemperature(model);
}

/**
 * Anthropic documents `thinking`, not the nonstandard `enable_thinking` field
 * some OpenAI-compatible providers accept. Sending it there is rejected, so the
 * adapter leaves Anthropic's default intact rather than inventing a mode.
 */
export function providerAcceptsEnableThinking(provider: SamplingProvider): boolean {
  return !isAnthropicEndpoint(provider);
}
