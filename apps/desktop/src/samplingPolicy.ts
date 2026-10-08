/**
 * Which provider/model combinations accept a `temperature` request field.
 *
 * Anthropic removed sampling parameters starting with the Claude 4.7 generation:
 * Opus 4.7/4.8, Opus 5/5.5, Sonnet 5, Fable and Mythos reject `temperature`
 * with a 400 ("temperature is deprecated for this model"), and Sonnet 5.5 /
 * Haiku 5.5 reject any non-default value. Claude 4.6 and earlier still accept
 * it. Omitting the field is always valid — the API applies its default — so
 * for Anthropic we only send `temperature` to models positively identified as
 * a generation that accepts it, and omit it for newer or unrecognised IDs.
 *
 * Every other provider keeps its existing behaviour (temperature always sent).
 */

export interface SamplingProvider {
  type: string;
  baseUrl?: string;
}

/** Last Claude generation that still accepts `temperature`, as [major, minor]. */
const LAST_ANTHROPIC_TEMPERATURE_GENERATION: readonly [number, number] = [4, 6];

export function isAnthropicProvider(provider: SamplingProvider): boolean {
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
  if (!isAnthropicProvider(provider)) return true;
  return anthropicModelAcceptsTemperature(model);
}
