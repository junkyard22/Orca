import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webExtension } from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { workspaceRoot: process.cwd() };

function tool(name: string) {
  const t = webExtension.tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── web_fetch ─────────────────────────────────────────────────────────────────

describe("web_fetch", () => {
  const fetch = () => tool("web_fetch");

  it("returns plain text unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "text/plain" },
      text: () => Promise.resolve("hello world"),
    }));
    const result = await fetch().execute({ url: "https://example.com/text" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("strips HTML tags from HTML responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "text/html" },
      text: () => Promise.resolve("<html><body><p>Hello <b>World</b></p></body></html>"),
    }));
    const result = await fetch().execute({ url: "https://example.com" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Hello");
    expect(result.output).toContain("World");
    expect(result.output).not.toContain("<p>");
    expect(result.output).not.toContain("<b>");
  });

  it("truncates to maxChars", async () => {
    const longText = "a".repeat(25_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "text/plain" },
      text: () => Promise.resolve(longText),
    }));
    const result = await fetch().execute({ url: "https://example.com", maxChars: 100 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(100);
  });

  it("returns error on non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404,
      headers: { get: () => "" },
      text: () => Promise.resolve("Not Found"),
    }));
    const result = await fetch().execute({ url: "https://example.com/missing" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });

  it("returns error for non-http URL", async () => {
    const result = await fetch().execute({ url: "ftp://example.com" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/http/);
  });

  it("returns error when url is missing", async () => {
    const result = await fetch().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/url/);
  });

  it("returns error when fetch throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")));
    const result = await fetch().execute({ url: "https://example.com" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network unreachable");
  });
});

// ── web_search ────────────────────────────────────────────────────────────────

describe("web_search", () => {
  const search = () => tool("web_search");

  const ddgResponse = {
    Answer: "TypeScript is a language",
    Abstract: "TypeScript extends JavaScript",
    AbstractSource: "Wikipedia",
    AbstractURL: "https://en.wikipedia.org/wiki/TypeScript",
    RelatedTopics: [
      { Text: "JavaScript — a scripting language", FirstURL: "https://en.wikipedia.org/wiki/JavaScript" },
      { Text: "Node.js — a runtime", FirstURL: "https://nodejs.org" },
    ],
  };

  it("formats a DuckDuckGo result with abstract and related topics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(ddgResponse),
    }));
    const result = await search().execute({ query: "TypeScript" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("TypeScript is a language");
    expect(result.output).toContain("TypeScript extends JavaScript");
    expect(result.output).toContain("Wikipedia");
    expect(result.output).toContain("JavaScript");
  });

  it("returns no-results message when DDG returns empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ Answer: "", Abstract: "", RelatedTopics: [] }),
    }));
    const result = await search().execute({ query: "xyzzy1234nonsense" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No instant-answer results");
  });

  it("returns error when query is missing", async () => {
    const result = await search().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/query/);
  });

  it("returns error on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503,
      headers: { get: () => "" },
      json: () => Promise.resolve({}),
    }));
    const result = await search().execute({ query: "test" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });
});

// ── Extension metadata ────────────────────────────────────────────────────────

describe("webExtension", () => {
  it("has correct id and 2 tools", () => {
    expect(webExtension.id).toBe("@clawde/ext-web");
    expect(webExtension.tools).toHaveLength(2);
    expect(webExtension.tools.map((t) => t.name)).toEqual(["web_fetch", "web_search"]);
  });
});
