import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMRequest } from "@clawde/miranda-core";
import { createDirectLLMService } from "./directLLM.js";

const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };

function adapter(withStream: boolean): LLMAdapter & { complete: ReturnType<typeof vi.fn>; stream?: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (request: LLMRequest) => ({ content: `c:${request.model}`, model: "resolved-model", usage, durationMs: 7 }));
  const stream = vi.fn(async (request: LLMRequest, onToken: (t: string) => void) => { onToken("s"); return { content: `s:${request.model}`, model: "resolved-model", usage: null, durationMs: 9 }; });
  return withStream ? { name: "t", complete, stream } : { name: "t", complete };
}

describe("createDirectLLMService", () => {
  it("passes provider usage, model and timing through on complete()", async () => {
    const a = adapter(false);
    const r = await createDirectLLMService(a, "m").complete("hi");
    expect(r).toEqual({ text: "c:m", usage, model: "resolved-model", durationMs: 7 });
  });

  it("reports unknown usage as null on stream(), never an estimate", async () => {
    const a = adapter(true);
    const chunks: string[] = [];
    const r = await createDirectLLMService(a, "m").stream("sys\n\n---\n\nuser", {}, (c) => chunks.push(c));
    expect(chunks).toEqual(["s"]);
    expect(r).toEqual({ text: "s:m", usage: null, model: "resolved-model", durationMs: 9 });
    const sent = a.stream!.mock.calls[0]![0] as LLMRequest;
    expect(sent.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
  });

  it("falls back to a buffered call with one chunk when the adapter cannot stream", async () => {
    const a = adapter(false);
    const chunks: string[] = [];
    const r = await createDirectLLMService(a, "m").stream("hi", {}, (c) => chunks.push(c));
    expect(chunks).toEqual(["c:m"]);
    expect(r.usage).toEqual(usage);
  });
});
