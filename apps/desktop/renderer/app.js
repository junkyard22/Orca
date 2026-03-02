/* ── Orca desktop renderer ───────────────────────────────────────────────── */
"use strict";

const orca       = window.orca;
const messages   = document.getElementById("messages");
const welcome    = document.getElementById("welcome");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send-btn");
const statusDot  = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// ── State ─────────────────────────────────────────────────────────────────

let busy = false;

// ── Init ──────────────────────────────────────────────────────────────────

orca.onInitStatus((s) => {
  if (!s.ok) {
    appendSys(s.error ?? "Initialization failed.", "error");
    setInputEnabled(false);
  }
});

orca.onOrcaEvent((e) => {
  const labels = {
    "task:start":    "planning…",
    "maestro:start": e.isRepair ? `repairing (pass ${e.attempt})…` : "generating…",
    "maestro:done":  e.isRepair ? `repair pass ${e.attempt} done` : "reviewing…",
    "qc:result":     e.verdict === "pass" ? "QC passed ✓" : `QC found ${e.issueCount} issue(s)`,
    "repair:start":  `starting repair pass ${e.pass}/${e.maxPasses}…`,
    "task:done":     "done",
  };
  const label = labels[e.type] ?? e.type;
  setStatus(label, e.type !== "task:done");
});

// ── Helpers ───────────────────────────────────────────────────────────────

function showMessages() {
  welcome.style.display  = "none";
  messages.style.display = "flex";
}

function setStatus(text, active = false) {
  statusText.textContent = text;
  statusDot.classList.toggle("active", active);
}

function setInputEnabled(enabled) {
  inputEl.disabled  = !enabled;
  sendBtn.disabled  = !enabled;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ── Safe markdown renderer ────────────────────────────────────────────────
// Escapes HTML, then applies a small subset of Markdown.

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(raw) {
  // Fenced code blocks  ```lang\n…\n```
  let html = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
  });

  // Inline code  `…`
  html = html.replace(/`([^`\n]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm,  "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm,   "<h2>$1</h2>");

  // Bold **…**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Unordered list items  - item
  html = html.replace(/^[ \t]*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]+?<\/li>)/g, "<ul>$1</ul>");
  // Collapse consecutive </ul><ul> → nothing (merge runs)
  html = html.replace(/<\/ul>\s*<ul>/g, "");

  // Paragraph breaks: double newline → <p> wrap
  // Split on blank lines, wrap non-tag content in <p>
  const parts = html.split(/\n\n+/);
  html = parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return "";
    // If already an HTML block element, don't wrap
    if (/^<(pre|ul|ol|h[2-4]|li)/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, " ")}</p>`;
  }).join("\n");

  return html;
}

// ── Message builders ──────────────────────────────────────────────────────

function appendMsg(role, text) {
  showMessages();

  const div = document.createElement("div");
  div.className = `msg ${role}`;

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "Orca";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (role === "user") {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = renderContent(text);
  }

  div.appendChild(label);
  div.appendChild(bubble);
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

let thinkingEl = null;

function appendThinking() {
  showMessages();
  const div = document.createElement("div");
  div.className = "msg orca";
  div.innerHTML = `
    <div class="msg-label">Orca</div>
    <div class="msg-bubble">
      <div class="thinking-dots">
        <span></span><span></span><span></span>
      </div>
    </div>`;
  messages.appendChild(div);
  scrollToBottom();
  thinkingEl = div;
}

function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function appendSys(text, variant = "") {
  const div = document.createElement("div");
  div.className = `sys-msg${variant ? " " + variant : ""}`;
  div.textContent = text;
  messages.appendChild(div);
  showMessages();
  scrollToBottom();
}

// ── Send ──────────────────────────────────────────────────────────────────

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || busy) return;

  busy = true;
  setInputEnabled(false);
  inputEl.value = "";
  autoResize();

  appendMsg("user", text);
  appendThinking();
  setStatus("task:start — planning…", true);

  try {
    const result = await orca.sendMessage(text);
    removeThinking();

    if (result.ok) {
      const replyText = result.reply?.text ?? result.reply?.outputText ?? JSON.stringify(result.reply);
      appendMsg("orca", replyText);
      setStatus("ready", false);
    } else {
      appendSys(result.error ?? "Unknown error.", "error");
      setStatus("error", false);
    }
  } catch (err) {
    removeThinking();
    appendSys(String(err), "error");
    setStatus("error", false);
  } finally {
    busy = false;
    setInputEnabled(true);
    inputEl.focus();
  }
}

// ── Textarea auto-resize ──────────────────────────────────────────────────

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}

inputEl.addEventListener("input", autoResize);

// ── Keyboard ──────────────────────────────────────────────────────────────

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Buttons ───────────────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);
document.getElementById("btn-minimize").addEventListener("click", () => orca.minimize());
document.getElementById("btn-close").addEventListener("click",    () => orca.close());

// ── Focus input on load ───────────────────────────────────────────────────

inputEl.focus();
