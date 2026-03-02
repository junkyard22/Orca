/* ── Orca desktop renderer ───────────────────────────────────────────────── */
"use strict";

// ── DOM refs ──────────────────────────────────────────────────────────────

const messages      = document.getElementById("messages");
const welcome       = document.getElementById("welcome");
const inputEl       = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusDot     = document.getElementById("status-dot");
const statusText    = document.getElementById("status-text");
const chatView      = document.getElementById("chat-view");
const settingsView  = document.getElementById("settings-view");

// ── State ─────────────────────────────────────────────────────────────────

let busy = false;

// ── Init ──────────────────────────────────────────────────────────────────

orca.onInitStatus((s) => {
  if (s.ok) {
    setInputEnabled(true);
    setStatus("ready", false);
  } else {
    setInputEnabled(false);
    setStatus("no API key", false);
    // Only show the error once in chat if there's no messages yet
    if (!messages.hasChildNodes()) {
      appendSys((s.error ?? "Initialization failed.") + "\n\nClick ⚙ Settings to add your key.", "warn");
    }
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

// ── Chat helpers ──────────────────────────────────────────────────────────

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

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(raw) {
  let html = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm,  "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm,   "<h2>$1</h2>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/^[ \t]*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]+?<\/li>)/g, "<ul>$1</ul>");
  html = html.replace(/<\/ul>\s*<ul>/g, "");
  const parts = html.split(/\n\n+/);
  html = parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return "";
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
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
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
  setStatus("planning…", true);

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

// ── Settings panel ────────────────────────────────────────────────────────

const setApiKey   = document.getElementById("set-apikey");
const setShowKey  = document.getElementById("btn-show-key");
const setBudget   = document.getElementById("set-budget");
const setRepairs  = document.getElementById("set-repairs");
const setVerbose  = document.getElementById("set-verbose");
const setSaveBtn  = document.getElementById("btn-save-settings");
const setStatus2  = document.getElementById("settings-status");

function openSettings() {
  chatView.style.display     = "none";
  settingsView.style.display = "flex";
  orca.getSettings().then((s) => {
    setApiKey.value       = s.apiKey ?? "";
    setBudget.value       = String(s.budgetUsd ?? 0.10);
    setRepairs.value      = String(s.maxRepairPasses ?? 2);
    setVerbose.checked    = !!s.verbose;
    setStatus2.textContent = "";
    setStatus2.className   = "settings-status";
  });
}

function closeSettings() {
  settingsView.style.display = "none";
  chatView.style.display     = "flex";
  inputEl.focus();
}

setShowKey.addEventListener("click", () => {
  const showing = setApiKey.type === "text";
  setApiKey.type       = showing ? "password" : "text";
  setShowKey.textContent = showing ? "Show" : "Hide";
});

setSaveBtn.addEventListener("click", async () => {
  const s = {
    apiKey:          setApiKey.value.trim(),
    budgetUsd:       parseFloat(setBudget.value)   || 0.10,
    maxRepairPasses: parseInt(setRepairs.value, 10) || 0,
    siteUrl:         "http://localhost",
    appName:         "orca-desktop",
    verbose:         setVerbose.checked,
  };

  setSaveBtn.disabled    = true;
  setStatus2.textContent = "Saving…";
  setStatus2.className   = "settings-status";

  const result = await orca.saveSettings(s);
  setSaveBtn.disabled = false;

  if (result.ok) {
    setStatus2.textContent = "Saved — Orca re-initialized.";
    setStatus2.className   = "settings-status";
  } else {
    setStatus2.textContent = result.error ?? "Save failed.";
    setStatus2.className   = "settings-status err";
  }
});

// ── Button wiring ─────────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);
document.getElementById("btn-settings").addEventListener("click",      openSettings);
document.getElementById("btn-settings-back").addEventListener("click", closeSettings);
document.getElementById("btn-minimize").addEventListener("click", () => orca.minimize());
document.getElementById("btn-close").addEventListener("click",    () => orca.close());

// ── Focus input on load ───────────────────────────────────────────────────

inputEl.focus();
