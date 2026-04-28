/* ── Orca pipeline trace (Phase 1 visibility UI) ──────────────────────────
 * Produces a normalized, *safe* user-facing representation of pipeline
 * progress events. The renderer uses this to drive the live "Orca is
 * working…" panel without exposing chain-of-thought, raw prompts,
 * scratchpads, or tool args.
 *
 * Two pieces:
 *   1. mapOrcaEventToTraceRow(e) — pure function: OrcaEvent → UI row | null
 *   2. createLiveTracePanel({ messagesEl }) — minimal DOM controller
 *
 * Loaded as a classic <script>; also exported via CommonJS for unit tests.
 */
(function (root) {
  "use strict";

  // ── Component / status enums ─────────────────────────────────────────────
  const COMPONENT_BENSON  = "Benson";
  const COMPONENT_BRAIN   = "Brain";
  const COMPONENT_DEWEY   = "Dewey";
  const COMPONENT_MIRANDA = "Miranda";
  const COMPONENT_PAPPY   = "Pappy";
  const COMPONENT_MAESTRO = "Maestro";
  const COMPONENT_WORKER  = "Worker";

  const STATUS_RUNNING = "running";
  const STATUS_OK      = "ok";
  const STATUS_WARN    = "warn";
  const STATUS_FAIL    = "fail";
  const STATUS_BLOCKED = "blocked";

  const MAX_SUMMARY_LEN = 160;
  const MAX_DETAIL_LEN  = 240;

  /**
   * Trim a string for safe display: strip control chars, cap length.
   * Never include this function's output in places that interpret HTML —
   * the panel always escapes before rendering.
   */
  function safeString(value, max) {
    if (value == null) return "";
    let s = String(value);
    s = s.replace(/[\x00-\x1f\x7f]/g, " ");
    const cap = typeof max === "number" ? max : MAX_DETAIL_LEN;
    if (s.length > cap) s = s.slice(0, Math.max(0, cap - 1)) + "…";
    return s;
  }

  function makeRow(spec) {
    const row = {
      id:        String(spec.id),
      runId:     String(spec.runId == null ? "" : spec.runId),
      component: String(spec.component),
      stage:     String(spec.stage),
      status:    String(spec.status),
      summary:   safeString(spec.summary, MAX_SUMMARY_LEN),
    };
    if (spec.details != null && spec.details !== "") {
      row.details = safeString(spec.details, MAX_DETAIL_LEN);
    }
    if (typeof spec.startedAt === "number")  row.startedAt  = spec.startedAt;
    if (typeof spec.endedAt   === "number")  row.endedAt    = spec.endedAt;
    if (typeof spec.durationMs === "number") row.durationMs = spec.durationMs;
    return row;
  }

  /**
   * Map a runtime OrcaEvent to a single normalized UI trace row.
   * Returns null when the event has no safe user-facing representation.
   *
   * SAFETY: never return any model chain-of-thought, raw prompt, raw tool
   * arg, scratchpad, or secret. Summaries describe *what happened* in plain
   * language — not what the model thought. Events that could leak such
   * material (maestro:thought, stream:token) return null here.
   */
  function mapOrcaEventToTraceRow(e, opts) {
    if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
    const o = opts || {};
    const now = typeof o.now === "number" ? o.now : Date.now();
    const seq = typeof o.seq === "number" ? o.seq : now;
    const id  = (e.taskId || "run") + ":" + e.type + ":" + seq;
    const base = { id: id, runId: e.taskId, startedAt: now };

    switch (e.type) {
      case "task:start":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_BENSON,
          stage:     "received",
          status:    STATUS_RUNNING,
          summary:   "Received your request",
        }));

      case "dewey:brief":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_DEWEY,
          stage:     "context",
          status:    STATUS_OK,
          summary:   "Loaded user context",
          details:   e.suggestedTone ? "Suggested tone: " + e.suggestedTone : "",
        }));

      case "miranda:checkpoint":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_MIRANDA,
          stage:     e.gate || "gate",
          status:    e.allowed ? STATUS_OK : STATUS_BLOCKED,
          summary:   "Gate " + (e.gate || "checkpoint") + ": " + (e.allowed ? "passed" : "blocked"),
          details:   e.reason ? "Reason: " + safeString(e.reason, 160) : "",
        }));

      case "maestro:start":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_BRAIN,
          stage:     e.isRepair ? "repair" : "planning",
          status:    STATUS_RUNNING,
          summary:   e.isRepair ? "Repair pass " + e.attempt : "Planning & routing",
        }));

      case "maestro:done":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_MAESTRO,
          stage:     "synthesis",
          status:    e.hasOutput ? STATUS_OK : STATUS_WARN,
          summary:   e.isRepair ? "Repair pass " + e.attempt + " done" : "Synthesis complete",
        }));

      case "maestro:agent_start":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + e.role + ")",
          stage:     "running",
          status:    STATUS_RUNNING,
          summary:   e.role + " agent generating",
        }));

      case "maestro:agent_done": {
        const ok      = e.stoppedBecause === "done";
        const isError = e.stoppedBecause === "error";
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + e.role + ")",
          stage:     "complete",
          status:    ok ? STATUS_OK : (isError ? STATUS_FAIL : STATUS_WARN),
          summary:   ok
            ? e.role + " done (" + e.iterations + " iter)"
            : e.role + " stopped: " + e.stoppedBecause,
        }));
      }

      case "subagent:spawned":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + e.role + ")",
          stage:     "spawn",
          status:    STATUS_RUNNING,
          summary:   "Started worker " + e.role,
        }));

      case "subagent:done":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + e.role + ")",
          stage:     "complete",
          status:    e.ok ? STATUS_OK : STATUS_WARN,
          summary:   e.ok ? "Worker " + e.role + " done" : "Worker " + e.role + " incomplete",
        }));

      case "subagent:failed":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + e.role + ")",
          stage:     "failed",
          status:    STATUS_FAIL,
          summary:   "Worker " + e.role + " failed",
          details:   e.error ? safeString(e.error, 160) : "",
        }));

      case "qc:result": {
        const status = e.verdict === "PASS" ? STATUS_OK
                     : e.verdict === "WARN" ? STATUS_WARN
                     : STATUS_FAIL;
        const issueCount = Number(e.issueCount || 0);
        const summary = e.verdict === "PASS"
          ? "QC passed"
          : "QC " + e.verdict + ": " + issueCount + " issue" + (issueCount === 1 ? "" : "s");
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_PAPPY,
          stage:     "qc",
          status:    status,
          summary:   summary,
        }));
      }

      case "repair:start":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_PAPPY,
          stage:     "repair",
          status:    STATUS_RUNNING,
          summary:   "Repair pass " + e.pass + "/" + e.maxPasses,
        }));

      case "task:done":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_BENSON,
          stage:     "response",
          status:    e.status === "SUCCESS" ? STATUS_OK
                  :  e.status === "WARN"    ? STATUS_WARN
                  :                            STATUS_FAIL,
          summary:   "Preparing final response",
        }));

      // Explicit "no user-facing surface" — privacy boundary.
      // maestro:thought / stream:token can carry chain-of-thought or raw
      // model output. role:selected and run:stats are handled elsewhere.
      case "maestro:thought":
      case "stream:token":
      case "stream:reset":
      case "pipeline:summary":
      case "role:selected":
      case "run:stats":
        return null;

      default:
        return null;
    }
  }

  // ── Live trace panel (DOM controller) ────────────────────────────────────

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusIcon(status) {
    switch (status) {
      case "ok":      return "✓";
      case "warn":    return "!";
      case "fail":    return "✕";
      case "blocked": return "○";
      case "running":
      default:        return "▸";
    }
  }

  /**
   * Create a compact "Orca is working…" panel attached under messagesEl.
   * Returns a controller with pushRow / setRole / finish / destroy.
   *
   * The panel renders only sanitized rows from mapOrcaEventToTraceRow.
   * Callers MUST NOT push raw event payloads into pushRow — go through
   * the mapper so privacy boundaries are enforced in one place.
   */
  function createLiveTracePanel(opts) {
    if (!opts || !opts.messagesEl) {
      throw new Error("createLiveTracePanel: messagesEl required");
    }
    const messagesEl = opts.messagesEl;
    const startedAt  = typeof opts.now === "number" ? opts.now : Date.now();

    const seenKeys   = new Set();
    let timerHandle  = null;
    let finished     = false;
    let expanded     = false;
    let role         = null;

    const wrap = document.createElement("div");
    wrap.className = "live-trace-panel";
    wrap.setAttribute("data-runid", String(opts.runId || ""));
    wrap.innerHTML = ""
      + '<div class="ltp-header" role="button" aria-expanded="false" tabindex="0">'
      +   '<span class="ltp-spinner" aria-hidden="true"></span>'
      +   '<span class="ltp-title">Orca is working…</span>'
      +   '<span class="ltp-role" data-role hidden></span>'
      +   '<span class="ltp-current" data-current></span>'
      +   '<span class="ltp-elapsed" data-elapsed>0.0s</span>'
      +   '<button class="ltp-toggle" type="button" aria-expanded="false">'
      +     'Details <span class="ltp-chevron" aria-hidden="true">›</span>'
      +   '</button>'
      + '</div>'
      + '<div class="ltp-detail" data-detail role="region" aria-label="Pipeline progress" hidden>'
      +   '<div class="ltp-rows" data-rows></div>'
      + '</div>';

    const headerEl  = wrap.querySelector(".ltp-header");
    const roleEl    = wrap.querySelector("[data-role]");
    const currentEl = wrap.querySelector("[data-current]");
    const elapsedEl = wrap.querySelector("[data-elapsed]");
    const toggleBtn = wrap.querySelector(".ltp-toggle");
    const detailEl  = wrap.querySelector("[data-detail]");
    const rowsEl    = wrap.querySelector("[data-rows]");

    function tickElapsed() {
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      elapsedEl.textContent = sec + "s";
    }

    function setExpanded(next) {
      expanded = !!next;
      detailEl.hidden = !expanded;
      headerEl.setAttribute("aria-expanded", String(expanded));
      toggleBtn.setAttribute("aria-expanded", String(expanded));
      // First text node = leading "Details "/"Hide " label
      if (toggleBtn.firstChild) {
        toggleBtn.firstChild.nodeValue = expanded ? "Hide " : "Details ";
      }
      wrap.classList.toggle("expanded", expanded);
    }

    function rowDedupKey(row) {
      return row.component + "|" + row.stage + "|" + row.status + "|" + row.summary;
    }

    function renderRow(row) {
      const div = document.createElement("div");
      div.className = "ltp-row ltp-status-" + row.status;
      const icon = statusIcon(row.status);
      const tsLabel = typeof row.startedAt === "number"
        ? "+" + ((row.startedAt - startedAt) / 1000).toFixed(1) + "s"
        : "";
      div.innerHTML = ""
        + '<span class="ltp-row-icon" aria-hidden="true">' + escapeHtml(icon) + '</span>'
        + '<span class="ltp-row-component">' + escapeHtml(row.component) + '</span>'
        + '<span class="ltp-row-summary">'   + escapeHtml(row.summary)   + '</span>'
        + '<span class="ltp-row-ts">'        + escapeHtml(tsLabel)       + '</span>'
        + (row.details
            ? '<div class="ltp-row-details">' + escapeHtml(row.details) + '</div>'
            : "");
      return div;
    }

    function pushRow(row) {
      if (!row || finished) return false;
      const key = rowDedupKey(row);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      rowsEl.appendChild(renderRow(row));
      currentEl.textContent = row.component + " · " + row.summary;
      return true;
    }

    function setRole(roleName, isFallback) {
      role = { role: roleName, isFallback: !!isFallback };
      roleEl.textContent = roleName;
      roleEl.classList.toggle("fallback", !!isFallback);
      roleEl.hidden = !roleName;
    }

    function start() {
      if (timerHandle != null) return;
      tickElapsed();
      timerHandle = setInterval(tickElapsed, 250);
    }

    function finish(finalLabel) {
      if (finished) return;
      finished = true;
      if (timerHandle != null) {
        clearInterval(timerHandle);
        timerHandle = null;
      }
      tickElapsed();
      wrap.classList.add("done");
      if (finalLabel) currentEl.textContent = finalLabel;
    }

    function destroy() {
      finish();
      if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
    }

    headerEl.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".ltp-toggle")) return;
      setExpanded(!expanded);
    });
    headerEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        setExpanded(!expanded);
      }
    });
    toggleBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setExpanded(!expanded);
    });

    messagesEl.appendChild(wrap);
    start();

    return {
      element:    wrap,
      pushRow:    pushRow,
      setRole:    setRole,
      finish:     finish,
      destroy:    destroy,
      isFinished: function () { return finished; },
    };
  }

  const api = {
    mapOrcaEventToTraceRow: mapOrcaEventToTraceRow,
    safeString:             safeString,
    createLiveTracePanel:   createLiveTracePanel,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.PipelineTrace = api;
})(typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : null));
