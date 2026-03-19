/* ── Orca desktop renderer ───────────────────────────────────────────────── */
"use strict";

// ── Browser-preview stub ──────────────────────────────────────────────────
// In production, window.orca is injected by Electron's contextBridge preload.
// In a plain browser (static file preview / CI), it's absent — provide a
// no-op stub so the UI boots and can be inspected without Electron.
if (!window.orca) {
  window.orca = {
    onInitStatus:    () => {},
    onOrcaEvent:     () => () => {},
    onToolRequest:   () => () => {},
    sendMessage:     async () => ({ ok: false, error: "No Electron context" }),
    getSettings:     async () => ({ providers: [], roles: {}, budgetUsd: 0.10, maxRepairPasses: 2, verbose: false, workspaceRoot: "" }),
    saveSettings:    async () => ({ ok: false, error: "No Electron context" }),
    minimize:        () => {},
    close:           () => {},
    approveToolCall: () => {},
    selectWorkspace: async () => "",
    fetchModels:     async () => ({ ok: false, models: [] }),
    listSessions:    async () => [],
    loadSession:     async () => null,
    deleteSession:   async () => ({ ok: false, error: "No Electron context" }),
    abortTask:       () => {},
  };
}

// ── DOM refs ──────────────────────────────────────────────────────────────

const messages      = document.getElementById("messages");
const welcome       = document.getElementById("welcome");
const inputEl       = document.getElementById("input");
const sendBtn       = document.getElementById("send-btn");
const statusDot     = document.getElementById("status-dot");
const statusText    = document.getElementById("status-text");
const statusbarCost = document.getElementById("statusbar-cost");
const chatView      = document.getElementById("chat-view");
const settingsView  = document.getElementById("settings-view");
const attachBtn     = document.getElementById("attach-btn");
const fileInput     = document.getElementById("file-input");
const attachBar     = document.getElementById("attachments-bar");
const sidebar       = document.getElementById("sidebar");
const sessionList   = document.getElementById("session-list");
const topbarTitle   = document.getElementById("topbar-title");

// ── State ─────────────────────────────────────────────────────────────────

let busy = false;

// ── Pending file attachments ───────────────────────────────────────────────
// Each entry: { name, type, content, dataUrl?, isImage }
const pendingAttachments = [];

// Streaming: active bubble element + accumulated raw text while tokens arrive.
// Finalised (markdown-rendered) when sendMessage resolves.
let streamBubble = null;
let streamText   = "";

// Role selected for the current task (from role:selected event emitted by main.ts).
let currentRole = null;
// Token estimate for the current task (from run:stats event).
let pendingStats = null;
// Pipeline summary received during the current task; rendered after the response bubble.
let pendingPipelineSummary = null;
// Pipeline event log — collects key events during a task for display in the badge.
let pipelineEventLog = [];
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
    // Update existing warn or append new one (avoid stacking duplicates)
    const existing = messages.querySelector(".sys-msg.warn");
    const msg = s.error ?? "Initialization failed. Click ⚙ Settings to configure.";
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

  // Pipeline summary — store for rendering after the response bubble is finalised.
  // The event arrives before sendMessage resolves, so we buffer it here.
  if (e.type === "pipeline:summary") {
    pendingPipelineSummary = e;
    return;
  }

  // Collect key events for the pipeline log section of the badge.
  const LOG_TYPES = new Set(['task:start','maestro:start','maestro:done','qc:result','repair:start','task:done','dewey:brief','miranda:checkpoint']);
  if (LOG_TYPES.has(e.type)) {
    pipelineEventLog.push({ ...e, _ts: Date.now() });
  }

  // Stream reset: REWRITE is about to start — clear the ANSWER text from the
  // bubble so the polished output replaces it instead of appending.
  if (e.type === "stream:reset") {
    if (streamBubble) {
      streamText = "";
      const bubbleEl = streamBubble.querySelector(".stream-content");
      if (bubbleEl) bubbleEl.textContent = "";
    }
    return;
  }

  // Stream tokens arrive here during the sendMessage await.
  // Build a live bubble and append each chunk as raw text;
  // sendMessage's finally block replaces the raw text with rendered markdown.
  // Guard with busy: late IPC delivery after the task resolves must NOT create
  // a second bubble (would cause the response to appear twice).
  if (e.type === "stream:token") {
    if (!busy) return;
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
  inputEl.disabled   = !enabled;
  attachBtn.disabled = !enabled;
  // While running, morph send→stop; while idle, revert.
  sendBtn.disabled   = false;   // always clickable (it becomes Stop while running)
  sendBtn.classList.toggle("is-running", !enabled);
  sendBtn.title = enabled ? "Send  (Enter)" : "Stop";
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ── Safe markdown renderer ────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? "")
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

/**
 * Strip internal Miranda pipeline stage headers so users only see the
 * polished response content. Called before renderContent on all replies.
 */
function cleanPipelineOutput(raw) {
  // Regex literals for pipeline stage/section headers.
  // Using literals avoids the double-escaping trap with new RegExp().
  const HASH_HEADER  = /^#{1,3}\s*(Plan(\s*\(summary\))?|Answer|Critique|Rewrite|Next\s*steps?|Edge\s*cases?(\s*[&]\s*checks)?|Considerations?|Summary|Approach|Analysis|Steps|Output|Response|Result|Explanation)\s*$/i;
  const BOLD_HEADER  = /^\*\*(Plan(\s*\(summary\))?|Answer|Critique|Rewrite|Next\s*steps?|Edge\s*cases?(\s*[&]\s*checks)?|Considerations?|Summary|Approach|Analysis|Steps|Output|Response|Result|Explanation):?\*\*:?\s*$/i;

  const lines = raw.split("\n");
  const cleaned = lines.filter(line => {
    const t = line.trim();
    if (HASH_HEADER.test(t)) return false;
    if (BOLD_HEADER.test(t)) return false;
    return true;
  });
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

/** User message with optional image attachment thumbnails */
function appendUserMsg(text, attachments = []) {
  showMessages();
  const div = document.createElement("div");
  div.className = "msg user";

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = "You";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  // Image thumbnails above the text
  const images = (attachments ?? []).filter((a) => a.isImage && a.dataUrl);
  if (images.length) {
    const imgRow = document.createElement("div");
    imgRow.className = "msg-attachments";
    images.forEach((a) => {
      const img = document.createElement("img");
      img.className = "msg-attachment-img";
      img.src = a.dataUrl;
      img.alt = a.name;
      img.title = a.name;
      imgRow.appendChild(img);
    });
    bubble.appendChild(imgRow);
  }

  // Non-image file chips
  const files = (attachments ?? []).filter((a) => !a.isImage);
  if (files.length) {
    const fileRow = document.createElement("div");
    fileRow.className = "msg-file-chips";
    files.forEach((a) => {
      const chip = document.createElement("span");
      chip.className = "msg-file-chip";
      chip.textContent = a.name;
      fileRow.appendChild(chip);
    });
    bubble.appendChild(fileRow);
  }

  if (text) {
    const textNode = document.createTextNode(text);
    bubble.appendChild(textNode);
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
  const text = `~${inTok} in · ~${outTok} out (est.)`;
  div.textContent = text;
  messages.appendChild(div);
  // Also update statusbar cost slot
  if (statusbarCost) statusbarCost.textContent = text;
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

// ── Pipeline summary badge ────────────────────────────────────────────────
// Rendered once per task, below the final response bubble.
// Collapsed by default; click to expand for full trace detail.

function appendPipelineBadge(summary) {
  if (!summary) return;

  const verdictClass  = summary.verdict === "PASS" ? "pass" : summary.verdict === "WARN" ? "warn" : "fail";
  const confidencePct = Math.round((summary.confidence ?? 1) * 100);
  const durationSec   = ((summary.durationMs ?? 0) / 1000).toFixed(2);
  const repairText    = summary.repairPasses > 0
    ? ` · ${summary.repairPasses} repair${summary.repairPasses !== 1 ? "s" : ""}`
    : "";

  // ── Dewey brief ─────────────────────────────────────────────────────────
  let deweyHtml = "";
  if (summary.deweyBrief) {
    const d = summary.deweyBrief;
    const toneHtml = `<span class="pb-tone-chip">${escapeHtml(d.suggestedTone)}</span>`;
    const prefsHtml = (d.relevantPreferences ?? []).map(p => `<li>${escapeHtml(p)}</li>`).join("");
    const ctxHtml   = (d.relevantContext    ?? []).map(c => `<li>${escapeHtml(c)}</li>`).join("");
    deweyHtml = `
      <div>
        <div class="pb-section-title">Dewey brief — ${escapeHtml(d.userName ?? "")}</div>
        <div class="pb-dewey-row">tone: ${toneHtml}</div>
        ${prefsHtml ? `<ul class="pb-dewey-list">${prefsHtml}</ul>` : ""}
        ${ctxHtml   ? `<ul class="pb-dewey-list pb-dewey-ctx">${ctxHtml}</ul>` : ""}
      </div>`;
  }

  // ── Miranda checkpoints ──────────────────────────────────────────────────
  let mirandaHtml = "";
  if (summary.mirandaCheckpoints?.length) {
    const rows = summary.mirandaCheckpoints.map(c => {
      const cls  = c.allowed ? "allowed" : "blocked";
      const icon = c.allowed ? "✓" : "✕";
      return `<div class="pb-checkpoint">
        <span class="pb-checkpoint-gate">${escapeHtml(c.gate)}</span>
        <span class="pb-checkpoint-status ${cls}">${icon} ${c.allowed ? "ALLOWED" : "BLOCKED"}</span>
        <span class="pb-checkpoint-reason">${escapeHtml(c.reason)}</span>
      </div>`;
    }).join("");
    mirandaHtml = `
      <div>
        <div class="pb-section-title">Miranda checkpoints</div>
        <div class="pb-checkpoints-list">${rows}</div>
      </div>`;
  }

  // ── Acceptance criteria ──────────────────────────────────────────────────
  const criteriaHtml = (summary.acceptanceCriteria ?? []).map((c) => {
    const icon  = c.met ? "✓" : "○";
    const cls   = c.met ? "met" : "unmet";
    const label = c.required ? "" : ' <span class="pb-optional">(optional)</span>';
    return `<div class="pb-criterion">
      <span class="pb-criterion-icon ${cls}">${icon}</span>
      <span>${escapeHtml(c.text)}${label}</span>
    </div>`;
  }).join("");

  // ── Issues ───────────────────────────────────────────────────────────────
  const issuesHtml = (summary.issues ?? []).map((issue) =>
    `<div class="pb-issue">
      <div class="pb-issue-header">
        <span class="pb-severity ${escapeHtml(issue.severity)}">${escapeHtml(issue.severity)}</span>
        <span class="pb-issue-code">${escapeHtml(issue.code)}</span>
      </div>
      <div class="pb-issue-desc">${escapeHtml(issue.description)}</div>
    </div>`
  ).join("");

  // ── Pipeline event log ───────────────────────────────────────────────────
  let logHtml = "";
  const log = summary._eventLog ?? [];
  if (log.length) {
    const t0 = log[0]._ts ?? 0;
    const rows = log.map(e => {
      const rel = ((e._ts - t0) / 1000).toFixed(2);
      let label = e.type;
      if (e.type === "maestro:start")     label = e.isRepair ? `repair pass ${e.attempt}` : "generating";
      if (e.type === "maestro:done")      label = e.isRepair ? `repair done` : "reviewing";
      if (e.type === "qc:result")         label = `QC: ${e.verdict} (${e.issueCount} issue${e.issueCount !== 1 ? "s" : ""})`;
      if (e.type === "repair:start")      label = `repair ${e.pass}/${e.maxPasses}`;
      if (e.type === "dewey:brief")       label = `Dewey brief — tone: ${e.suggestedTone}`;
      if (e.type === "miranda:checkpoint") label = `Miranda ${e.gate}: ${e.allowed ? "ALLOWED" : "BLOCKED"}`;
      const cls = e.type === "qc:result" && e.verdict === "FAIL" ? " log-fail"
                : e.type === "qc:result" && e.verdict === "WARN" ? " log-warn"
                : "";
      return `<div class="pb-log-row${cls}">
        <span class="pb-log-ts">+${rel}s</span>
        <span class="pb-log-label">${escapeHtml(label)}</span>
      </div>`;
    }).join("");
    logHtml = `
      <div>
        <div class="pb-section-title">Pipeline log</div>
        <div class="pb-log">${rows}</div>
      </div>`;
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  const div = document.createElement("div");
  div.className = "pipeline-badge";
  div.innerHTML = `
    <div class="pipeline-badge-header">
      <span class="pb-role">${escapeHtml(String(summary.role ?? "unknown"))}</span>
      <span class="pb-verdict ${verdictClass}">${escapeHtml(summary.verdict)}</span>
      <span class="pb-confidence">${confidencePct}%</span>
      <span class="pb-duration">${durationSec}s${escapeHtml(repairText)}</span>
      <button class="pb-details-btn">Details <span class="pb-chevron">›</span></button>
    </div>
    <div class="pipeline-badge-detail">
      ${deweyHtml}
      ${mirandaHtml}
      ${criteriaHtml ? `<div><div class="pb-section-title">Acceptance criteria</div><div class="pb-criteria-list">${criteriaHtml}</div></div>` : ""}
      ${issuesHtml   ? `<div><div class="pb-section-title">Issues</div><div class="pb-issues-list">${issuesHtml}</div></div>` : ""}
      ${logHtml}
      <div class="pb-footer-row">${durationSec}s total · ${summary.repairPasses ?? 0} repair pass${(summary.repairPasses ?? 0) !== 1 ? "es" : ""}</div>
    </div>`;

  // Auto-expand on hard failure so the user immediately sees why.
  if (verdictClass === "fail") {
    div.classList.add("expanded");
  }

  div.querySelector(".pb-details-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    div.classList.toggle("expanded");
  });

  messages.appendChild(div);
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
  const text = inputEl.value.replace(/\r\n?/g, "\n").trim();
  const hasAttachments = pendingAttachments.length > 0;
  if (!text && !hasAttachments) return;
  if (busy) return;

  busy = true;
  pipelineEventLog = [];
  setInputEnabled(false);
  inputEl.value = "";
  autoResize();
  if (statusbarCost) statusbarCost.textContent = "";

  // Snapshot and clear attachments before async work
  const snapshotAttachments = pendingAttachments.splice(0);
  renderAttachmentBar();

  // Build the text that actually gets sent to the model
  const attachCtx = buildAttachmentContextFrom(snapshotAttachments);
  const fullText   = attachCtx ? (text ? `${attachCtx}\n\n${text}` : attachCtx) : text;

  // Show user bubble (with optional image previews)
  appendUserMsg(text, snapshotAttachments);
  if (text) setTopbarTitle(text);
  appendThinking();
  setStatus("planning…", true);

  let finalStatus = "ready";
  try {
    const result = await orca.sendMessage(fullText);
    removeThinking();

    if (streamBubble) {
      // Attach role badge before finalising (element still accessible here).
      if (currentRole) attachRoleBadge(streamBubble, currentRole);
      // Prefer the server-processed reply text (extractText picks REWRITE > ANSWER
      // and strips pipeline scaffolding).  Fall back to raw streamText only if the
      // server result is unavailable (e.g. error path).
      const cleanedReply = result.ok && result.reply?.text
        ? result.reply.text
        : streamText;
      const bubbleEl = streamBubble.querySelector(".stream-content");
      if (bubbleEl && cleanedReply) bubbleEl.innerHTML = renderContent(cleanPipelineOutput(cleanedReply));
      streamBubble.classList.remove("streaming");
      streamBubble = null;
      streamText   = "";
    } else if (result.ok) {
      const replyText = result.reply?.text ?? result.reply?.outputText ?? JSON.stringify(result.reply);
      const msgDiv = appendMsg("orca", cleanPipelineOutput(replyText));
      if (currentRole) attachRoleBadge(msgDiv, currentRole);
    } else if (result.error === "Stopped.") {
      appendSys("Stopped.", "info");
    } else {
      appendSys(result.error ?? "Unknown error.", "error");
    }

    // Post-reply metadata
    if (pendingStats) { appendStatsPill(pendingStats); pendingStats = null; }
    if (result.ok && result.reply?.filesChanged?.length) appendDiffCards(result.reply.filesChanged);
    if (pendingPipelineSummary) {
      pendingPipelineSummary._eventLog = pipelineEventLog.slice();
      appendPipelineBadge(pendingPipelineSummary);
      pendingPipelineSummary = null;
    }

    if (!result.ok) finalStatus = "error";
  } catch (err) {
    removeThinking();
    if (streamBubble) { streamBubble.remove(); streamBubble = null; streamText = ""; }
    appendSys(String(err), "error");
    finalStatus = "error";
  } finally {
    currentRole  = null;
    pendingPipelineSummary = null;   // discard if not yet rendered (abort / error path)
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

// ── File attachment logic ─────────────────────────────────────────────────

const IMAGE_TYPES = new Set(["image/png","image/jpeg","image/gif","image/webp","image/svg+xml","image/bmp"]);
const MAX_TEXT_BYTES = 200_000; // 200 KB text cap before truncation

function readAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

function readAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function addAttachment(file) {
  const isImage = IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
  let content = null;
  let dataUrl = null;

  if (isImage) {
    dataUrl = await readAsDataURL(file);
  } else {
    // Try reading as text (will work for text/code files)
    const raw = await readAsText(file);
    if (raw !== null) {
      content = raw.length > MAX_TEXT_BYTES
        ? raw.slice(0, MAX_TEXT_BYTES) + `\n\n[… truncated — file is ${formatBytes(file.size)} total]`
        : raw;
    }
  }

  const att = { name: file.name, type: file.type, size: file.size, isImage, content, dataUrl };
  pendingAttachments.push(att);
  renderAttachmentBar();
}

function removeAttachment(idx) {
  pendingAttachments.splice(idx, 1);
  renderAttachmentBar();
}

function renderAttachmentBar() {
  if (!pendingAttachments.length) {
    attachBar.style.display = "none";
    attachBar.innerHTML = "";
    return;
  }
  attachBar.style.display = "flex";
  attachBar.innerHTML = pendingAttachments.map((att, i) => {
    if (att.isImage && att.dataUrl) {
      return `
        <div class="attach-chip attach-chip--image" data-idx="${i}">
          <img class="attach-thumb" src="${escapeHtml(att.dataUrl)}" alt="${escapeHtml(att.name)}" />
          <span class="attach-chip-name">${escapeHtml(att.name)}</span>
          <button class="attach-chip-remove" data-idx="${i}" title="Remove">✕</button>
        </div>`;
    }
    const icon = att.content === null ? "📄" : "📝";
    return `
      <div class="attach-chip" data-idx="${i}">
        <span class="attach-chip-icon">${icon}</span>
        <span class="attach-chip-name">${escapeHtml(att.name)}</span>
        <span class="attach-chip-size">${formatBytes(att.size)}</span>
        <button class="attach-chip-remove" data-idx="${i}" title="Remove">✕</button>
      </div>`;
  }).join("");

  attachBar.querySelectorAll(".attach-chip-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAttachment(+btn.dataset.idx);
    });
  });
}

// Build the context block from a given attachment array (not pendingAttachments directly).
function buildAttachmentContextFrom(attachments) {
  if (!attachments.length) return "";
  const parts = [];
  for (const att of attachments) {
    if (att.isImage) {
      parts.push(`[Attached image: ${att.name}]`);
    } else if (att.content !== null) {
      const ext = att.name.split(".").pop() ?? "";
      parts.push(`[Attached file: ${att.name}]\n\`\`\`${ext}\n${att.content}\n\`\`\``);
    } else {
      parts.push(`[Attached file: ${att.name} (binary, ${formatBytes(att.size)})]`);
    }
  }
  return parts.join("\n\n");
}

// Button wiring
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = ""; // allow re-selecting the same file
  for (const f of files) await addAttachment(f);
});

// Drag-and-drop onto the input area
const inputWrap = document.getElementById("input-wrap");
inputWrap.addEventListener("dragover", (e) => {
  e.preventDefault();
  inputWrap.classList.add("drag-over");
});
inputWrap.addEventListener("dragleave", () => inputWrap.classList.remove("drag-over"));
inputWrap.addEventListener("drop", async (e) => {
  e.preventDefault();
  inputWrap.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer?.files ?? []);
  for (const f of files) await addAttachment(f);
});

// Paste images directly into the chat
inputEl.addEventListener("paste", async (e) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type));
  if (!imageItems.length) return;
  e.preventDefault();
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (file) await addAttachment(file);
  }
});

// ── Keyboard ──────────────────────────────────────────────────────────────
// Enter        → send
// Alt+Enter or Shift+Enter → insert a newline

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (e.altKey || e.shiftKey) {
      // Insert a literal newline at the cursor position
      e.preventDefault();
      const start = inputEl.selectionStart;
      const end   = inputEl.selectionEnd;
      inputEl.value =
        inputEl.value.slice(0, start) + "\n" + inputEl.value.slice(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + 1;
      autoResize();
    } else {
      // Plain Enter → send
      e.preventDefault();
      sendMessage();
    }
  }
});

// ── Settings panel ────────────────────────────────────────────────────────

const setBudget  = document.getElementById("set-budget");
const setRepairs = document.getElementById("set-repairs");
const setVerbose      = document.getElementById("set-verbose");
const setWorkspace    = document.getElementById("set-workspace");
const setSaveBtn      = document.getElementById("btn-save-settings");
const setStatus2 = document.getElementById("settings-status");

// ── Provider & role metadata ───────────────────────────────────────────────

const PROVIDER_TYPES = [
  { value: "openrouter",  label: "OpenRouter",  defaultUrl: "https://openrouter.ai/api/v1",  needsKey: true  },
  { value: "ollama",      label: "Ollama",       defaultUrl: "http://localhost:11434",         needsKey: false },
  { value: "deepseek",    label: "DeepSeek",     defaultUrl: "https://api.deepseek.com/v1",   needsKey: true  },
  { value: "siliconflow", label: "SiliconFlow",  defaultUrl: "https://api.siliconflow.cn/v1", needsKey: true  },
  { value: "openai",      label: "OpenAI",       defaultUrl: "https://api.openai.com/v1",     needsKey: true  },
  { value: "anthropic",   label: "Anthropic",    defaultUrl: "https://api.anthropic.com/v1",  needsKey: true  },
  { value: "zai",         label: "ZAI",          defaultUrl: "https://api.z.ai/v1",                                   needsKey: true  },
  { value: "alibaba",     label: "Alibaba",      defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",     needsKey: true  },
  { value: "custom",      label: "Custom",       defaultUrl: "",                                                      needsKey: true  },
];

const MODEL_HINTS = {
  openrouter:  "e.g. anthropic/claude-3.5-sonnet",
  ollama:      "e.g. llama3.2, deepseek-r1:14b",
  deepseek:    "e.g. deepseek-chat",
  siliconflow: "e.g. Qwen/Qwen2.5-72B-Instruct",
  openai:      "e.g. gpt-4o",
  anthropic:   "e.g. claude-3-5-sonnet-20241022",
  zai:         "e.g. gpt-4o",
  alibaba:     "e.g. qwen-max, qwen-plus",
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

const escHtml = escapeHtml;

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
    const isCustom = p.type === "custom";
    const fetchBtn = isCustom
      ? `<span class="prov-custom-hint">Type model names directly in the role fields</span>`
      : `<button class="btn-fetch-models" data-prov-idx="${i}" title="Fetch available models from this provider">Fetch models</button>`;
    return `
      <div class="provider-item" data-prov-idx="${i}">
        <div class="provider-row-top">
          <input class="setting-input prov-name" placeholder="Display name" value="${escHtml(p.name)}" />
          <select class="prov-type">${typeOpts}</select>
          ${fetchBtn}
          <button class="btn-remove" data-remove-prov="${i}" title="Remove">✕</button>
        </div>
        <input class="setting-input prov-url" placeholder="Base URL" value="${escHtml(p.baseUrl)}" />
        <div class="provider-key-row"${needsKey ? "" : ' style="display:none"'}>
          <input type="password" class="setting-input prov-key" placeholder="API key" value="${escHtml(p.apiKey)}" autocomplete="off" />
          <button class="setting-show-btn prov-show-key" type="button">Show</button>
        </div>
        <div class="fetch-models-status" style="display:none;font-size:11px;color:var(--text-muted);margin-top:4px"></div>
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
      statusEl.style.color   = "var(--text-muted)";
      statusEl.textContent = "Contacting provider…";
      const result = await orca.fetchModels({ type: prov.type, baseUrl: prov.baseUrl, apiKey: prov.apiKey });
      this.disabled = false;
      this.textContent = "Fetch models";
      if (result.ok && result.models?.length) {
        fetchedModels.set(prov.id, result.models);
        statusEl.textContent = `${result.models.length} model(s) loaded — type in a role field to autocomplete.`;
        statusEl.style.color = "var(--accent)";
        updateModelDataLists();
      } else {
        statusEl.textContent = result.error ?? "No models returned.";
        statusEl.style.color = "var(--danger)";
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
    const entry           = editingSettings.roles[role.id] ?? { providerId: "", model: "" };
    const hint            = MODEL_HINTS[getProviderType(entry.providerId)] ?? "model";
    const hasProvider     = !!entry.providerId;
    const thinkingChecked = entry.enableThinking === true ? " checked" : "";
    const hiddenClass     = hasProvider ? "" : " role-thinking-hidden";
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
        <div class="role-thinking-cell${hiddenClass}" title="Enable deep thinking / chain-of-thought for this role">
          <label class="toggle">
            <input type="checkbox" class="role-thinking-cb"${thinkingChecked} />
            <span class="toggle-track"></span>
          </label>
          <span class="role-thinking-lbl">Thinking</span>
        </div>
      </div>`;
  }).join("");

  el.querySelectorAll(".role-provider-sel").forEach((sel) => {
    sel.addEventListener("change", function () {
      const roleId = this.closest(".role-row").dataset.roleId;
      if (!editingSettings.roles[roleId]) editingSettings.roles[roleId] = { providerId: "", model: "" };
      editingSettings.roles[roleId].providerId = this.value;
      const modelInp = this.closest(".role-row").querySelector(".role-model-inp");
      modelInp.placeholder = MODEL_HINTS[getProviderType(this.value)] ?? "model";
      // Show or hide the thinking toggle based on whether a provider is now set
      const thinkingCell = this.closest(".role-row").querySelector(".role-thinking-cell");
      if (thinkingCell) thinkingCell.classList.toggle("role-thinking-hidden", !this.value);
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

  el.querySelectorAll(".role-thinking-cb").forEach((cb) => {
    cb.addEventListener("change", function () {
      const roleId = this.closest(".role-row").dataset.roleId;
      if (!editingSettings.roles[roleId]) editingSettings.roles[roleId] = { providerId: "", model: "" };
      editingSettings.roles[roleId].enableThinking = this.checked ? true : false;
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
    setWorkspace.value     = s.workspaceRoot ?? "";
    setStatus2.textContent = "";
    setStatus2.className   = "settings-status";
    // Prune stale model cache for providers that no longer exist in saved settings
    const activeIds = new Set((s.providers ?? []).map((p) => p.id));
    for (const id of fetchedModels.keys()) {
      if (!activeIds.has(id)) fetchedModels.delete(id);
    }
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
    workspaceRoot:   setWorkspace.value.trim(),
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

document.getElementById("btn-pick-workspace").addEventListener("click", async () => {
  const chosen = await orca.selectWorkspace();
  if (chosen) {
    setWorkspace.value = chosen;
    if (editingSettings) editingSettings.workspaceRoot = chosen;
  }
});

// ── Button wiring ─────────────────────────────────────────────────────────

sendBtn.addEventListener("click", () => {
  if (busy) {
    orca.abortTask();
  } else {
    sendMessage();
  }
});
document.getElementById("btn-settings").addEventListener("click",      openSettings);
document.getElementById("btn-settings-back").addEventListener("click", closeSettings);
document.getElementById("btn-minimize").addEventListener("click", () => orca.minimize());
document.getElementById("btn-close").addEventListener("click",    () => orca.close());

// ── Tool approval dialog ────────────────────────────────────────────

// Tools the user has permanently approved for this session
const sessionApprovedTools = new Set();

let approvalTimerInterval = null;
const APPROVAL_TIMEOUT_S  = 60;

function clearApprovalTimer() {
  if (approvalTimerInterval) { clearInterval(approvalTimerInterval); approvalTimerInterval = null; }
  const el = document.getElementById("approval-timer");
  if (el) el.textContent = "";
}

function startApprovalTimer(onTimeout) {
  clearApprovalTimer();
  let remaining = APPROVAL_TIMEOUT_S;
  const el = document.getElementById("approval-timer");
  const tick = () => {
    if (el) el.textContent = `${remaining}s`;
    if (remaining <= 0) { clearApprovalTimer(); onTimeout(); }
    remaining--;
  };
  tick();
  approvalTimerInterval = setInterval(tick, 1000);
}

function resolveApproval(approved) {
  clearApprovalTimer();
  const dialog = document.getElementById("tool-approval-dialog");
  const id   = dialog.dataset.approvalId;
  const tool = document.getElementById("approval-tool-name").textContent;
  const card = toolCallCards.get(id);

  if (approved && document.getElementById("chk-always-approve").checked) {
    sessionApprovedTools.add(tool);
  }

  if (card) {
    card.classList.replace("pending", approved ? "approved" : "denied");
    card.querySelector(".tool-card-status").textContent = approved ? "\u2713 Approved" : "\u2717 Denied";
  }
  toolCallCards.delete(id);
  orca.approveToolCall(id, approved);
  dialog.style.display = "none";
  document.getElementById("chk-always-approve").checked = false;
}

orca.onToolRequest((id, tool, args) => {
  if (!tool || !String(tool).trim()) return;

  const card = appendToolCard(id, tool, args);
  toolCallCards.set(id, card);

  // Auto-approve if the user approved this tool for the session
  if (sessionApprovedTools.has(tool)) {
    card.classList.replace("pending", "approved");
    card.querySelector(".tool-card-status").textContent = "\u2713 Auto-approved";
    toolCallCards.delete(id);
    orca.approveToolCall(id, true);
    return;
  }

  const dialog = document.getElementById("tool-approval-dialog");
  document.getElementById("approval-tool-name").textContent  = tool;
  document.getElementById("approval-tool-name-2").textContent = tool;
  document.getElementById("approval-args").textContent =
    typeof args === "object" && args !== null
      ? JSON.stringify(args, null, 2)
      : String(args);
  dialog.dataset.approvalId = id;
  dialog.style.display      = "flex";

  startApprovalTimer(() => resolveApproval(false));
});

document.getElementById("btn-approve-tool").addEventListener("click", () => resolveApproval(true));
document.getElementById("btn-deny-tool").addEventListener("click",    () => resolveApproval(false));

// ── Chat session sidebar ──────────────────────────────────────────────────

let sidebarOpen = false;

function setTopbarTitle(text) {
  if (!topbarTitle) return;
  if (!text) {
    topbarTitle.textContent = "orca";
    topbarTitle.classList.remove("has-chat");
  } else {
    topbarTitle.textContent = truncateSession(text, 42);
    topbarTitle.classList.add("has-chat");
  }
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle("open", sidebarOpen);
  if (sidebarOpen) refreshSessionList();
}

async function refreshSessionList() {
  sessionList.innerHTML = '<p class="sidebar-empty">Loading\u2026</p>';
  let sessions;
  try {
    sessions = await orca.listSessions();
  } catch {
    sessionList.innerHTML = '<p class="sidebar-empty">Could not load history.</p>';
    return;
  }
  if (!sessions || !sessions.length) {
    sessionList.innerHTML = '<p class="sidebar-empty">No history yet.</p>';
    return;
  }
  const startToday     = new Date(); startToday.setHours(0,0,0,0);
  const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);

  function getGroup(iso) {
    const t = new Date(iso).getTime();
    if (t >= startToday.getTime())     return "Today";
    if (t >= startYesterday.getTime()) return "Yesterday";
    return "Earlier";
  }

  const groups = [["Today", []], ["Yesterday", []], ["Earlier", []]];
  const groupMap = { Today: groups[0][1], Yesterday: groups[1][1], Earlier: groups[2][1] };
  sessions.forEach((s) => groupMap[getGroup(s.createdAt)].push(s));

  function renderItem(s) {
    const label  = truncateSession(s.intent, 50);
    const date   = fmtSessionDate(s.createdAt);
    const failed = s.status === "FAIL" ? ' session-failed' : '';
    return `<div class="session-item${failed}" data-sid="${escapeHtml(s.id)}" title="${escapeHtml(s.intent)}">
      <div class="session-intent">${escapeHtml(label)}</div>
      <div class="session-meta"><span>${escapeHtml(date)}</span></div>
      <button class="session-delete-btn" data-sid="${escapeHtml(s.id)}" title="Delete this session" aria-label="Delete session">✕</button>
    </div>`;
  }

  sessionList.innerHTML = groups
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) =>
      `<div class="session-group-label">${escapeHtml(label)}</div>` +
      items.map(renderItem).join("")
    ).join("");
  sessionList.querySelectorAll(".session-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".session-delete-btn")) return;
      loadSession(item.dataset.sid);
    });
  });
  sessionList.querySelectorAll(".session-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(btn.dataset.sid);
    });
  });
}

async function loadSession(id) {
  let session;
  try {
    session = await orca.loadSession(id);
  } catch {
    return;
  }
  if (!session) return;

  // Switch to chat view and replace contents with this run
  settingsView.style.display = "none";
  chatView.style.display     = "flex";
  messages.innerHTML         = "";
  showMessages();
  setTopbarTitle(session.intent);

  appendMsg("user", session.intent);
  if (session.outputText) {
    appendMsg("orca", cleanPipelineOutput(session.outputText));
  } else if (session.status === "FAIL") {
    appendSys("This run failed — no output was recorded.", "warn");
  }
  scrollToBottom();
}

async function deleteSession(id) {
  try {
    await orca.deleteSession(id);
  } catch {
    // silently ignore — still remove from UI
  }
  // Optimistically remove the item from the DOM without full reload
  const el = sessionList.querySelector(`.session-item[data-sid="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add("session-deleting");
    setTimeout(() => {
      el.remove();
      if (!sessionList.querySelector(".session-item")) {
        sessionList.innerHTML = '<p class="sidebar-empty">No history yet.</p>';
      }
    }, 180);
  }
}

function newChat() {
  messages.innerHTML         = "";
  welcome.style.display      = "";
  messages.style.display     = "none";
  settingsView.style.display = "none";
  chatView.style.display     = "flex";
  if (statusbarCost) statusbarCost.textContent = "";
  setTopbarTitle(null);
  inputEl.focus();
}

function truncateSession(s, n) {
  const clean = String(s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "\u2026" : clean;
}

function fmtSessionDate(iso) {
  try {
    const d    = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000)        return "just now";
    if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

document.getElementById("btn-hamburger").addEventListener("click",      toggleSidebar);
document.getElementById("btn-sidebar-new-chat").addEventListener("click", () => { newChat(); if (sidebarOpen) toggleSidebar(); });
document.getElementById("sidebar-btn-settings").addEventListener("click", () => { if (sidebarOpen) toggleSidebar(); openSettings(); });
document.getElementById("sidebar-btn-history").addEventListener("click",  () => { refreshSessionList(); });

// ── Theme toggle ──────────────────────────────────────────────────────────

// Titlebar: tight-cropped _only_ variants (small, clean)
const BRAND_DARK  = "orca-logo-dark.png";
const BRAND_LIGHT = "orca-logo-light.png";
// Welcome screen: padded variants (more canvas, no clipping)
const WELCOME_DARK  = "orca-welcome-dark.png";
const WELCOME_LIGHT = "orca-welcome-light.png";

function setThemeLogos(isLight) {
  const brand   = document.getElementById("logo-brand");
  const welcome = document.getElementById("logo-welcome");
  if (brand)   brand.src   = isLight ? BRAND_LIGHT   : BRAND_DARK;
  if (welcome) welcome.src = isLight ? WELCOME_LIGHT  : WELCOME_DARK;
}

(function initTheme() {
  const isLight = localStorage.getItem("orca-theme") === "light";
  if (isLight) document.body.classList.add("light");
  setThemeLogos(isLight);
})();

document.getElementById("btn-theme").addEventListener("click", () => {
  const isLight = document.body.classList.toggle("light");
  localStorage.setItem("orca-theme", isLight ? "light" : "dark");
  setThemeLogos(isLight);
});

// ── Focus input on load ───────────────────────────────────────────────────

inputEl.focus();
