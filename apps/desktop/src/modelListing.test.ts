import { describe, expect, it } from "vitest";
import { listAnthropicModels } from "./modelListing";

const FALLBACK = ["claude-sonnet-4-6", "claude-opus-4-8"] as const;

describe("Anthropic model listing", () => {
  it("reports a real listing as listed, sorted, with the provider's ids", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "claude-sonnet-4-6" }, { id: "claude-haiku-4-5-20251001" }] }) });
    const r = await listAnthropicModels("k", FALLBACK, fetchImpl);
    expect(r).toEqual({ models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"], listed: true });
  });

  it("a rejected key is not a listing: the fallback is returned and marked, with the status and the provider's reason in the note", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    const r = await listAnthropicModels("bad", FALLBACK, fetchImpl);
    expect(r.listed).toBe(false);
    expect(r.models).toEqual([...FALLBACK]);
    expect(r.note).toMatch(/HTTP 401 Unauthorized: invalid x-api-key/);
    expect(r.note).toMatch(/check the API key/);
  });

  it("a 400 with a JSON reason shows the reason; a non-JSON body shows the status alone", async () => {
    const withReason = async () => ({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: { type: "invalid_request_error", message: "x-api-key header is invalid" } }) });
    expect((await listAnthropicModels("k", FALLBACK, withReason)).note).toBe("the provider answered HTTP 400 Bad Request: x-api-key header is invalid");
    const noJson = async () => ({ ok: false, status: 502, statusText: "Bad Gateway", json: async () => { throw new SyntaxError("not json"); } });
    expect((await listAnthropicModels("k", FALLBACK, noJson)).note).toBe("the provider answered HTTP 502 Bad Gateway");
  });

  it("a network failure is a fallback with the error in the note", async () => {
    const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    const r = await listAnthropicModels("k", FALLBACK, fetchImpl);
    expect(r.listed).toBe(false);
    expect(r.note).toMatch(/ENOTFOUND/);
  });

  it("an empty provider answer is a fallback, not a listing", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
    const r = await listAnthropicModels("k", FALLBACK, fetchImpl);
    expect(r.listed).toBe(false);
    expect(r.note).toMatch(/empty/);
  });

  it("sends the key as x-api-key with the API version header", async () => {
    let seen: Record<string, string> | undefined;
    const fetchImpl = async (_u: string, init?: { headers?: Record<string, string> }) => { seen = init?.headers; return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) }; };
    await listAnthropicModels("secret", FALLBACK, fetchImpl);
    expect(seen).toEqual({ "x-api-key": "secret", "anthropic-version": "2023-06-01" });
  });
});
