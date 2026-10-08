import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { buildProviderOptions } = requireCjs("../renderer/provider-options.js") as {
  buildProviderOptions: (providers: unknown, currentProviderId: string) => string;
};

interface Provider { id: string; name: string; type: string; baseUrl?: string }

/**
 * The option a <select> shows for the given markup: the first option marked
 * `selected`, otherwise the first option (standard HTML single-select behaviour).
 */
function displayedOption(html: string): { value: string; label: string } {
  const options = [...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)];
  const chosen = options.find((m) => m[2]) ?? options[0];
  return { value: chosen[1], label: chosen[3] };
}

/** Mirrors the main-process Live AI readiness lookup in main.ts (initOrca). */
function resolveLikeMainProcess(providers: Provider[], providerId: string): Provider | undefined {
  return providers.find((p) => p.id === providerId);
}

describe("buildProviderOptions — stale role provider id", () => {
  // Exact shape of the failing Summit laptop settings: the only provider is
  // `anthropic` (prov_d833), but Brain still references a removed provider.
  const providers: Provider[] = [
    { id: "prov_d833", name: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  ];
  const brain = { providerId: "prov_b911", model: "claude-haiku-5-5" };

  it("does not display an unrelated provider as the Brain assignment", () => {
    const shown = displayedOption(buildProviderOptions(providers, brain.providerId));

    // Before the fix the browser fell back to the first option and showed
    // "anthropic", while the main process rejected Brain as "unknown provider".
    expect(shown.label).not.toBe("anthropic");
    expect(shown.value).toBe("");
    expect(shown.label).toMatch(/provider missing/i);
  });

  it("agrees with the main-process readiness lookup", () => {
    const shown = displayedOption(buildProviderOptions(providers, brain.providerId));
    const resolved = resolveLikeMainProcess(providers, brain.providerId);

    expect(resolved).toBeUndefined();
    expect(providers.some((p) => p.id === shown.value)).toBe(false);
  });

  it("still offers the configured provider so the role can be re-assigned", () => {
    const html = buildProviderOptions(providers, brain.providerId);
    expect(html).toContain('<option value="prov_d833">anthropic</option>');
  });
});

describe("buildProviderOptions — existing behaviour", () => {
  const providers: Provider[] = [
    { id: "prov_a", name: "openrouter", type: "openrouter" },
    { id: "prov_b", name: "anthropic", type: "anthropic" },
  ];

  it("selects the provider whose id matches, not the first one", () => {
    const shown = displayedOption(buildProviderOptions(providers, "prov_b"));
    expect(shown).toEqual({ value: "prov_b", label: "anthropic" });
    expect(resolveLikeMainProcess(providers, shown.value)?.name).toBe("anthropic");
  });

  it("shows a neutral placeholder when the role has no provider", () => {
    const shown = displayedOption(buildProviderOptions(providers, ""));
    expect(shown).toEqual({ value: "", label: "— select —" });
  });

  it("asks for a provider when none are configured", () => {
    expect(buildProviderOptions([], "prov_b911")).toBe('<option value="">— add a provider first —</option>');
    expect(buildProviderOptions(undefined, "")).toBe('<option value="">— add a provider first —</option>');
  });

  it("escapes provider names", () => {
    const html = buildProviderOptions([{ id: "p1", name: "<b>x</b>", type: "openai" }], "p1");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });
});
