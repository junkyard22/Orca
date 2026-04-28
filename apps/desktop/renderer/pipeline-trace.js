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

  // ── Safe-summary helpers ────────────────────────────────────────────────
  // Each helper coerces *only existing event metadata* into a printable form.
  // None of them accept or transform free-text payloads beyond what
  // safeString already permits, so they cannot leak chain-of-thought,
  // prompts, scratchpads, or tool args.

  /** Coerce a count to a non-negative integer, clamped to a sane display max. */
  function safeCount(n) {
    const v = Number(n);
    if (!isFinite(v) || v < 0) return 0;
    if (v > 9999) return 9999;
    return Math.floor(v);
  }

  /** Sanitize a role label to a short, control-stripped string. */
  function safeRole(role) {
    const s = safeString(role, 32).trim();
    return s || "worker";
  }

  /** Coerce a QC verdict to one of the known enums, or "UNKNOWN". */
  function safeVerdict(v) {
    if (v === "PASS" || v === "WARN" || v === "FAIL") return v;
    return "UNKNOWN";
  }

  /** Sanitize a stage / gate name to a short, control-stripped string. */
  function safeStage(s) {
    const out = safeString(s, 32).trim();
    return out || "stage";
  }

  /** Render a duration in ms as a compact human label ("0.4s", "12s", "2m 13s"). */
  function formatDuration(ms) {
    const v = Number(ms);
    if (!isFinite(v) || v < 0) return "";
    if (v < 1000)   return (v / 1000).toFixed(1) + "s";
    if (v < 60000)  return Math.round(v / 1000) + "s";
    const mins = Math.floor(v / 60000);
    const secs = Math.round((v % 60000) / 1000);
    return mins + "m " + secs + "s";
  }

  /** Pluralize "issue"/"item"/etc by count without exposing free-text content. */
  function pluralize(n, singular, plural) {
    return n === 1 ? singular : (plural || singular + "s");
  }

  /**
   * Format a QC issue summary line from { verdict, issueCount } only.
   * NEVER includes issue descriptions — those can echo model-generated text
   * back to the user. Codes are constant identifiers and safe in details.
   */
  function formatIssueSummary(verdict, issueCount) {
    const v = safeVerdict(verdict);
    const n = safeCount(issueCount);
    if (v === "PASS") return "QC passed";
    const verb = v === "WARN" ? "warned" : v === "FAIL" ? "failed" : "reported";
    return "QC " + verb + " · " + n + " " + pluralize(n, "issue");
  }

  /**
   * Humanize maestro:agent_done.stoppedBecause enum values into safe
   * user-facing phrases. Any unknown / internal stop reason falls through
   * to a generic "stopped" — the raw runtime token is NEVER echoed back to
   * the user, per the Miranda Architecture Lock rule that internal
   * controlled-stop reasons must not surface as user-facing phrases.
   */
  function humanizeStopReason(stoppedBecause) {
    switch (stoppedBecause) {
      case "done":               return "completed";
      case "max_iterations":     return "stopped · max iterations";
      case "loop_detected":      return "stopped · loop detected";
      case "parse_failure_loop": return "stopped · parse loop";
      case "no_final_output":    return "stopped · no final output";
      case "error":              return "errored";
      default:                   return "stopped";
    }
  }

  /** Collapse the first few issue codes into a short, safe details line. */
  function formatIssueCodes(issues, max) {
    if (!Array.isArray(issues) || issues.length === 0) return "";
    const cap = typeof max === "number" ? max : 3;
    const codes = [];
    for (let i = 0; i < issues.length && codes.length < cap; i++) {
      const issue = issues[i];
      if (issue && typeof issue === "object" && typeof issue.code === "string") {
        const code = safeString(issue.code, 40).trim();
        if (code) codes.push(code);
      }
    }
    if (codes.length === 0) return "";
    const more = issues.length - codes.length;
    return more > 0
      ? codes.join(", ") + " (+" + more + " more)"
      : codes.join(", ");
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

      case "dewey:brief": {
        const tone     = safeString(e.suggestedTone, 40).trim();
        const prefsN   = Array.isArray(e.relevantPreferences) ? e.relevantPreferences.length : 0;
        const ctxN     = Array.isArray(e.relevantContext)     ? e.relevantContext.length     : 0;
        const summary  = tone ? "Loaded context · tone: " + tone : "Loaded context";
        const detail   = (prefsN > 0 || ctxN > 0)
          ? safeCount(prefsN) + " " + pluralize(prefsN, "preference") + ", "
            + safeCount(ctxN) + " " + pluralize(ctxN, "context item")
          : "";
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_DEWEY,
          stage:     "context",
          status:    STATUS_OK,
          summary:   summary,
          details:   detail,
        }));
      }

      case "miranda:checkpoint": {
        const gate    = safeStage(e.gate);
        const allowed = !!e.allowed;
        let summary;
        if (allowed) {
          summary = gate === "after_qc"
            ? gate + " checkpoint recorded"
            : gate + " passed";
        } else {
          summary = gate + " blocked";
        }
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_MIRANDA,
          stage:     gate,
          status:    allowed ? STATUS_OK : STATUS_BLOCKED,
          summary:   summary,
          details:   e.reason ? "Reason: " + safeString(e.reason, 160) : "",
        }));
      }

      case "maestro:start":
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_BRAIN,
          stage:     e.isRepair ? "repair" : "planning",
          status:    STATUS_RUNNING,
          summary:   e.isRepair
            ? "Starting repair pass " + safeCount(e.attempt)
            : "Planning route",
        }));

      case "maestro:done": {
        const hasOutput = !!e.hasOutput;
        const summary   = e.isRepair
          ? (hasOutput
              ? "Repair pass " + safeCount(e.attempt) + " complete"
              : "Repair pass " + safeCount(e.attempt) + " produced no output")
          : (hasOutput ? "Synthesis complete" : "Synthesis incomplete");
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_MAESTRO,
          stage:     "synthesis",
          status:    hasOutput ? STATUS_OK : STATUS_WARN,
          summary:   summary,
        }));
      }

      case "maestro:agent_start": {
        const role = safeRole(e.role);
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + role + ")",
          stage:     "running",
          status:    STATUS_RUNNING,
          summary:   role + " started",
        }));
      }

      case "maestro:agent_done": {
        const role    = safeRole(e.role);
        const ok      = e.stoppedBecause === "done";
        const isError = e.stoppedBecause === "error";
        const iters   = safeCount(e.iterations);
        let summary;
        if (ok) {
          summary = iters > 0
            ? role + " completed · " + iters + " " + pluralize(iters, "iteration")
            : role + " completed";
        } else {
          summary = role + " " + humanizeStopReason(e.stoppedBecause);
        }
        const detail = (e.loopEvidence && typeof e.loopEvidence.occurrences === "number")
          ? "Loop: " + safeCount(e.loopEvidence.occurrences) + " repeated calls"
          : "";
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + role + ")",
          stage:     "complete",
          status:    ok ? STATUS_OK : (isError ? STATUS_FAIL : STATUS_WARN),
          summary:   summary,
          details:   detail,
        }));
      }

      case "subagent:spawned": {
        const role = safeRole(e.role);
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + role + ")",
          stage:     "spawn",
          status:    STATUS_RUNNING,
          summary:   role + " started",
        }));
      }

      case "subagent:done": {
        const role = safeRole(e.role);
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + role + ")",
          stage:     "complete",
          status:    e.ok ? STATUS_OK : STATUS_WARN,
          summary:   e.ok ? role + " completed" : role + " finished without output",
        }));
      }

      case "subagent:failed": {
        const role = safeRole(e.role);
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_WORKER + " (" + role + ")",
          stage:     "failed",
          status:    STATUS_FAIL,
          summary:   role + " failed",
          details:   e.error ? safeString(e.error, 160) : "",
        }));
      }

      case "qc:result": {
        const verdict = safeVerdict(e.verdict);
        const status  = verdict === "PASS" ? STATUS_OK
                      : verdict === "WARN" ? STATUS_WARN
                      :                       STATUS_FAIL;
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_PAPPY,
          stage:     "qc",
          status:    status,
          summary:   formatIssueSummary(verdict, e.issueCount),
          // Issue codes are constant identifiers (e.g. MISSING_TESTS) — safe.
          // Issue descriptions are NOT included; they can echo model output.
          details:   verdict === "PASS" ? "" : formatIssueCodes(e.issues, 3),
        }));
      }

      case "repair:start": {
        const pass    = safeCount(e.pass);
        const maxRaw  = Number(e.maxPasses);
        const hasMax  = isFinite(maxRaw) && maxRaw > 0;
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_PAPPY,
          stage:     "repair",
          status:    STATUS_RUNNING,
          summary:   hasMax
            ? "Starting repair pass " + pass + " of " + safeCount(maxRaw)
            : "Starting repair pass " + pass,
        }));
      }

      case "task:done": {
        const status = e.status === "SUCCESS" ? STATUS_OK
                     : e.status === "WARN"    ? STATUS_WARN
                     :                           STATUS_FAIL;
        const summary = e.status === "SUCCESS"
          ? "Preparing final response"
          : e.status === "WARN"
            ? "Preparing final response · with warnings"
            : "Run failed";
        return makeRow(Object.assign({}, base, {
          component: COMPONENT_BENSON,
          stage:     "response",
          status:    status,
          summary:   summary,
        }));
      }

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
   * Decide whether a finished panel should auto-remove now (true) or wait
   * for the user (false). Pure / testable. The DOM controller calls this
   * before scheduling the sticky removal timer.
   */
  function shouldAutoRemove(state) {
    if (!state || !state.finished) return false;
    if (state.expanded) return false;
    return true;
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

    const seenKeys      = new Set();
    let timerHandle     = null;
    let stickyTimer     = null;
    let stickyDelayMs   = 0;
    let pendingRemoval  = false;
    let finished        = false;
    let expanded        = false;
    let role            = null;

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
      +   '<button class="ltp-close" type="button" aria-label="Dismiss pipeline trace" hidden>✕</button>'
      + '</div>'
      + '<div class="ltp-detail" data-detail role="region" aria-label="Pipeline progress" hidden>'
      +   '<div class="ltp-rows" data-rows></div>'
      + '</div>';

    const headerEl  = wrap.querySelector(".ltp-header");
    const roleEl    = wrap.querySelector("[data-role]");
    const currentEl = wrap.querySelector("[data-current]");
    const elapsedEl = wrap.querySelector("[data-elapsed]");
    const toggleBtn = wrap.querySelector(".ltp-toggle");
    const closeBtn  = wrap.querySelector(".ltp-close");
    const detailEl  = wrap.querySelector("[data-detail]");
    const rowsEl    = wrap.querySelector("[data-rows]");

    function tickElapsed() {
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      elapsedEl.textContent = sec + "s";
    }

    function clearStickyTimer() {
      if (stickyTimer != null) {
        clearTimeout(stickyTimer);
        stickyTimer = null;
      }
    }

    function armStickyTimer() {
      clearStickyTimer();
      if (!shouldAutoRemove({ finished: finished, expanded: expanded })) return;
      stickyTimer = setTimeout(function () {
        stickyTimer = null;
        destroy();
      }, stickyDelayMs);
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
      // Expanding a finished panel cancels its sticky removal so the user
      // can read the trace at their own pace; collapsing rearms it.
      if (pendingRemoval) {
        if (expanded) clearStickyTimer();
        else armStickyTimer();
      }
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
      // Reveal the explicit dismiss control alongside the existing toggle.
      if (closeBtn) closeBtn.hidden = false;
    }

    /**
     * Schedule the panel to remove itself after `delayMs`. If the user has
     * the panel expanded the timer is held; collapsing reschedules it.
     * Calling this before finish() is a no-op.
     */
    function scheduleRemoval(delayMs) {
      if (!finished) return;
      stickyDelayMs = Math.max(0, Number(delayMs) || 0);
      pendingRemoval = true;
      armStickyTimer();
    }

    function destroy() {
      clearStickyTimer();
      finish();
      pendingRemoval = false;
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
    if (closeBtn) {
      closeBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        destroy();
      });
    }

    messagesEl.appendChild(wrap);
    start();

    return {
      element:           wrap,
      pushRow:           pushRow,
      setRole:           setRole,
      finish:            finish,
      scheduleRemoval:   scheduleRemoval,
      destroy:           destroy,
      isFinished:        function () { return finished; },
      isExpanded:        function () { return expanded; },
    };
  }

  const api = {
    mapOrcaEventToTraceRow: mapOrcaEventToTraceRow,
    safeString:             safeString,
    safeCount:              safeCount,
    safeRole:               safeRole,
    safeVerdict:            safeVerdict,
    safeStage:              safeStage,
    formatDuration:         formatDuration,
    formatIssueSummary:     formatIssueSummary,
    statusIcon:             statusIcon,
    shouldAutoRemove:       shouldAutoRemove,
    createLiveTracePanel:   createLiveTracePanel,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.PipelineTrace = api;
})(typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : null));
