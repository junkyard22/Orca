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

// Streaming: active bubble element + accumulated raw text while tokens arrive.
// Finalised (markdown-rendered) when sendMessage resolves.
let streamBubble = null;
let streamText   = "";

// Role selected for the current task (from role:selected event emitted by main.ts).
let currentRole = null;
// Token estimate for the current task (from run:stats event).
let pendingStats = null;
// Tool call cards keyed by pending approval id.
const toolCallCards = new Map();

// ── Init ──────────────────────────────────────────────────────────────────

orca.onInitStatus((s) => {
  if (s.ok) {
    setInputEnabled(true);
    setStatus("ready", false);
    // Clear any init-error sys-msgs and restore welcome if no real conversation yet
    const sysMsgs = Array.from(messages.querySelectorAll(".sys-msg"));
    const hasRealMsgs = Array.from(messages.children).some(el => !el.classList.contains("sys-msg"));
    if (!hasRealMsgs && sysMsgs.length) {
      sysMsgs.forEach(el => el.remove());
    }
    if (!messages.hasChildNodes()) {
      welcome.style.display  = "";
      messages.style.display = "none";
    }
  } else {
    setInputEnabled(false);
    setStatus("no API key", false);
    // Update existing warn or append new one
    const existing = messages.querySelector(".sys-msg.warn");
    const msg = (s.error ?? "Initialization failed.") + "\n\nClick ⚙ Settings to add your key.";
    if (existing) {
      existing.textContent = msg;
    } else {
      appendSys(msg, "warn");
    }
  }
});

orca.onOrcaEvent((e) => {
  // Role selection — cache it and annotate the thinking indicator.
  if (e.type === "role:selected") {
    currentRole = { role: e.role, isFallback: e.isFallback };
    if (thinkingEl) {
      const lbl = thinkingEl.querySelector(".msg-label");
      if (lbl) lbl.innerHTML = `Orca <span class="role-badge-inline${e.isFallback ? " fallback" : ""}">${escapeHtml(String(e.role))}</span>`;
    }
    return;
  }
  // Token/cost estimate — saved and rendered below the completed reply.
  if (e.type === "run:stats") { pendingStats = e; return; }

  // Stream tokens arrive here during the sendMessage await.
  // Build a live bubble and append each chunk as raw text;
  // sendMessage's finally block replaces the raw text with rendered markdown.
  if (e.type === "stream:token") {
    if (!streamBubble) {
      removeThinking();
      showMessages();
      const div = document.createElement("div");
      div.className = "msg orca streaming";
      div.innerHTML = `<div class="msg-label">Orca</div><div class="msg-bubble stream-content"></div>`;
      messages.appendChild(div);
      streamBubble = div;
      streamText   = "";
    }
    streamText += e.chunk;
    const bubbleEl = streamBubble.querySelector(".stream-content");
    if (bubbleEl) bubbleEl.textContent = streamText;
    scrollToBottom();
    return;
  }

  const labels = {
    "task:start":    "planning\u2026",
    "maestro:start": e.isRepair ? `repairing (pass ${e.attempt})\u2026` : "generating\u2026",
    "maestro:done":  e.isRepair ? `repair pass ${e.attempt} done` : "reviewing\u2026",
    "qc:result":     e.verdict === "pass" ? "QC passed \u2713" : `QC found ${e.issueCount} issue(s)`,
    "repair:start":  `starting repair pass ${e.pass}/${e.maxPasses}\u2026`,
    "task:done":     "done",
  };
  const label = labels[e.type] ?? e.type;
  // Only update the status bar while a task is actively running;
  // late-arriving events after the task resolves should not override "ready".
  if (busy) setStatus(label, e.type !== "task:done");
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

// ── Role badge ────────────────────────────────────────────────────────────

function attachRoleBadge(msgDiv, roleInfo) {
  const lbl = msgDiv.querySelector(".msg-label");
  if (!lbl) return;
  const badge = document.createElement("span");
  badge.className = "role-badge-inline" + (roleInfo.isFallback ? " fallback" : "");
  badge.textContent = roleInfo.role;
  lbl.appendChild(badge);
}

// ── Token / cost stats pill ───────────────────────────────────────────────

function appendStatsPill(stats) {
  const div = document.createElement("div");
  div.className = "stats-pill";
  const inTok  = Number(stats.inputTokensEst).toLocaleString();
  const outTok = Number(stats.outputTokensEst).toLocaleString();
  div.textContent = `~${inTok} in · ~${outTok} out (est.)`;
  messages.appendChild(div);
  scrollToBottom();
}

// ── File diff cards ───────────────────────────────────────────────────────

function appendDiffCards(filesChanged) {
  if (!filesChanged?.length) return;
  const wrapper = document.createElement("div");
  wrapper.className = "diff-cards";
  wrapper.innerHTML = filesChanged.map((f) => {
    const typeKey   = f.changeType === "A" ? "add" : f.changeType === "D" ? "del" : "mod";
    const typeLabel = f.changeType === "A" ? "added" : f.changeType === "D" ? "deleted" : "modified";
    const hasDiff   = f.diff && f.diff.trim().length > 0;
    return `
      <div class="diff-card">
        <div class="diff-card-header">
          <span class="diff-change-type ${typeKey}">${typeLabel}</span>
          <span class="diff-file-path">${escHtml(f.path)}</span>
          ${hasDiff ? '<span class="diff-expand-icon">\u25b6</span>' : ""}
        </div>
        ${hasDiff ? `<pre class="diff-card-body" style="display:none">${escapeHtml(f.diff)}</pre>` : ""}
      </div>`;
  }).join("");
  wrapper.querySelectorAll(".diff-card-header").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const body = hdr.nextElementSibling;
      if (!body || body.tagName !== "PRE") return;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      const icon = hdr.querySelector(".diff-expand-icon");
      if (icon) icon.textContent = isOpen ? "\u25b6" : "\u25bc";
    });
  });
  messages.appendChild(wrapper);
  scrollToBottom();
}

// ── Tool call card ────────────────────────────────────────────────────────

function appendToolCard(id, tool, args) {
  showMessages();
  const div = document.createElement("div");
  div.className = "tool-card pending";
  div.dataset.approvalId = id;
  const argsStr = typeof args === "object" && args !== null
    ? JSON.stringify(args, null, 2)
    : String(args ?? "");
  div.innerHTML = `
    <div class="tool-card-header">
      <span class="tool-card-icon">&#9881;</span>
      <span class="tool-card-name">${escapeHtml(String(tool))}</span>
      <span class="tool-card-status">awaiting approval…</span>
    </div>
    <pre class="tool-card-args">${escapeHtml(argsStr)}</pre>`;
  messages.appendChild(div);
  scrollToBottom();
  return div;
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

  let finalStatus = "ready";
  try {
    const result = await orca.sendMessage(text);
    removeThinking();

    if (streamBubble) {
      // Attach role badge before finalising (element still accessible here).
      if (currentRole) attachRoleBadge(streamBubble, currentRole);
      // Replace raw stream text with rendered markdown.
      const bubbleEl = streamBubble.querySelector(".stream-content");
      if (bubbleEl && streamText) bubbleEl.innerHTML = renderContent(streamText);
      streamBubble.classList.remove("streaming");
      streamBubble = null;
      streamText   = "";
    } else if (result.ok) {
      const replyText = result.reply?.text ?? result.reply?.outputText ?? JSON.stringify(result.reply);
      const msgDiv = appendMsg("orca", replyText);
      if (currentRole) attachRoleBadge(msgDiv, currentRole);
    } else {
      appendSys(result.error ?? "Unknown error.", "error");
    }

    // Post-reply metadata
    if (pendingStats) { appendStatsPill(pendingStats); pendingStats = null; }
    if (result.ok && result.reply?.filesChanged?.length) appendDiffCards(result.reply.filesChanged);

    if (!result.ok) finalStatus = "error";
  } catch (err) {
    removeThinking();
    if (streamBubble) { streamBubble.remove(); streamBubble = null; streamText = ""; }
    appendSys(String(err), "error");
    finalStatus = "error";
  } finally {
    currentRole  = null;
    busy = false;          // clear busy FIRST so late events won't override status
    setStatus(finalStatus, false);
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

const setBudget  = document.getElementById("set-budget");
const setRepairs = document.getElementById("set-repairs");
const setVerbose = document.getElementById("set-verbose");
const setSaveBtn = document.getElementById("btn-save-settings");
const setStatus2 = document.getElementById("settings-status");

// ── Provider & role metadata ───────────────────────────────────────────────

const PROVIDER_TYPES = [
  { value: "openrouter",  label: "OpenRouter",  defaultUrl: "https://openrouter.ai/api/v1",  needsKey: true  },
  { value: "ollama",      label: "Ollama",       defaultUrl: "http://localhost:11434",         needsKey: false },
  { value: "deepseek",    label: "DeepSeek",     defaultUrl: "https://api.deepseek.com/v1",   needsKey: true  },
  { value: "siliconflow", label: "SiliconFlow",  defaultUrl: "https://api.siliconflow.cn/v1", needsKey: true  },
  { value: "openai",      label: "OpenAI",       defaultUrl: "https://api.openai.com/v1",     needsKey: true  },
  { value: "anthropic",   label: "Anthropic",    defaultUrl: "https://api.anthropic.com/v1",  needsKey: true  },
  { value: "zai",         label: "ZAI",          defaultUrl: "https://api.z.ai/v1",           needsKey: true  },
  { value: "custom",      label: "Custom",       defaultUrl: "",                              needsKey: true  },
];

const MODEL_HINTS = {
  openrouter:  "e.g. anthropic/claude-3.5-sonnet",
  ollama:      "e.g. llama3.2, deepseek-r1:14b",
  deepseek:    "e.g. deepseek-chat",
  siliconflow: "e.g. Qwen/Qwen2.5-72B-Instruct",
  openai:      "e.g. gpt-4o",
  anthropic:   "e.g. claude-3-5-sonnet-20241022",
  zai:         "e.g. gpt-4o",
  custom:      "model name",
};

const CORE_ROLES = [
  { id: "brain",        label: "Brain",          hint: "Primary intelligence — drives all LLM calls" },
  { id: "coder_strong", label: "Coder (Strong)",  hint: "High-quality code generation" },
  { id: "coder_cheap",  label: "Coder (Cheap)",   hint: "Fast / cheap code for simple tasks" },
  { id: "utility",      label: "Utility",         hint: "General purpose helper" },
  { id: "reviewer",     label: "Reviewer",        hint: "Code review and critique" },
  { id: "narrator",     label: "Narrator",        hint: "Explanations and documentation" },
];

const OPTIONAL_ROLES = [
  { id: "planner_deep", label: "Planner (Deep)",  hint: "Multi-file refactors — fallback: brain" },
  { id: "debugger",     label: "Debugger",         hint: "Error diagnosis — fallback: coder_strong" },
  { id: "reader",       label: "Reader",           hint: "Summarize long text / logs — fallback: narrator" },
  { id: "vision",       label: "Vision",           hint: "Image interpretation — fallback: brain" },
];

// ── In-memory state ────────────────────────────────────────────────────────

let editingSettings = null;

// Model lists fetched from each provider, keyed by provider id.
// Used to drive datalist autocomplete on role model inputs.
const fetchedModels = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function genId(prefix) {
  return `${prefix}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getProviderType(id) {
  return editingSettings?.providers?.find((p) => p.id === id)?.type ?? "openrouter";
}

// ── Render providers ───────────────────────────────────────────────────────

function renderProviders() {
  const list = document.getElementById("providers-list");
  if (!list || !editingSettings) return;

  if (!editingSettings.providers.length) {
    list.innerHTML = '<p class="setting-hint" style="padding:6px 0">No providers yet — click <strong>+ Add</strong> to add one.</p>';
    return;
  }

  list.innerHTML = editingSettings.providers.map((p, i) => {
    const needsKey = PROVIDER_TYPES.find((t) => t.value === p.type)?.needsKey ?? true;
    const typeOpts = PROVIDER_TYPES.map((t) =>
      `<option value="${t.value}"${t.value === p.type ? " selected" : ""}>${t.label}</option>`
    ).join("");
    return `
      <div class="provider-item" data-prov-idx="${i}">
        <div class="provider-row-top">
          <input class="setting-input prov-name" placeholder="Display name" value="${escHtml(p.name)}" />
          <select class="prov-type">${typeOpts}</select>
          <button class="btn-fetch-models" data-prov-idx="${i}" title="Fetch available models from this provider">Fetch models</button>
          <button class="btn-remove" data-remove-prov="${i}" title="Remove">✕</button>
        </div>
        <input class="setting-input prov-url" placeholder="Base URL" value="${escHtml(p.baseUrl)}" />
        <div class="provider-key-row"${needsKey ? "" : ' style="display:none"'}>
          <input type="password" class="setting-input prov-key" placeholder="API key" value="${escHtml(p.apiKey)}" autocomplete="off" />
          <button class="setting-show-btn prov-show-key" type="button">Show</button>
        </div>
        <div class="fetch-models-status" style="display:none;font-size:11px;color:var(--muted);margin-top:4px"></div>
      </div>`;
  }).join("");

  list.querySelectorAll(".prov-type").forEach((sel) => {
    sel.addEventListener("change", function () {
      const idx = +this.closest(".provider-item").dataset.provIdx;
      const meta = PROVIDER_TYPES.find((t) => t.value === this.value);
      editingSettings.providers[idx].type = this.value;
      if (meta?.defaultUrl) editingSettings.providers[idx].baseUrl = meta.defaultUrl;
      renderProviders();
      renderRoles();
    });
  });

  list.querySelectorAll(".prov-name").forEach((inp) => {
    inp.addEventListener("input", function () {
      editingSettings.providers[+this.closest(".provider-item").dataset.provIdx].name = this.value;
      rebuildRoleSelects();
    });
  });

  list.querySelectorAll(".prov-url").forEach((inp) => {
    inp.addEventListener("input", function () {
      editingSettings.providers[+this.closest(".provider-item").dataset.provIdx].baseUrl = this.value;
    });
  });

  list.querySelectorAll(".prov-key").forEach((inp) => {
    inp.addEventListener("input", function () {
      editingSettings.providers[+this.closest(".provider-item").dataset.provIdx].apiKey = this.value;
    });
  });

  list.querySelectorAll(".prov-show-key").forEach((btn) => {
    btn.addEventListener("click", function () {
      const inp = this.previousElementSibling;
      const showing = inp.type === "text";
      inp.type = showing ? "password" : "text";
      this.textContent = showing ? "Show" : "Hide";
    });
  });

  list.querySelectorAll(".btn-fetch-models").forEach((btn) => {
    btn.addEventListener("click", async function () {
      const idx = +this.dataset.provIdx;
      const prov = editingSettings.providers[idx];
      if (!prov) return;
      const statusEl = this.closest(".provider-item").querySelector(".fetch-models-status");
      this.disabled = true;
      this.textContent = "Fetching…";
      statusEl.style.display = "block";
      statusEl.textContent = "Contacting provider…";
      const result = await orca.fetchModels({ type: prov.type, baseUrl: prov.baseUrl, apiKey: prov.apiKey });
      this.disabled = false;
      this.textContent = "Fetch models";
      if (result.ok && result.models?.length) {
        fetchedModels.set(prov.id, result.models);
        statusEl.textContent = `${result.models.length} model(s) loaded — type in a role field to autocomplete.`;
        statusEl.style.color = "var(--green, #10b981)";
        updateModelDataLists();
      } else {
        statusEl.textContent = result.error ?? "No models returned.";
        statusEl.style.color = "var(--red, #ef4444)";
      }
    });
  });

  list.querySelectorAll("[data-remove-prov]").forEach((btn) => {
    btn.addEventListener("click", function () {
      editingSettings.providers.splice(+this.dataset.removeProv, 1);
      renderProviders();
      renderRoles();
    });
  });
}

// ── Render roles ───────────────────────────────────────────────────────────

function buildProviderOptions(currentProviderId) {
  if (!editingSettings?.providers?.length) {
    return '<option value="">— add a provider first —</option>';
  }
  const blank = currentProviderId ? "" : '<option value="">— select —</option>';
  return blank + editingSettings.providers
    .map((p) => `<option value="${p.id}"${p.id === currentProviderId ? " selected" : ""}>${escHtml(p.name)}</option>`)
    .join("");
}

function renderRoleList(containerId, roles, badgeClass) {
  const el = document.getElementById(containerId);
  if (!el || !editingSettings) return;

  el.innerHTML = roles.map((role) => {
    const entry = editingSettings.roles[role.id] ?? { providerId: "", model: "" };
    const hint  = MODEL_HINTS[getProviderType(entry.providerId)] ?? "model";
    return `
      <div class="role-row" data-role-id="${role.id}">
        <div class="role-label" title="${escHtml(role.hint)}">
          <span class="role-name">${escHtml(role.label)}</span>
          <span class="role-badge ${badgeClass}">${badgeClass}</span>
        </div>
        <select class="role-select role-provider-sel">
          ${buildProviderOptions(entry.providerId)}
        </select>
        <input class="setting-input role-model-inp" placeholder="${escHtml(hint)}" value="${escHtml(entry.model)}" />
      </div>`;
  }).join("");

  el.querySelectorAll(".role-provider-sel").forEach((sel) => {
    sel.addEventListener("change", function () {
      const roleId = this.closest(".role-row").dataset.roleId;
      if (!editingSettings.roles[roleId]) editingSettings.roles[roleId] = { providerId: "", model: "" };
      editingSettings.roles[roleId].providerId = this.value;
      const modelInp = this.closest(".role-row").querySelector(".role-model-inp");
      modelInp.placeholder = MODEL_HINTS[getProviderType(this.value)] ?? "model";
      updateModelDataLists();
    });
  });

  el.querySelectorAll(".role-model-inp").forEach((inp) => {
    inp.addEventListener("input", function () {
      const roleId = this.closest(".role-row").dataset.roleId;
      if (!editingSettings.roles[roleId]) editingSettings.roles[roleId] = { providerId: "", model: "" };
      editingSettings.roles[roleId].model = this.value;
    });
  });
}

function renderRoles() {
  renderRoleList("roles-core-list",     CORE_ROLES,     "core");
  renderRoleList("roles-optional-list", OPTIONAL_ROLES, "optional");
  updateModelDataLists();
}

function rebuildRoleSelects() {
  document.querySelectorAll(".role-row:not(.role-fallback-row) .role-provider-sel").forEach((sel) => {
    const current = editingSettings?.roles[sel.closest(".role-row").dataset.roleId]?.providerId ?? "";
    sel.innerHTML = buildProviderOptions(current);
  });
  document.querySelectorAll(".fb-provider-sel").forEach((sel) => {
    const row     = sel.closest(".role-fallback-row");
    const roleId  = row.dataset.roleId;
    const idx     = +row.dataset.fbIdx;
    const current = editingSettings?.roles[roleId]?.fallbacks?.[idx]?.providerId ?? "";
    sel.innerHTML = buildProviderOptions(current);
  });
}

/**
 * Rebuild (or create) <datalist> elements inside #settings-view for each
 * provider that has a fetched model list, and attach them to role model inputs.
 */
function updateModelDataLists() {
  const settingsBody = document.querySelector(".settings-body");
  if (!settingsBody) return;

  // Remove old datalists
  settingsBody.querySelectorAll("datalist[data-ml]").forEach((dl) => dl.remove());

  // Create one datalist per provider that has fetched models
  fetchedModels.forEach((models, provId) => {
    const dl = document.createElement("datalist");
    dl.id = `ml-${provId}`;
    dl.dataset.ml = "1";
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      dl.appendChild(opt);
    });
    settingsBody.appendChild(dl);
  });

  // Wire up role model inputs to the right datalist
  document.querySelectorAll(".role-row").forEach((row) => {
    const roleId   = row.dataset.roleId;
    const provSel  = row.querySelector(".role-provider-sel");
    const modelInp = row.querySelector(".role-model-inp");
    if (!provSel || !modelInp) return;
    const provId = provSel.value || (editingSettings?.roles?.[roleId]?.providerId ?? "");
    if (provId && fetchedModels.has(provId)) {
      modelInp.setAttribute("list", `ml-${provId}`);
    } else {
      modelInp.removeAttribute("list");
    }
  });
}

// ── Open / close settings ──────────────────────────────────────────────────

function openSettings() {
  chatView.style.display     = "none";
  settingsView.style.display = "flex";

  orca.getSettings().then((s) => {
    editingSettings        = JSON.parse(JSON.stringify(s)); // deep clone
    setBudget.value        = String(s.budgetUsd       ?? 0.10);
    setRepairs.value       = String(s.maxRepairPasses ?? 2);
    setVerbose.checked     = !!s.verbose;
    setStatus2.textContent = "";
    setStatus2.className   = "settings-status";
    renderProviders();
    renderRoles();
  });
}

function closeSettings() {
  settingsView.style.display = "none";
  chatView.style.display     = "flex";
  editingSettings = null;
  inputEl.focus();
}

document.getElementById("btn-add-provider").addEventListener("click", () => {
  if (!editingSettings) return;
  editingSettings.providers.push({
    id:      genId("prov"),
    name:    "",
    type:    "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey:  "",
  });
  renderProviders();
  renderRoles();
});

setSaveBtn.addEventListener("click", async () => {
  if (!editingSettings) return;

  const s = {
    ...editingSettings,
    budgetUsd:       parseFloat(setBudget.value)   || 0.10,
    maxRepairPasses: parseInt(setRepairs.value, 10) || 0,
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

// ── Tool approval dialog ────────────────────────────────────────────

orca.onToolRequest((id, tool, args) => {
  // Add a tool call card to the message thread so the user can see what's running.
  const card = appendToolCard(id, tool, args);
  toolCallCards.set(id, card);

  // Show the approval overlay dialog.
  const dialog = document.getElementById("tool-approval-dialog");
  document.getElementById("approval-tool-name").textContent = tool;
  document.getElementById("approval-args").textContent =
    typeof args === "object" && args !== null
      ? JSON.stringify(args, null, 2)
      : String(args);
  dialog.dataset.approvalId = id;
  dialog.style.display      = "flex";
});

document.getElementById("btn-approve-tool").addEventListener("click", () => {
  const dialog = document.getElementById("tool-approval-dialog");
  const id = dialog.dataset.approvalId;
  const card = toolCallCards.get(id);
  if (card) {
    card.classList.replace("pending", "approved");
    card.querySelector(".tool-card-status").textContent = "\u2713 Approved";
  }
  toolCallCards.delete(id);
  orca.approveToolCall(id, true);
  dialog.style.display = "none";
});

document.getElementById("btn-deny-tool").addEventListener("click", () => {
  const dialog = document.getElementById("tool-approval-dialog");
  const id = dialog.dataset.approvalId;
  const card = toolCallCards.get(id);
  if (card) {
    card.classList.replace("pending", "denied");
    card.querySelector(".tool-card-status").textContent = "\u2717 Denied";
  }
  toolCallCards.delete(id);
  orca.approveToolCall(id, false);
  dialog.style.display = "none";
});

// ── Focus input on load ───────────────────────────────────────────────────

inputEl.focus();
