/**
 * Model listing for providers that have a documented list endpoint.
 *
 * The result says whether the names came from the provider ("listed") or
 * from Orca's built-in list ("fallback"). A fallback is still useful for
 * autocomplete, but it proves nothing about availability or the API key, so
 * the caller must say so instead of reporting "N models loaded" as if the
 * provider had answered. Found during the 1.7.0 rehearsal preparation: a
 * failed Anthropic listing was shown as a successful one.
 */
export interface ModelListing {
  models: string[];
  /** True when the provider itself returned the names. */
  listed: boolean;
  /** Why the provider's list was not used (status or error), when `listed` is false. */
  note?: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; statusText?: string; json(): Promise<unknown> }>;

export async function listAnthropicModels(apiKey: string, fallback: readonly string[], fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ModelListing> {
  let note: string;
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map((m) => m.id).sort();
      if (ids.length) return { models: ids, listed: true };
      note = "the provider returned an empty model list";
    } else {
      // Anthropic's error body carries a short reason ({"error":{"type","message"}})
      // that never echoes the key; show it so a 400/401 is actionable.
      let reason = "";
      try {
        const body = (await res.json()) as { error?: { type?: string; message?: string } };
        const msg = body?.error?.message ?? body?.error?.type;
        if (typeof msg === "string" && msg.trim()) reason = `: ${msg.trim().slice(0, 160)}`;
      } catch { /* non-JSON body: status alone */ }
      note = `the provider answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${reason}${res.status === 401 || res.status === 403 ? " (check the API key)" : ""}`;
    }
  } catch (error) {
    note = `the request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { models: [...fallback], listed: false, note };
}
