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
          <button class="btn-remove" data-remove-prov="${i}" title="Remove">✕</button>
        </div>
        <input class="setting-input prov-url" placeholder="Base URL" value="${escHtml(p.baseUrl)}" />
        <div class="provider-key-row"${needsKey ? "" : ' style="display:none"'}>
          <input type="password" class="setting-input prov-key" placeholder="API key" value="${escHtml(p.apiKey)}" autocomplete="off" />
          <button class="setting-show-btn prov-show-key" type="button">Show</button>
        </div>
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
}

function rebuildRoleSelects() {
  document.querySelectorAll(".role-provider-sel").forEach((sel) => {
    const current = editingSettings?.roles[sel.closest(".role-row").dataset.roleId]?.providerId ?? "";
    sel.innerHTML = buildProviderOptions(current);
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

// ── Focus input on load ───────────────────────────────────────────────────

inputEl.focus();
