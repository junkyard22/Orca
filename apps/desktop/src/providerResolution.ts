/**
 * Resolve each configured role to its provider, exactly as the main process
 * does at initialisation, and describe what is wrong when it cannot.
 *
 * Roles reference providers by stable id. When a provider is removed or
 * recreated the role keeps the old id; nothing here reassigns it — the user
 * does that in Settings — but every affected role is named clearly instead of
 * being skipped in silence, and the Settings <select> shows the same state
 * (see renderer/provider-options.js).
 */
import { anthropicModelIdStatus, ANTHROPIC_CATALOG_REVIEWED, isAnthropicEndpoint } from "@clawde/miranda-core";
import type { OrcaSettings, ProviderEntry, RoleEntry } from "./settings";

export const ALL_ROLE_NAMES = [
  "brain", "strong_model", "cheap_model", "utility",
  "reviewer", "narrator", "planner_deep", "debugger", "reader", "vision",
] as const;

export type RoleProviderStatus =
  | "unconfigured"      // no provider or model assigned
  | "missing_provider"  // providerId no longer matches a configured provider
  | "missing_key"       // provider exists but has no API key (non-Ollama)
  | "ok";

export interface RoleResolution {
  role: string;
  status: RoleProviderStatus;
  providerId: string;
  model: string;
  provider?: ProviderEntry;
  /** Fallback entries whose provider is missing, by index. */
  missingFallbacks: number[];
}

export function resolveRole(settings: Pick<OrcaSettings, "providers" | "roles">, role: string): RoleResolution {
  const entry: RoleEntry | undefined = settings.roles?.[role];
  const providerId = entry?.providerId ?? "";
  const model = entry?.model ?? "";
  const providers = settings.providers ?? [];
  const missingFallbacks = (entry?.fallbacks ?? [])
    .map((fallback, index) => (providers.some((p) => p.id === fallback.providerId) ? -1 : index))
    .filter((index) => index >= 0);
  if (!providerId || !model) return { role, status: "unconfigured", providerId, model, missingFallbacks };
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return { role, status: "missing_provider", providerId, model, missingFallbacks };
  if (provider.type !== "ollama" && !provider.apiKey) return { role, status: "missing_key", providerId, model, provider, missingFallbacks };
  return { role, status: "ok", providerId, model, provider, missingFallbacks };
}

export function resolveAllRoles(settings: Pick<OrcaSettings, "providers" | "roles">): RoleResolution[] {
  return ALL_ROLE_NAMES.map((role) => resolveRole(settings, role));
}

/**
 * User-facing warnings for roles that cannot run as configured. Never includes
 * an API key. Unconfigured optional roles are not warned about here (the core
 * roles have their own existing warning).
 */
export function providerWarnings(settings: Pick<OrcaSettings, "providers" | "roles">): string[] {
  const warnings: string[] = [];
  for (const r of resolveAllRoles(settings)) {
    if (r.status === "missing_provider") {
      warnings.push(`"${r.role}" role references a provider that no longer exists (id ${r.providerId}); it will not run until you reassign it in ⚙ Settings.`);
    } else if (r.status === "missing_key") {
      warnings.push(`"${r.role}" role uses provider "${r.provider?.name ?? r.providerId}", which has no API key; add one in ⚙ Settings.`);
    }
    for (const index of r.missingFallbacks) {
      warnings.push(`"${r.role}" fallback #${index + 1} references a provider that no longer exists and will be skipped.`);
    }
    if (r.status === "ok" && r.provider && isAnthropicEndpoint(r.provider) && anthropicModelIdStatus(r.model) === "unknown") {
      warnings.push(`"${r.role}" uses model "${r.model}", which is not an Anthropic model ID Orca recognises (catalog reviewed ${ANTHROPIC_CATALOG_REVIEWED}). It is kept as configured; if requests fail with 404, check the ID in Anthropic's model list.`);
    }
  }
  return warnings;
}

/** The exact reason Brain cannot start, or null when it can. Mirrors the init check. */
export function brainBlocker(settings: Pick<OrcaSettings, "providers" | "roles">): string | null {
  const brain = resolveRole(settings, "brain");
  switch (brain.status) {
    case "unconfigured":
      return "Brain role not configured.\nClick ⚙ Settings → add a provider and assign it to the Brain role.";
    case "missing_provider":
      return `Brain role points to a provider that no longer exists (id ${brain.providerId}).\nClick ⚙ Settings and reassign the Brain role to a configured provider.`;
    case "missing_key":
      return `Provider "${brain.provider?.name ?? brain.providerId}" has no API key.\nClick ⚙ Settings to add it.`;
    default:
      return null;
  }
}
