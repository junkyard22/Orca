import { describe, expect, it } from "vitest";
import { brainBlocker, providerWarnings, resolveAllRoles, resolveRole } from "./providerResolution";
import type { OrcaSettings } from "./settings";

const anthropic = { id: "prov_d833", name: "anthropic", type: "anthropic" as const, baseUrl: "https://api.anthropic.com/v1", apiKey: "k" };
const ollama = { id: "prov_ol", name: "Ollama", type: "ollama" as const, baseUrl: "http://localhost:11434", apiKey: "" };
const keyless = { id: "prov_nokey", name: "OpenRouter", type: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", apiKey: "" };

const settings = (roles: OrcaSettings["roles"], providers = [anthropic, ollama, keyless]): Pick<OrcaSettings, "providers" | "roles"> => ({ providers, roles });

describe("role → provider resolution", () => {
  it("resolves by stable id, not by position", () => {
    const r = resolveRole(settings({ brain: { providerId: "prov_ol", model: "qwen2.5-coder" } }), "brain");
    expect(r).toMatchObject({ status: "ok", provider: ollama, model: "qwen2.5-coder" });
  });

  // The Summit laptop shape: the only provider is `anthropic` (prov_d833), but
  // Brain still references a removed provider.
  it("names a role whose provider no longer exists instead of skipping it silently", () => {
    const s = settings({ brain: { providerId: "prov_b911", model: "claude-opus-5-5" } }, [anthropic]);
    expect(resolveRole(s, "brain").status).toBe("missing_provider");
    expect(brainBlocker(s)).toMatch(/provider that no longer exists \(id prov_b911\)/);
    expect(providerWarnings(s)).toEqual([expect.stringMatching(/"brain" role references a provider that no longer exists/)]);
  });

  it("does not reassign a stale role to another provider", () => {
    const s = settings({ strong_model: { providerId: "prov_gone", model: "x" } }, [anthropic]);
    const r = resolveRole(s, "strong_model");
    expect(r.provider).toBeUndefined();
    expect(r.providerId).toBe("prov_gone");
    expect(r.model).toBe("x");
  });

  it("reports a provider without a key (non-Ollama) and accepts Ollama without one", () => {
    const s = settings({ brain: { providerId: "prov_nokey", model: "m" }, cheap_model: { providerId: "prov_ol", model: "llama3.2" } });
    expect(resolveRole(s, "brain").status).toBe("missing_key");
    expect(brainBlocker(s)).toMatch(/has no API key/);
    expect(resolveRole(s, "cheap_model").status).toBe("ok");
    expect(providerWarnings(s).join("\n")).not.toContain("k\n"); // never prints a key
  });

  it("reports fallbacks whose provider is gone and keeps the primary", () => {
    const s = settings({ reviewer: { providerId: "prov_d833", model: "claude-opus-5-5", fallbacks: [{ providerId: "prov_gone", model: "y" }, { providerId: "prov_ol", model: "z" }] } });
    const r = resolveRole(s, "reviewer");
    expect(r.status).toBe("ok");
    expect(r.missingFallbacks).toEqual([0]);
    expect(providerWarnings(s)).toEqual([expect.stringMatching(/"reviewer" fallback #1 references a provider that no longer exists/)]);
  });

  it("warns — but does not block — on an Anthropic model ID Orca does not recognise", () => {
    const s = settings({ brain: { providerId: "prov_d833", model: "claude-haiku-5-5" }, narrator: { providerId: "prov_d833", model: "claude-haiku-4-5" } });
    expect(brainBlocker(s)).toBeNull();
    const warnings = providerWarnings(s);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"brain" uses model "claude-haiku-5-5", which is not an Anthropic model ID Orca recognises/);
    expect(warnings[0]).toMatch(/kept as configured/);
  });

  it("does not warn about model IDs on gateways that use their own namespaces", () => {
    const or = { id: "prov_or", name: "OpenRouter", type: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
    expect(providerWarnings(settings({ brain: { providerId: "prov_or", model: "anthropic/claude-haiku-5-5" } }, [or]))).toEqual([]);
  });

  it("brainBlocker mirrors the init checks and is null when Brain can run", () => {
    expect(brainBlocker(settings({}))).toMatch(/Brain role not configured/);
    expect(brainBlocker(settings({ brain: { providerId: "prov_d833", model: "claude-opus-5-5" } }))).toBeNull();
    expect(resolveAllRoles(settings({})).every((r) => r.status === "unconfigured")).toBe(true);
  });
});
