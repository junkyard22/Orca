#!/usr/bin/env node
/**
 * Network-free mock OpenAI-compatible provider for the manual desktop checklist.
 *
 *   node scripts/desktop-validation/mock-provider.mjs [port]      (default 3939)
 *
 * It answers /v1/chat/completions (streaming and non-streaming) and /v1/models.
 * Behaviour is chosen from the prompt, so the same server serves Brain, workers,
 * Narrator and Benson:
 *
 *   - a task-router prompt (Brain)            → bare JSON direct route to "strong_model"
 *   - a worker prompt (mentions <tool_call>)  → first turn: run_command `echo orca-validation`
 *                                               (requires approval → native dialog);
 *                                               later turns: "FINAL ANSWER: …"
 *   - anything else (Narrator / Benson)       → a short plain-text reply
 *
 * Control words anywhere in the latest user message:
 *   SLOW     the reply streams one token every 2 s for 90 s (press Stop; kill the app)
 *   FAIL     the provider answers HTTP 500 (provider-unavailable path)
 *   BADPLAN  Brain answers with invalid JSON (Brain fallback path)
 *   BIG      the reply asks for max_tokens 100000 (budget refusal path under a small budget)
 *
 * Usage is reported in the final SSE chunk (and in the non-streaming body) so the
 * ledger can settle; set NO_USAGE=1 to omit it (unreconciled path).
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3939);
const noUsage = process.env["NO_USAGE"] === "1";

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return String(messages[i].content ?? "");
  return "";
}
function allText(messages) {
  return messages.map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))).join("\n");
}

function replyFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = lastUser(messages);
  const all = allText(messages);
  const slow = /\bSLOW\b/.test(user);
  if (/task router/i.test(all) && /routing decision/i.test(all)) {
    if (/\bBADPLAN\b/.test(all)) return { text: "I think the best plan is to {route: direct", slow };
    return { text: JSON.stringify({ routing: "direct", role: "strong_model", done_criteria: ["The command `echo orca-validation` was run and its output reported."] }), slow };
  }
  if (/<tool_call>/.test(all)) {
    // The worker already asked for the command when one of its own earlier turns carries the tool call.
    const alreadyRan = messages.some((m) => m?.role === "assistant" && /echo orca-validation/.test(typeof m.content === "string" ? m.content : ""));
    if (!alreadyRan) return { text: 'I will run the command now.\n<tool_call>{"tool":"run_command","command":"echo orca-validation"}</tool_call>', slow };
    return { text: "FINAL ANSWER: Ran `echo orca-validation`; it printed orca-validation (exit code 0).", slow };
  }
  return { text: slow ? "This is a deliberately slow reply from the mock provider. Press Stop whenever you like." : "Mock provider reply: the request was received and answered locally. No network was used.", slow };
}

function sse(res, text, model, slow) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `chatcmpl-mock-${Date.now()}`;
  const tokens = slow ? Array.from({ length: 45 }, (_, i) => `${i === 0 ? text : " …"}`) : [text];
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i < tokens.length) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }] })}\n\n`);
      i++;
      setTimeout(tick, slow ? 2000 : 5);
      return;
    }
    const final = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    if (!noUsage) final.usage = { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  tick();
}

const server = createServer((req, res) => {
  if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !/chat\/completions$/.test(req.url ?? "")) {
    res.writeHead(404); res.end(); return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* empty */ }
    const user = lastUser(Array.isArray(body.messages) ? body.messages : []);
    if (/\bFAIL\b/.test(user)) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "mock provider failure (FAIL control word)" } })); return; }
    const model = body.model ?? "mock-model";
    const { text, slow } = replyFor(body);
    console.log(`[mock] ${new Date().toISOString()} stream=${!!body.stream} slow=${slow} → ${text.slice(0, 60).replace(/\n/g, " ")}`);
    if (body.stream) { sse(res, text, model, slow); return; }
    const payload = { id: `chatcmpl-mock-${Date.now()}`, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
    if (!noUsage) payload.usage = { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 };
    const send = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (slow) setTimeout(send, 90_000); else send();
  });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock] OpenAI-compatible provider on http://127.0.0.1:${port}/v1 (NO_USAGE=${noUsage ? 1 : 0})`));
