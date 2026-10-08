/**
 * demo-mode.js — Summit/exhibit Demo Mode presentation helpers.
 *
 * Everything here is driven by real OrcaEvents forwarded from the main
 * process. Nothing advances on a timer: the only timer is the stall
 * watchdog, which can raise a "no progress" notice but never changes the
 * pipeline stage or claims an outcome.
 *
 * "Verified" is shown only after Pappy's qc:result is PASS (or WARN —
 * accepted with notes) and the task has finished.
 *
 * Loaded as a plain <script> in the renderer (window.DemoMode) and via
 * require() in vitest.
 */
(function (root) {
  "use strict";

  const RECORDED_DEMO_LABEL = "RECORDED DEMO";
  // Below the 60s per-call provider timeout: each timed-out call is retried and
  // emits events, which would keep resetting a longer watchdog forever.
  const STALL_TIMEOUT_MS = 45_000;
  // Booth-only ceiling for one live run. When it passes, the presenter's Stop
  // path is used to end the run; Orca's own runtime timeouts are unchanged.
  const RUN_LIMIT_MS = 240_000;

  // Wording matters: Orca treats a task that says "npm test" / "run the tests"
  // as command-only (no file writes), and test files are write-protected in the
  // desktop app. The presets therefore ask for source changes and a run of
  // "the project's test suite", and never ask for new or edited test files.
  const DEMO_PRESETS = [
    {
      id: "fix-bug",
      primary: true,
      title: "Find & Fix a Bug",
      description:
        "Give Orca a small broken app. Watch Brain plan the task, a worker investigate and repair it, and Pappy independently verify the result.",
      prompt:
        "Users reported a bug in this meeting-room booking app (see ISSUE.md). " +
        "Investigate the repository, identify the root cause, and implement the smallest correct fix in the source code. " +
        "Then run the project's test suite and verify that the reported problem is actually resolved. " +
        "Do not change unrelated behavior or modify the existing tests.",
    },
    {
      id: "add-feature",
      primary: false,
      title: "Add a Feature",
      description:
        "Give Orca a clearly defined feature request and watch it plan, implement, test, and verify the change.",
      prompt:
        "Add a `findFreeSlots(schedule, room, dayStart, dayEnd, minMinutes)` function to src/bookings.js. " +
        "It returns the free time windows for that room between dayStart and dayEnd (HH:MM strings) as " +
        "`{ start, end }` objects in time order, including only windows at least minMinutes long. " +
        "Then run the project's test suite to confirm existing behavior still works. " +
        "Do not change the behavior of existing functions or modify the existing tests.",
    },
    {
      id: "investigate",
      primary: false,
      title: "Investigate a Problem",
      description:
        "Give Orca an open-ended technical question where Brain must break the problem down before workers act.",
      prompt:
        "Before changing anything, investigate this booking app. Explain how a new booking is checked for " +
        "conflicts, list any edge cases the current rules or tests get wrong, and recommend what to fix first " +
        "and why. Do not modify any files.",
    },
  ];

  function findPreset(id) {
    return DEMO_PRESETS.find((p) => p.id === id) || null;
  }

  /** Demo Mode forces the pipeline on for display without touching the saved preference. */
  function resolveShowPipeline(savedShowPipeline, demoMode) {
    if (demoMode) return true;
    return savedShowPipeline !== false;
  }

  // ── Stage tracking ────────────────────────────────────────────────────────

  const STAGES = ["plan", "build", "verify", "done"];

  function initialState() {
    return {
      stage: "idle",          // idle | plan | build | verify | done
      verification: "pending", // pending | verifying | passed | warned | failed | repairing | reverifying
      lastVerdict: null,      // PASS | WARN | FAIL — only from Pappy's qc:result
      taskStatus: null,       // SUCCESS | WARN | FAIL — from task:done
      repairPass: 0,
      maxRepairPasses: 0,
      workerError: false,     // a worker in the latest build pass stopped on an error
      planFallback: false,    // Brain could not plan; a deterministic route ran instead
      blockingIssues: 0,      // HIGH/CRITICAL issues in Pappy's latest result
      timeline: [],           // Pappy story: [{ kind, label }]
    };
  }

  function pushTimeline(state, kind, label) {
    const last = state.timeline[state.timeline.length - 1];
    if (last && last.kind === kind && last.label === label) return;
    state.timeline.push({ kind, label });
  }

  function createDemoStageTracker() {
    let state = initialState();

    function consume(e) {
      if (!e || typeof e.type !== "string") return state;
      switch (e.type) {
        case "task:start":
          state = initialState();
          state.stage = "plan";
          break;
        case "maestro:start":
          if (!e.isRepair && state.stage === "idle") state.stage = "plan";
          break;
        case "maestro:agent_start":
        case "subagent:spawned":
          if (state.stage === "plan" || state.stage === "idle") state.stage = "build";
          break;
        case "maestro:agent_done":
          if (e.stoppedBecause === "error") state.workerError = true;
          break;
        case "subagent:failed":
          state.workerError = true;
          break;
        case "brain:fallback":
          state.planFallback = true;
          break;
        case "maestro:done":
          if (state.stage === "done") break;
          state.stage = "verify";
          state.verification = state.repairPass > 0 ? "reverifying" : "verifying";
          pushTimeline(
            state,
            state.verification,
            state.repairPass > 0 ? "Pappy re-verifying the repair" : "Pappy verifying the work",
          );
          break;
        case "qc:result": {
          const verdict = e.verdict === "PASS" || e.verdict === "WARN" || e.verdict === "FAIL" ? e.verdict : null;
          if (!verdict) break;
          state.stage = "verify";
          state.lastVerdict = verdict;
          state.blockingIssues = Array.isArray(e.issues)
            ? e.issues.filter((i) => i && (i.severity === "HIGH" || i.severity === "CRITICAL")).length
            : 0;
          if (verdict === "PASS") {
            state.verification = "passed";
            pushTimeline(state, "passed", "Verification passed");
          } else if (verdict === "WARN") {
            state.verification = "warned";
            pushTimeline(state, "warned", "Verification passed with notes");
          } else {
            state.verification = "failed";
            const n = Number(e.issueCount) || 0;
            pushTimeline(state, "failed", `Pappy rejected the result${n ? ` (${n} issue${n === 1 ? "" : "s"})` : ""}`);
          }
          break;
        }
        case "repair:start":
          state.stage = "build";
          state.verification = "repairing";
          state.workerError = false; // judged afresh for this repair pass
          state.repairPass = Number(e.pass) || state.repairPass + 1;
          state.maxRepairPasses = Number(e.maxPasses) || state.maxRepairPasses;
          pushTimeline(state, "repairing", `Repair pass ${state.repairPass} started`);
          break;
        case "task:done":
          state.stage = "done";
          state.taskStatus = e.status === "SUCCESS" || e.status === "WARN" || e.status === "FAIL" ? e.status : null;
          break;
        default:
          break;
      }
      return state;
    }

    return {
      consume,
      getState: () => state,
      reset: () => { state = initialState(); return state; },
    };
  }

  /** True only when Pappy accepted the result and the run finished. */
  function isVerified(state) {
    return !!state
      && state.stage === "done"
      && (state.lastVerdict === "PASS" || state.lastVerdict === "WARN")
      // Never "Verified" while a critical acceptance requirement is unmet.
      && !state.blockingIssues
      && state.taskStatus !== "FAIL";
  }

  // ── Outcome classification ────────────────────────────────────────────────

  const PROVIDER_ERROR_PATTERN = new RegExp([
    "fetch failed", "network", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN",
    "socket hang up", "timed? ?out", "timeout", "\\b(?:401|402|403|408|429|500|502|503|504)\\b",
    "rate.?limit", "unauthori[sz]ed", "forbidden", "api key", "invalid.{0,20}key", "quota",
    "insufficient (?:credits|balance|funds)", "overloaded", "service unavailable", "bad gateway",
    "provider", "all models failed", "no models? (?:available|configured)", "not initiali[sz]ed",
  ].join("|"), "i");

  function isProviderError(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    return PROVIDER_ERROR_PATTERN.test(text);
  }

  /**
   * Final outcome for the demo verdict card.
   *   verified / verified_with_warnings — Pappy accepted the result
   *   not_verified   — Pappy rejected it and repair did not fix it
   *   provider_error — the AI provider failed (never shown as a Pappy failure)
   *   stopped        — presenter pressed Stop
   *   timed_out      — Demo Mode stopped a run that passed RUN_LIMIT_MS
   *   error          — Orca could not complete for another reason
   *   completed_unverified — finished without any Pappy verdict
   */
  function classifyRunOutcome(input) {
    const result = (input && input.result) || {};
    const state = (input && input.state) || initialState();
    const summary = (input && input.summary) || null;
    const error = typeof result.error === "string" ? result.error : "";

    if (!result.ok) {
      if (input && input.timedOut) return "timed_out";
      if (/^(Stopped|Locked)\.?$/i.test(error.trim())) return "stopped";
      if (isProviderError(error)) return "provider_error";
      return "error";
    }

    const verdict = state.lastVerdict || (summary && summary.verdict) || null;
    const summaryError = summary && typeof summary.errorMessage === "string" ? summary.errorMessage : "";
    // A worker that died on a provider call produces nothing for Pappy to pass;
    // report the provider, not a verification failure.
    if (verdict !== "PASS" && verdict !== "WARN" && isProviderError(summaryError)) return "provider_error";
    if ((verdict === "PASS" || verdict === "WARN") && state.blockingIssues > 0) return "not_verified";
    if (verdict === "PASS") return "verified";
    if (verdict === "WARN") return "verified_with_warnings";
    if (verdict === "FAIL") return "not_verified";
    return "completed_unverified";
  }

  const OUTCOME_COPY = {
    verified:               { tone: "pass", title: "Verified by Pappy", detail: "The result was independently checked and accepted." },
    verified_with_warnings: { tone: "pass", title: "Verified by Pappy — with notes", detail: "The result was accepted. Pappy recorded minor notes." },
    not_verified:           { tone: "fail", title: "Not verified", detail: "Pappy rejected the result and the repair passes did not fix it. Orca will not present it as done." },
    provider_error:         { tone: "provider", title: "AI provider unavailable", detail: "The model provider did not respond or returned an error. This is not a verification result." },
    timed_out:              { tone: "provider", title: "Run took too long", detail: "The run was stopped after the demo time limit. Nothing was verified — this is not a verification result." },
    stopped:                { tone: "neutral", title: "Stopped", detail: "The run was stopped before it finished." },
    error:                  { tone: "provider", title: "Run could not complete", detail: "Orca stopped before producing a result. This is not a verification result." },
    completed_unverified:   { tone: "neutral", title: "Finished without verification", detail: "No verification verdict was recorded for this run." },
  };

  function outcomeCopy(outcome) {
    return OUTCOME_COPY[outcome] || OUTCOME_COPY.error;
  }

  /** Outcomes where the run was cut short rather than judged. */
  const HALTED_OUTCOMES = new Set(["provider_error", "timed_out", "stopped", "error"]);

  /** Step states for PLAN → BUILD → VERIFY → DONE. */
  function stripSteps(state, outcome) {
    const idx = STAGES.indexOf(state.stage);
    const accepted = !outcome || outcome === "verified" || outcome === "verified_with_warnings";
    return STAGES.map((stage, i) => {
      // pending | active | complete | failed | halted | unverified | fallback
      let status = idx > i ? "complete" : idx === i ? "active" : "pending";

      if (stage === "verify" && idx >= i) {
        // Ticked only when Pappy's latest word is an acceptance. A rejection
        // followed by a re-check that never reported stays a rejection.
        const acceptedVerdict = state.verification === "passed" || state.verification === "warned";
        if (acceptedVerdict) status = "complete";
        else if (state.verification === "failed") status = "failed";
        else if (idx > i) status = state.lastVerdict === "FAIL" ? "failed" : "unverified";
      }
      if (stage === "done" && idx === i) {
        if (isVerified(state) && accepted) status = "complete";
        else if (outcome && HALTED_OUTCOMES.has(outcome)) status = "halted";
        else status = state.lastVerdict === "FAIL" ? "failed" : "unverified";
      }
      // Moving past BUILD only means the stage ended, not that the work
      // succeeded: a worker that stopped on an error (e.g. a provider 400)
      // produced nothing, so BUILD is shown as failed rather than complete.
      if (stage === "build" && idx > i && state.workerError) status = "failed";
      // PLAN ran, but Brain did not produce the plan: show the fallback.
      if (stage === "plan" && idx > i && state.planFallback) status = "fallback";
      // A run cut short (provider error, stop) freezes on the step it reached.
      if (!accepted && idx === i && status === "active") status = "halted";
      return { stage, status };
    });
  }

  const STAGE_LABELS = { plan: "PLAN", build: "BUILD", verify: "VERIFY", done: "DONE" };

  /** The big one-line headline under the strip. */
  function headline(state, outcome) {
    if (outcome) return outcomeCopy(outcome).title;
    switch (state.stage) {
      case "plan":  return "Brain is planning the job";
      case "build":
        return state.verification === "repairing"
          ? `Repairing — pass ${state.repairPass}${state.maxRepairPasses ? ` of ${state.maxRepairPasses}` : ""}`
          : "Workers are doing the job";
      case "verify":
        if (state.verification === "failed") return "Pappy rejected the result";
        if (state.verification === "passed" || state.verification === "warned") return "Verification passed";
        return state.verification === "reverifying" ? "Pappy is re-verifying the repair" : "Pappy is verifying the work";
      case "done":  return isVerified(state) ? "Verified" : "Finishing";
      default:      return "Ready";
    }
  }

  // ── Stall watchdog ────────────────────────────────────────────────────────

  /**
   * Raises onStall when no pipeline activity arrives for timeoutMs. It only
   * reports a stall — it never ends the run or reports an outcome.
   */
  function createStallWatchdog(opts) {
    const timeoutMs = (opts && opts.timeoutMs) || STALL_TIMEOUT_MS;
    const onStall = (opts && opts.onStall) || function () {};
    const onRecover = (opts && opts.onRecover) || function () {};
    const setT = (opts && opts.setTimeout) || setTimeout;
    const clearT = (opts && opts.clearTimeout) || clearTimeout;
    let timer = null;
    let stalled = false;
    let running = false;

    function arm() {
      if (timer) clearT(timer);
      timer = setT(function () {
        timer = null;
        if (!running) return;
        stalled = true;
        onStall();
      }, timeoutMs);
    }

    return {
      start() { running = true; stalled = false; arm(); },
      heartbeat() {
        if (!running) return;
        if (stalled) { stalled = false; onRecover(); }
        arm();
      },
      /** Waiting on the presenter (e.g. tool approval) is not a provider stall. */
      pause() { if (timer) clearT(timer); timer = null; },
      stop() {
        running = false;
        if (timer) clearT(timer);
        timer = null;
        if (stalled) { stalled = false; onRecover(); }
      },
      isStalled: () => stalled,
      isRunning: () => running,
    };
  }

  const api = {
    RECORDED_DEMO_LABEL,
    STALL_TIMEOUT_MS,
    RUN_LIMIT_MS,
    DEMO_PRESETS,
    STAGE_LABELS,
    findPreset,
    resolveShowPipeline,
    createDemoStageTracker,
    isVerified,
    isProviderError,
    classifyRunOutcome,
    outcomeCopy,
    stripSteps,
    headline,
    createStallWatchdog,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DemoMode = api;
  }
})(typeof window !== "undefined" ? window : null);
