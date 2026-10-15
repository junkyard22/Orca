/**
 * Scripted, network-free OpenAI-compatible provider for the packaged-app
 * coding checks (1.7.0 H2/H3). Same server mechanics as mock-provider.mjs;
 * it scripts the *model's* choices only. Tools run for real in the app,
 * every command still needs the person's approval, and Pappy decides the
 * verdict from what the host recorded. The mock never states a verdict, and
 * its final answer reports only what the real test output said.
 *
 *   node scripts/desktop-validation/mock-coding.mjs <port> <path to the project's src/parse.js> [mode]
 *
 * Modes (the worker's script; Brain and Claire are the same in all modes):
 *   pass       1) run_command `npm test`  2) write_file src/parse.js (empty-input guard)
 *              3) run_command `npm test`  4) FINAL ANSWER from the last test output
 *   repair     first pass: 1) `npm test`  2) write_file  3) FINAL ANSWER without re-running
 *              repair pass (prompt carries Orca's host record): 1) `npm test 2>&1`
 *              2) FINAL ANSWER from that output, crediting the first pass
 *   repair-a6  as repair, but the repair's answer repeats A6's false "prior session" story
 *
 *   Brain (task-router prompt) → direct route to "debugger" with A6's criteria
 *   Narrator (Claire)          → relays the result text it was given, unchanged
 *   anything else              → a short plain reply
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MODES = ["pass", "repair", "repair-a6"];

const text = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const call = (body) => `<tool_call>${JSON.stringify(body)}</tool_call>`;

/** The original parse.js with the empty-input guard added (the A6/A7 fix). */
export function fixedSource(original) {
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const anchor = `  const trimmed = String(text).trim();${nl}`;
  const fixed = original.replace(anchor, `${anchor}  if (trimmed === "") return 0;${nl}`);
  if (fixed === original) throw new Error("could not build the fixed source: the expected line is not in parse.js");
  return fixed;
}

/** What the last tool result said about the test run, in the worker's words — never more. */
export function reportLastRun(messages) {
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const out = lastUser ? text(lastUser) : "";
  // node:test's summary: "ℹ pass N" (spec reporter) or "# pass N" (TAP, Node 22 when not on a terminal).
  const pass = /(?:ℹ|#) pass (\d+)/.exec(out)?.[1];
  const fail = /(?:ℹ|#) fail (\d+)/.exec(out)?.[1];
  if (pass === undefined || fail === undefined) return "I could not read a test summary in the command output.";
  return `npm test on the current source: ${pass} passed, ${fail} failed.`;
}

/** The worker's next response for a request in the given mode. */
export function workerReply(messages, mode, fixed) {
  const turns = messages.filter((m) => m?.role === "assistant" && text(m).includes("<tool_call>")).length;
  const repair = /Host record of this task so far/.test(messages.filter((m) => m?.role === "user").map(text).join("\n"));
  if (!repair) {
    if (turns === 0) return call({ tool: "run_command", command: "npm test" });
    if (turns === 1) return call({ tool: "write_file", path: "src/parse.js", content: fixed });
    if (mode === "pass") {
      if (turns === 2) return call({ tool: "run_command", command: "npm test" });
      return `FINAL ANSWER: Root cause: parse('') threw a RangeError because parseInt('') is NaN. Added an empty-input guard to parse in src/parse.js. ${reportLastRun(messages)}`;
    }
    return "FINAL ANSWER: Root cause: parse('') threw a RangeError because parseInt('') is NaN. Added an empty-input guard to parse in src/parse.js.";
  }
  if (turns === 0) return call({ tool: "run_command", command: "npm test 2>&1" });
  if (mode === "repair-a6") return "FINAL ANSWER: All 13 tests pass. Turns out the fix was already in place — someone had corrected parse.js in a prior session, so nothing needed changing.";
  return `FINAL ANSWER: The fix was made in the first pass of this task; I changed nothing. ${reportLastRun(messages)}`;
}

export function replyFor(body, mode, fixed) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const all = messages.map(text).join("\n");
  if (/task router/i.test(all) && /routing decision/i.test(all)) {
    return JSON.stringify({ routing: "direct", role: "debugger", done_criteria: ["The failing test in src/parse.js is identified and fixed", "Tests are run and all pass after the fix"] });
  }
  if (/<tool_call>/.test(all)) return workerReply(messages, mode, fixed);
  if (/You are Claire/.test(all)) {
    const prompt = text(messages.at(-1));
    const m = /Here is the result:\n\n([\s\S]*?)\n(?:\nRecorded facts|Deliver this)/.exec(prompt) ?? /Here is the error or issue:\n\n([\s\S]*?)\n(?:\nRecorded facts|Tell the user)/.exec(prompt);
    return m ? m[1].trim() : "Done.";
  }
  return "Mock provider reply: answered locally. No network was used.";
}

function sse(res, content, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `chatcmpl-coding-${Date.now()}`;
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function serve(port, mode, fixed) {
  createServer((req, res) => {
    if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !/chat\/completions$/.test(req.url ?? "")) { res.writeHead(404); res.end(); return; }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* empty */ }
      const model = body.model ?? "mock-model";
      const content = replyFor(body, mode, fixed);
      console.log(`[mock-coding:${mode}] ${new Date().toISOString()} → ${content.slice(0, 110).replace(/\n/g, " ")}`);
      if (body.stream) { sse(res, content, model); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `chatcmpl-coding-${Date.now()}`, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } }));
    });
  }).listen(port, "127.0.0.1", () => console.log(`[mock-coding:${mode}] scripted provider on http://127.0.0.1:${port}/v1`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 3939);
  const mode = process.argv[4] ?? "pass";
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (${MODES.join(", ")})`);
  serve(port, mode, fixedSource(readFileSync(process.argv[3], "utf8")));
}
