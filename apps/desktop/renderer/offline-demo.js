/**
 * offline-demo.js — Summit Offline Demo: a deterministic, prerecorded walk
 * through Orca's workflow for booths with no internet and no API budget.
 *
 * NOTHING here runs a model or touches the network. The runner is given only
 * display callbacks; it has no access to window.orca (IPC), fetch, storage, or
 * any provider code. Steps are OrcaEvent-shaped where possible so the existing
 * Demo Mode tracker, status strip, and trace panel render them unchanged, plus
 * a few "card" steps for the simulated tool activity.
 *
 * The same scenario produces the same steps every time — no randomness.
 * Every visible surface is labelled as simulated by the caller.
 *
 * Loaded as a plain <script> in the renderer (window.OfflineDemo) and via
 * require() in vitest.
 */
(function (root) {
  "use strict";

  const OFFLINE_LABEL = "OFFLINE DEMO — Simulated AI responses";
  const FREEFORM_REFUSAL = "Offline Demo uses prepared scenarios. Switch to Live AI to run a custom request.";
  const TASK_ID = "offline-demo";

  // Test names, in order, from the bundled demo project
  // (apps/desktop/demo/summit-app/test/bookings.test.js — a test keeps them in sync).
  const DEMO_TEST_NAMES = [
    "parses 24-hour times",
    "rejects malformed times",
    "books a free slot",
    "rejects a booking that overlaps an existing meeting",
    "rejects a booking inside an existing meeting",
    "the same time in a different room is fine",
    "a meeting can start exactly when the previous one ends (ISSUE.md)",
    "rejects bookings that end before they start",
  ];
  const ISSUE_TEST = DEMO_TEST_NAMES[6];

  // The real line in apps/desktop/demo/summit-app/src/bookings.js (a test keeps it in sync).
  const BUGGY_LINE = "return first.start <= second.end && second.start <= first.end;";
  const FIXED_LINE = "return first.start < second.end && second.start < first.end;";

  function testOutput(names, failing) {
    const lines = names.map((n) => (n === failing ? "✖ " : "✔ ") + n);
    const fail = failing && names.includes(failing) ? 1 : 0;
    lines.push(`ℹ tests ${names.length}`, `ℹ pass ${names.length - fail}`, `ℹ fail ${fail}`);
    return lines.join("\n");
  }

  const N = (milestone, message) => ({ milestone, message });

  const CRITERIA = [
    "The reported back-to-back booking (09:00–10:00 then 10:00–11:00) is allowed",
    "Root cause is fixed with the smallest change in src/bookings.js",
    "The test that reproduces ISSUE.md passes",
    "Existing booking rules and tests are unchanged",
  ];

  /**
   * Find & Fix a Bug. withRepair adds a round where Pappy rejects the first
   * submission because its test evidence does not cover the reported case.
   * Roughly 40 s (clean) / 55 s (with repair).
   */
  function buildFindAndFixScenario(opts) {
    const withRepair = !!(opts && opts.withRepair);
    const steps = [];
    const ev = (delayMs, event) => steps.push({ delayMs, event: Object.assign({ taskId: TASK_ID }, event) });
    const card = (delayMs, c) => steps.push({ delayMs, card: c });

    // ── Request + planning ────────────────────────────────────────────────
    ev(300, { type: "task:start", intent: "Fix the back-to-back booking bug", narratorProgress: N("received", "I've got your request. I'm outlining the work.") });
    ev(1000, { type: "maestro:start", attempt: 0, isRepair: false, narratorProgress: N("planning", "I'm planning the approach.") });
    card(1500, {
      kind: "plan", role: "Brain", title: "Brain — plan",
      items: [
        "Read the issue report (ISSUE.md)",
        "Inspect the booking overlap logic in src/bookings.js",
        "Reproduce the failure with the existing tests",
        "Make the smallest safe correction",
        "Run the relevant tests",
        "Submit the result for independent verification",
      ],
    });

    // ── Worker investigation ──────────────────────────────────────────────
    ev(2500, { type: "maestro:agent_start", role: "debugger", doneCriteria: CRITERIA, narratorProgress: N("work_started", "Work is underway.") });
    card(1500, { kind: "tool", role: "Worker", tool: "read_file", target: "ISSUE.md",
      detail: "Users can't book the Hangar 10:00–11:00 after a 09:00–10:00 Standup." });
    card(2000, { kind: "tool", role: "Worker", tool: "read_file", target: "src/bookings.js",
      detail: "overlaps(a, b) compares the two intervals with <=." });
    card(2500, { kind: "finding", role: "Worker", title: "Root cause",
      detail: "Bookings are half-open intervals [start, end), but overlaps() uses inclusive comparisons, so a meeting that starts exactly when another ends is treated as a conflict.",
      code: BUGGY_LINE });
    card(2500, { kind: "tests", role: "Worker", command: "npm test", label: "Reproduce the failure",
      output: testOutput(DEMO_TEST_NAMES, ISSUE_TEST), passed: false });

    // ── Worker repair ─────────────────────────────────────────────────────
    card(3500, { kind: "diff", role: "Worker", tool: "write_file", target: "src/bookings.js — overlaps()",
      removed: BUGGY_LINE, added: FIXED_LINE });

    if (withRepair) {
      // First submission: only re-runs the overlap tests, not the reported case.
      const subset = DEMO_TEST_NAMES.filter((n) => /overlap/.test(n));
      card(2000, { kind: "tests", role: "Worker", command: 'npm test -- --test-name-pattern="overlap"', label: "Check the overlap tests",
        output: testOutput(subset, null), passed: true });
    } else {
      card(3000, { kind: "tests", role: "Worker", command: "npm test", label: "Run the test suite",
        output: testOutput(DEMO_TEST_NAMES, null), passed: true });
    }
    ev(1500, { type: "maestro:agent_done", role: "debugger", stoppedBecause: "done", iterations: 6, narratorProgress: N("step_completed", "Work step 1 is complete.") });
    ev(500, { type: "maestro:done", attempt: 0, isRepair: false, hasOutput: true, narratorProgress: N("checking", "The main work is complete. I'm checking the result.") });

    // ── Pappy verification ────────────────────────────────────────────────
    const pappyChecks = (id, attempt, evidenceOk) => {
      card(800, { kind: "pappy", id, title: attempt ? "Pappy — re-verification" : "Pappy — independent verification" });
      const checks = [
        ["Reported issue", "Back-to-back bookings in the same room must be allowed.", true],
        ["Implemented change", "overlaps() now treats intervals as half-open: < instead of <=.", true],
        ["Expected behavior", "09:00–10:00 followed by 10:00–11:00 books successfully; real overlaps are still rejected.", true],
        ["Test evidence", evidenceOk
          ? `The ISSUE.md test passes and all ${DEMO_TEST_NAMES.length} tests pass.`
          : "The implementation appears correct, but the reported boundary condition is not directly covered by the submitted test evidence.", evidenceOk],
        ["Unrelated behavior", "No other functions or tests were changed.", true],
      ];
      for (const [name, detail, ok] of checks) card(1800, { kind: "pappy-check", id, name, detail, ok });
    };

    if (withRepair) {
      pappyChecks("pappy-1", 0, false);
      ev(1100, { type: "qc:result", attempt: 0, isRepair: false, verdict: "FAIL", issueCount: 1,
        issues: [{ severity: "high", code: "MISSING_EVIDENCE", description: "Reported boundary case is not covered by the submitted test evidence." }],
        narratorProgress: N("check_failed", "The checks found something to fix.") });
      ev(1600, { type: "repair:start", pass: 1, maxPasses: 2, narratorProgress: N("repairing", "I'm correcting the issues that were found.") });
      ev(500, { type: "maestro:start", attempt: 1, isRepair: true });
      card(1800, { kind: "tests", role: "Worker", command: "npm test", label: "Repair: run the full suite, including the ISSUE.md test",
        output: testOutput(DEMO_TEST_NAMES, null), passed: true });
      ev(1200, { type: "maestro:done", attempt: 1, isRepair: true, hasOutput: true, narratorProgress: N("checking", "The repair is done. I'm checking the result again.") });
      pappyChecks("pappy-2", 1, true);
      ev(1100, { type: "qc:result", attempt: 1, isRepair: true, verdict: "PASS", issueCount: 0, issues: [],
        narratorProgress: N("check_passed", "The result passed its checks.") });
    } else {
      pappyChecks("pappy-1", 0, true);
      ev(1100, { type: "qc:result", attempt: 0, isRepair: false, verdict: "PASS", issueCount: 0, issues: [],
        narratorProgress: N("check_passed", "The result passed its checks.") });
    }

    ev(1000, { type: "task:done", status: "SUCCESS", narratorProgress: N("finalizing", "Everything is complete. I'm preparing the final response.") });

    steps.push({
      delayMs: 800,
      finish: {
        answer:
          "**Root cause:** `overlaps()` in `src/bookings.js` compared intervals with `<=`, so a meeting starting exactly when another ended counted as a conflict.\n\n" +
          "**Fix:** bookings are half-open intervals, so both comparisons now use `<`:\n\n" +
          "```js\n" + FIXED_LINE + "\n```\n\n" +
          `**Evidence:** all ${DEMO_TEST_NAMES.length} tests pass, including the test that reproduces ISSUE.md. No other behavior changed.`,
        summary: {
          type: "pipeline:summary",
          taskId: TASK_ID,
          role: "debugger",
          verdict: "PASS",
          confidence: 0.95,
          issueCount: 0,
          issues: [],
          acceptanceCriteria: CRITERIA.map((text, i) => ({ id: `ac${i + 1}`, text, required: true, met: true })),
          durationMs: 0, // set below to the scenario length
          repairPasses: withRepair ? 1 : 0,
        },
      },
    });
    steps[steps.length - 1].finish.summary.durationMs = totalDurationMs(steps);
    return steps;
  }

  function totalDurationMs(steps) {
    return steps.reduce((sum, s) => sum + (s.delayMs || 0), 0);
  }

  /**
   * Plays a scenario. Only the given callbacks are ever called; stop()
   * cancels the pending timer and any step from a stopped run is dropped.
   */
  function createOfflineRunner(opts) {
    const onEvent = opts.onEvent || function () {};
    const onCard = opts.onCard || function () {};
    const onFinish = opts.onFinish || function () {};
    const setT = opts.setTimeout || setTimeout;
    const clearT = opts.clearTimeout || clearTimeout;
    let generation = 0;
    let timer = null;
    let running = false;

    function stop() {
      generation++;
      running = false;
      if (timer) clearT(timer);
      timer = null;
    }

    function start(steps) {
      stop();
      const gen = generation;
      running = true;
      let i = 0;
      const next = () => {
        if (gen !== generation || i >= steps.length) return;
        const step = steps[i];
        timer = setT(() => {
          timer = null;
          if (gen !== generation) return;
          i++;
          if (step.event) onEvent(step.event);
          else if (step.card) onCard(step.card);
          else if (step.finish) {
            running = false;
            onFinish(step.finish);
            return;
          }
          next();
        }, step.delayMs || 0);
      };
      next();
    }

    return { start, stop, isRunning: () => running };
  }

  const api = {
    OFFLINE_LABEL,
    FREEFORM_REFUSAL,
    TASK_ID,
    DEMO_TEST_NAMES,
    BUGGY_LINE,
    FIXED_LINE,
    buildFindAndFixScenario,
    totalDurationMs,
    createOfflineRunner,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OfflineDemo = api;
  }
})(typeof window !== "undefined" ? window : null);
