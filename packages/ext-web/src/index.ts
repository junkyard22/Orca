/**
 * @clawde/ext-web — Orca extension for web access
 *
 * Tools:
 *   web_fetch  — download and clean any public URL; returns up to 10 000 chars
 *   web_search — DuckDuckGo Instant Answer API; returns abstract + related topics
 *
 * No API keys required — uses Node 18+ built-in fetch.
 *
 * Usage:
 *   import { webExtension } from "@clawde/ext-web";
 *   const reg = await createExtensionRegistry([webExtension]);
 */

import type { OrcaExtension, ExtTool, ExtToolRunCtx, ExtToolResult } from "@clawde/orca-core";

// ── HTML tag stripper ─────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Tool: web_fetch ───────────────────────────────────────────────────────

const webFetchTool: ExtTool = {
  name: "web_fetch",
  description:
    "Fetch a public URL and return its text content (HTML is stripped to readable text). " +
    "Returns at most 10 000 characters.",
  schema: {
    type: "object",
    properties: {
      url:      { type: "string", description: "The URL to fetch (http or https)." },
      maxChars: { type: "number", description: "Maximum characters to return (default 10 000, max 20 000)." },
    },
    required: ["url"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const url = input["url"];
    if (typeof url !== "string" || !url.startsWith("http")) {
      return { ok: false, output: "", error: '"url" must be a valid http/https URL.' };
    }
    const maxChars = Math.min(
      typeof input["maxChars"] === "number" ? input["maxChars"] : 10_000,
      20_000,
    );

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "orca-bot/1.0 (text extraction)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return { ok: false, output: "", error: `HTTP ${res.status} fetching ${url}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const text = contentType.includes("html") ? stripHtml(raw) : raw;
      return { ok: true, output: text.slice(0, maxChars) };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ── Tool: web_search ──────────────────────────────────────────────────────

interface DdgResponse {
  Abstract: string;
  AbstractURL: string;
  AbstractSource: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text: string; FirstURL: string }> }>;
  Answer?: string;
}

const webSearchTool: ExtTool = {
  name: "web_search",
  description:
    "Search the web using DuckDuckGo Instant Answers and return the best available summary. " +
    "Good for facts, definitions, and quick lookups. Does not return full page content.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const query = input["query"];
    if (typeof query !== "string" || !query.trim()) {
      return { ok: false, output: "", error: '"query" is required.' };
    }

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "orca-bot/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, output: "", error: `DuckDuckGo returned HTTP ${res.status}.` };
      }
      const data = (await res.json()) as DdgResponse;

      const parts: string[] = [];

      if (data.Answer) {
        parts.push(`**Answer:** ${data.Answer}`);
      }
      if (data.Abstract) {
        const src = data.AbstractSource ? ` (${data.AbstractSource})` : "";
        parts.push(`**Summary${src}:** ${data.Abstract}`);
        if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
      }

      type FlatTopic = { Text: string; FirstURL?: string };
      const topics: FlatTopic[] = (data.RelatedTopics ?? []).flatMap((t) => {
        if (t.Topics) return t.Topics as FlatTopic[];
        return t.Text ? [{ Text: t.Text, FirstURL: t.FirstURL }] : [];
      });
      if (topics.length > 0) {
        parts.push("", "**Related:**");
        topics.slice(0, 5).forEach((t) => {
          parts.push(`• ${t.Text}${t.FirstURL ? ` — ${t.FirstURL}` : ""}`);
        });
      }

      if (!parts.length) {
        return {
          ok: true,
          output: `No instant-answer results found for "${query}". Try a more specific query or use web_fetch on a known URL.`,
        };
      }

      return { ok: true, output: parts.join("\n") };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ── Extension export ──────────────────────────────────────────────────────

export const webExtension: OrcaExtension = {
  id:      "@clawde/ext-web",
  name:    "Web",
  version: "1.2.7",
  tools:   [webFetchTool, webSearchTool],
};

export default webExtension;
