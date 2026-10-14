/**
 * Known model identifiers for providers whose catalog Orca cannot always query.
 *
 * This list is advisory. It never changes which model a role uses and never
 * blocks a request: a user may configure an ID that is newer than this list,
 * and the provider's own response is the final word. It exists so that
 * Settings can offer sensible choices when the provider's model endpoint is
 * unreachable, and so that initialisation can warn — not refuse — when a saved
 * ID is not one Orca recognises, which is the usual reason for a 404.
 *
 * Review the list against the provider's documentation when it changes and
 * update `ANTHROPIC_CATALOG_REVIEWED`.
 */

/** Date the Anthropic list below was last checked against Anthropic's model documentation. */
export const ANTHROPIC_CATALOG_REVIEWED = "2026-09-25";

/** Current Anthropic model IDs (API alias form, no date suffix) as documented on the review date. */
export const KNOWN_ANTHROPIC_MODELS: readonly string[] = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/**
 * Earlier IDs that still resolve at the API (dated snapshots and the 3.x/4.x
 * families). Accepted silently; not offered as defaults.
 */
const LEGACY_ANTHROPIC_PATTERN =
  /^claude-(?:3(?:-[57])?-(?:opus|sonnet|haiku)(?:-latest|-\d{8})?|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?|haiku-4-5-\d{8}|opus-4-1-\d{8}|sonnet-4-\d{8})$/i;

export type ModelIdStatus = "known" | "legacy" | "unknown";

/** Classify an Anthropic model ID. Gateways (OpenRouter etc.) use their own namespaces and are not checked. */
export function anthropicModelIdStatus(model: string): ModelIdStatus {
  const id = model.trim();
  if (KNOWN_ANTHROPIC_MODELS.includes(id)) return "known";
  if (LEGACY_ANTHROPIC_PATTERN.test(id)) return "legacy";
  return "unknown";
}
