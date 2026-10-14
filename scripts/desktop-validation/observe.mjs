#!/usr/bin/env node
/**
 * Observer for the manual checklist: reads the renderer of a running
 * isolated app through the Chrome DevTools port and takes screenshots.
 *
 *   node scripts/desktop-validation/observe.mjs <devtoolsPort> <command> [args]
 *
 * Commands:
 *   text                 print the chat transcript (system lines and messages) and the status bar
 *   shot <file.png>      save a screenshot of the window
 *   send "<message>"     type a message into the chat box and press Send (what a user would do)
 *   stop                 press the Stop button
 *   eval "<js>"          evaluate an expression in the renderer and print the JSON result
 *
 * It never answers a native dialog: those are not web content and cannot be
 * reached from here, which is the point.
 */
import { writeFileSync } from "node:fs";

const [port, command, ...rest] = process.argv.slice(2);
if (!port || !command) { console.error("usage: observe.mjs <port> <command> [args]"); process.exit(2); }

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const call = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + " " + (r.result.exceptionDetails.exception?.description ?? ""));
  return r.result?.result?.value;
};

const TEXT = `(() => {
  const lines = [...document.querySelectorAll('#messages > *')].map((el) => {
    const cls = el.className || el.tagName.toLowerCase();
    return '[' + cls + '] ' + (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
  });
  const status = (document.getElementById('statusbar')?.innerText || '').replace(/\\s+/g, ' ').trim();
  const banner = document.getElementById('workspace-banner');
  return { lines, status, banner: banner && !banner.hidden ? banner.innerText : null, inputDisabled: document.getElementById('input')?.disabled, placeholder: document.getElementById('input')?.placeholder, sendRunning: document.getElementById('send-btn')?.classList.contains('is-running') };
})()`;

try {
  switch (command) {
    case "text": console.log(JSON.stringify(await evaluate(TEXT), null, 2)); break;
    case "shot": {
      const r = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(rest[0] ?? "shot.png", Buffer.from(r.result.data, "base64"));
      console.log("saved", rest[0] ?? "shot.png");
      break;
    }
    case "send": {
      const text = JSON.stringify(rest.join(" "));
      await evaluate(`(() => { const i = document.getElementById('input'); i.value = ${text}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('send-btn').click(); return true; })()`);
      console.log("sent");
      break;
    }
    case "stop": await evaluate(`document.getElementById('send-btn').click()`); console.log("stop pressed"); break;
    case "eval": console.log(JSON.stringify(await evaluate(rest.join(" ")), null, 2)); break;
    default: console.error("unknown command"); process.exit(2);
  }
} finally {
  ws.close();
}
