/**
 * Miranda Core — model price catalog and resolution.
 *
 * A price is known only when it was reviewed against the provider's own
 * published rates for that exact provider endpoint and model ID. Nothing here
 * infers a rate from a similar name, another provider's listing of the same
 * model, or a generic default. What Orca cannot price it reports as unknown,
 * and the budget ledger decides what that means for the request.
 *
 * Local inference (Ollama, loopback or private-network endpoints) has no
 * external API charge; its electricity, hardware and hosting costs are real
 * but unknown to Orca, and are reported as such rather than as zero.
 */
import { isAnthropicEndpoint } from "../llm/samplingPolicy.js";

export interface ModelTariff {
  /** USD per million input tokens. */
  inputPer1M: number;
  /** USD per million output tokens (reasoning/thinking tokens are billed as output on every provider Orca knows). */
  outputPer1M: number;
  /** USD per million cached input tokens read, when the provider reports cache reads. */
  cacheReadPer1M?: number;
  /** USD per million cached input tokens written. */
  cacheWritePer1M?: number;
}

export interface CatalogPrice extends ModelTariff {
  /** Provider endpoint family the price was reviewed for. */
  provider: "anthropic";
  /** Exact model ID as sent to the provider. */
  model: string;
  /** Documented input (context) limit in tokens. */
  maxInputTokens?: number;
  /** Documented synchronous output limit in tokens. */
  maxOutputTokens?: number;
  /** A second tariff that applies to a request whose prompt exceeds the threshold (Claude Haiku 5.5). */
  longPrompt?: ModelTariff & { thresholdTokens: number };
  /** ISO date the row was checked against `source`. */
  reviewed: string;
  source: string;
  note?: string;
}

/** A price the user configured for a model Orca cannot price itself. */
export interface CustomModelPrice extends ModelTariff {
  /** Settings provider id the price applies to (omit for any provider of `providerType`). */
  providerId?: string;
  providerType?: string;
  model: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  note?: string;
}

export interface PriceProvider {
  id?: string;
  type: string;
  name?: string;
  baseUrl?: string;
}

export type PriceStatus =
  /** Reviewed catalog price for this endpoint and model. */
  | "known"
  /** Price the user configured in Settings. */
  | "custom"
  /** Local inference: no external API charge; economic cost unknown. */
  | "local"
  /** Catalog price older than the allowed age; not trusted for a hard budget. */
  | "stale"
  /** No price on record. */
  | "unknown";

export interface PriceResolution {
  status: PriceStatus;
  model: string;
  providerLabel: string;
  tariff?: ModelTariff;
  longPrompt?: ModelTariff & { thresholdTokens: number };
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reviewed?: string;
  source?: string;
  /** One sentence a user can act on. */
  note: string;
}

const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_MODELS_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";
/** Date the Anthropic rows below were checked against the published pricing and models pages. */
export const ANTHROPIC_PRICES_REVIEWED = "2026-10-12";
/** Catalog rows older than this are reported `stale` and are not trusted for a hard budget. */
export const PRICE_MAX_AGE_DAYS = 120;

const anthropic = (model: string, inputPer1M: number, outputPer1M: number, cacheReadPer1M: number, cacheWritePer1M: number, extra: Partial<CatalogPrice> = {}): CatalogPrice => ({
  provider: "anthropic",
  model,
  inputPer1M,
  outputPer1M,
  cacheReadPer1M,
  cacheWritePer1M,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 128_000,
  reviewed: ANTHROPIC_PRICES_REVIEWED,
  source: `${ANTHROPIC_PRICING_SOURCE} ; limits: ${ANTHROPIC_MODELS_SOURCE}`,
  ...extra,
});

/**
 * Anthropic API (api.anthropic.com) standard rates, USD per million tokens,
 * reviewed 2026-10-12. Cache write = 5-minute cache write price; cache read =
 * "cache hits and refreshes". Long context (over 200k) is standard pricing on
 * these models. Batch, fast-mode and regional multipliers are not modelled:
 * Orca sends ordinary synchronous requests.
 */
export const ANTHROPIC_PRICES: readonly CatalogPrice[] = [
  anthropic("claude-fable-5-1", 10, 50, 0.25, 12.5),
  anthropic("claude-fable-5", 10, 50, 1, 12.5),
  anthropic("claude-opus-5-5", 4, 20, 0.2, 5),
  anthropic("claude-opus-5", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-8", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-7", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-6", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-5", 5, 25, 0.5, 6.25, { maxInputTokens: 200_000, maxOutputTokens: 64_000, note: "pre-4.6 generation: 200k context assumed; verify before relying on larger prompts" }),
  anthropic("claude-sonnet-5-5", 2, 10, 0.1, 2.5),
  anthropic("claude-sonnet-5", 2, 10, 0.2, 2.5),
  anthropic("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
  anthropic("claude-sonnet-4-5", 3, 15, 0.3, 3.75, { maxInputTokens: 200_000, maxOutputTokens: 64_000, note: "pre-4.6 generation: 200k context assumed; verify before relying on larger prompts" }),
  anthropic("claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125, {
    longPrompt: { thresholdTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadPer1M: 0.05, cacheWritePer1M: 0.625 },
    note: "priced by prompt length: a request whose prompt exceeds 100,000 tokens pays the higher tariff for the whole request",
  }),
  anthropic("claude-haiku-4-5", 1, 5, 0.1, 1.25, { maxInputTokens: 200_000, maxOutputTokens: 64_000, note: "pre-4.6 generation: 200k context assumed; verify before relying on larger prompts" }),
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/** True for an endpoint on this machine or a private network: inference Orca is not billed for by an API vendor. */
export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".localhost")) return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } catch {
    return false;
  }
}

function ageInDays(reviewed: string, now: Date): number {
  const t = Date.parse(reviewed);
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : Number.POSITIVE_INFINITY;
}

export interface PriceLookup {
  provider: PriceProvider;
  model: string;
  customPrices?: readonly CustomModelPrice[];
  now?: Date;
  maxAgeDays?: number;
}

function label(provider: PriceProvider): string {
  return provider.name || provider.type;
}

/**
 * Resolve the price for a request. Order: a user-configured price for this
 * provider and model, the reviewed catalog for this endpoint family, local
 * inference, otherwise unknown. A catalog row older than `maxAgeDays` is
 * `stale`: usable for an estimate, never for a hard budget.
 */
export function resolvePrice(lookup: PriceLookup): PriceResolution {
  const { provider, model } = lookup;
  const now = lookup.now ?? new Date();
  const maxAge = lookup.maxAgeDays ?? PRICE_MAX_AGE_DAYS;
  const providerLabel = label(provider);

  const custom = (lookup.customPrices ?? []).find((p) =>
    p.model === model && ((p.providerId && p.providerId === provider.id) || (!p.providerId && (!p.providerType || p.providerType === provider.type))));
  if (custom) {
    return {
      status: "custom", model, providerLabel,
      tariff: { inputPer1M: custom.inputPer1M, outputPer1M: custom.outputPer1M, ...(custom.cacheReadPer1M !== undefined ? { cacheReadPer1M: custom.cacheReadPer1M } : {}) },
      ...(custom.maxInputTokens !== undefined ? { maxInputTokens: custom.maxInputTokens } : {}),
      ...(custom.maxOutputTokens !== undefined ? { maxOutputTokens: custom.maxOutputTokens } : {}),
      note: `user-configured price for ${model} on ${providerLabel}${custom.note ? ` (${custom.note})` : ""}`,
    };
  }

  if (isAnthropicEndpoint({ type: provider.type, baseUrl: provider.baseUrl })) {
    const row = ANTHROPIC_PRICES.find((p) => p.model === model);
    if (row) {
      const stale = ageInDays(row.reviewed, now) > maxAge;
      return {
        status: stale ? "stale" : "known", model, providerLabel,
        tariff: { inputPer1M: row.inputPer1M, outputPer1M: row.outputPer1M, cacheReadPer1M: row.cacheReadPer1M, cacheWritePer1M: row.cacheWritePer1M },
        ...(row.longPrompt ? { longPrompt: row.longPrompt } : {}),
        maxInputTokens: row.maxInputTokens,
        maxOutputTokens: row.maxOutputTokens,
        reviewed: row.reviewed,
        source: row.source,
        note: stale
          ? `the catalog price for ${model} was reviewed on ${row.reviewed}, more than ${maxAge} days ago; re-check ${ANTHROPIC_PRICING_SOURCE} or set a custom price in Settings`
          : `Anthropic standard rate for ${model}, reviewed ${row.reviewed}${row.note ? `; ${row.note}` : ""}`,
      };
    }
    return { status: "unknown", model, providerLabel, note: `no reviewed price for ${model} on the Anthropic API; check ${ANTHROPIC_PRICING_SOURCE} and set a custom price in Settings` };
  }

  if (provider.type === "ollama" || isLocalEndpoint(provider.baseUrl)) {
    return {
      status: "local", model, providerLabel,
      tariff: { inputPer1M: 0, outputPer1M: 0 },
      note: `${providerLabel} is local inference: no external API charge is metered; electricity, hardware and hosting costs are not accounted`,
    };
  }

  return {
    status: "unknown", model, providerLabel,
    note: `no reviewed price for ${model} on ${providerLabel}; set a custom price for this model in Settings (OpenRouter publishes per-model prices at /api/v1/models)`,
  };
}

/** The tariff that applies to a request of `promptTokens` input tokens (tiered models). */
export function tariffForPrompt(price: PriceResolution, promptTokens: number): ModelTariff | undefined {
  if (!price.tariff) return undefined;
  if (price.longPrompt && promptTokens > price.longPrompt.thresholdTokens) return price.longPrompt;
  return price.tariff;
}
