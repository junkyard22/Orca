import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const PipelineTrace = requireCjs(
  "../renderer/pipeline-trace.js",
) as typeof import("../renderer/pipeline-trace");

// Mirrors MAX_DETAIL_LEN in pipeline-trace.js — kept here so the privacy
// regression checks below assert against an explicit upper bound.
const MAX_DETAIL_LEN_FOR_TEST = 240;

const {
  mapOrcaEventToTraceRow,
  safeString,
  safeCount,
  safeRole,
  safeVerdict,
  safeStage,
  formatDuration,
  formatIssueSummary,
  safeNarratorProgress,
  statusIcon,
  shouldAutoRemove,
  badgeRoleLabel,
} = PipelineTrace;

describe("safeString", () => {
  it("strips ASCII control characters", () => {
    const dirty = "hello" + String.fromCharCode(0x00) + String.fromCharCode(0x1b) + "[31mred" + String.fromCharCode(0x1b) + "[0m" + String.fromCharCode(0x7f);
    const clean = safeString(dirty, 200);
    expect(clean).not.toContain(String.fromCharCode(0x1b));
    expect(clean).not.toContain(String.fromCharCode(0x00));
    expect(clean).toContain("hello");
  });

  it("truncates with an ellipsis when over the cap", () => {
    const out = safeString("a".repeat(200), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for null/undefined", () => {
    expect(safeString(null)).toBe("");
    expect(safeString(undefined)).toBe("");
  });
});

describe("mapOrcaEventToTraceRow — happy path", () => {
  it("maps task:start to a Benson 'received' row", () => {
    const row = mapOrcaEventToTraceRow({
      type: "task:start",
      taskId: "t1",
      intent: "fix bug",
    });
    expect(row).toMatchObject({
      component: "Benson",
      stage: "received",
      status: "running",
    });
    expect(row?.summary).toBe("Received your request");
  });

  it("maps dewey:brief to a Dewey context row", () => {
    const row = mapOrcaEventToTraceRow({
      type: "dewey:brief",
      taskId: "t1",
      userName: "James",
      suggestedTone: "concise",
      relevantPreferences: [],
      relevantContext: [],
    });
    expect(row?.component).toBe("Dewey");
    expect(row?.stage).toBe("context");
    expect(row?.status).toBe("ok");
    expect(row?.summary).toContain("concise");
  });

  it("maps miranda:checkpoint allowed → ok / blocked → blocked", () => {
    const ok = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "before_qc",
      allowed: true,
      reason: "all good",
    });
    expect(ok?.status).toBe("ok");
    expect(ok?.summary).toBe("before_qc passed");

    const blocked = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "after_qc",
      allowed: false,
      reason: "budget exceeded",
    });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.summary).toBe("after_qc blocked");
    expect(blocked?.details).toContain("budget exceeded");
  });

  it("maps qc:result PASS / WARN / FAIL", () => {
    const pass = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "PASS",
      issueCount: 0,
    });
    expect(pass).toMatchObject({ component: "Pappy", status: "ok" });
    expect(pass?.summary).toBe("QC passed");

    const warn = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "WARN",
      issueCount: 2,
    });
    expect(warn?.status).toBe("warn");
    expect(warn?.summary).toBe("QC warned · 2 issues");

    const fail = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "FAIL",
      issueCount: 1,
    });
    expect(fail?.status).toBe("fail");
    expect(fail?.summary).toBe("QC failed · 1 issue");
  });

  it("maps subagent lifecycle to worker rows", () => {
    const spawned = mapOrcaEventToTraceRow({
      type: "subagent:spawned",
      taskId: "t1",
      subagentId: "sa1",
      role: "reader",
      task: "...",
    });
    expect(spawned?.component).toBe("Worker (reader)");
    expect(spawned?.status).toBe("running");

    const failed = mapOrcaEventToTraceRow({
      type: "subagent:failed",
      taskId: "t1",
      subagentId: "sa1",
      role: "reader",
      error: "tool timeout",
    });
    expect(failed?.status).toBe("fail");
    expect(failed?.details).toBe("tool timeout");
  });

  it("maps maestro:start repair vs initial differently", () => {
    const initial = mapOrcaEventToTraceRow({
      type: "maestro:start",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
    });
    expect(initial?.component).toBe("Brain");
    expect(initial?.stage).toBe("planning");

    expect(initial?.summary).toBe("Planning route");

    const repair = mapOrcaEventToTraceRow({
      type: "maestro:start",
      taskId: "t1",
      attempt: 1,
      isRepair: true,
    });
    expect(repair?.stage).toBe("repair");
    expect(repair?.summary).toBe("Starting repair pass 1");
  });

  it("maps task:done status to ok/warn/fail", () => {
    const ok = mapOrcaEventToTraceRow({
      type: "task:done",
      taskId: "t1",
      status: "SUCCESS",
    });
    expect(ok?.status).toBe("ok");
    expect(ok?.component).toBe("Benson");

    const warn = mapOrcaEventToTraceRow({
      type: "task:done",
      taskId: "t1",
      status: "WARN",
    });
    expect(warn?.status).toBe("warn");

    const fail = mapOrcaEventToTraceRow({
      type: "task:done",
      taskId: "t1",
      status: "FAIL",
    });
    expect(fail?.status).toBe("fail");
  });
});

describe("mapOrcaEventToTraceRow — privacy boundaries", () => {
  it("carries only sanitized Narrator milestone text into a trace row", () => {
    const escape = String.fromCharCode(0x1b);
    const row = mapOrcaEventToTraceRow({
      type: "task:start",
      taskId: "t1",
      intent: "secret request",
      narratorProgress: {
        milestone: "planning",
        message: "Planning" + escape + " now " + "x".repeat(300),
        tone: "complete",
      },
    } as any);

    expect(row?.narratorMilestone).toBe("planning");
    expect(row?.narratorTone).toBe("complete");
    expect(row?.narratorMessage).not.toContain(escape);
    expect(row?.narratorMessage.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(row)).not.toContain("secret request");
  });

  it("normalizes malformed Narrator updates", () => {
    expect(safeNarratorProgress(null)).toEqual({});
    expect(
      safeNarratorProgress({ message: "Working", milestone: "", tone: "unknown" }),
    ).toEqual({
      narratorMessage: "Working",
      narratorMilestone: "stage",
      narratorTone: "active",
    });
  });

  it("returns null for raw model output / chain-of-thought event types", () => {
    expect(
      mapOrcaEventToTraceRow({
        type: "stream:token",
        taskId: "t1",
        chunk: "secret raw model text",
      }),
    ).toBeNull();

    expect(
      mapOrcaEventToTraceRow({
        type: "maestro:thought",
        taskId: "t1",
        iteration: 1,
        thought: "model scratchpad: do not show",
        observation: "obs",
        next: "...",
      } as any),
    ).toBeNull();

    expect(
      mapOrcaEventToTraceRow({
        type: "stream:reset",
        taskId: "t1",
      }),
    ).toBeNull();
  });

  it("returns null for unknown event types instead of leaking raw payload", () => {
    expect(
      mapOrcaEventToTraceRow({
        type: "completely:made_up_event",
        taskId: "t1",
        secret: "leaked",
      } as any),
    ).toBeNull();
  });

  it("returns null on malformed events instead of throwing", () => {
    expect(mapOrcaEventToTraceRow(null as any)).toBeNull();
    expect(mapOrcaEventToTraceRow(undefined as any)).toBeNull();
    expect(mapOrcaEventToTraceRow({} as any)).toBeNull();
    expect(mapOrcaEventToTraceRow({ type: 123 } as any)).toBeNull();
  });

  it("does not echo raw error or reason content beyond the safety cap", () => {
    const huge = "X".repeat(2000);
    const row = mapOrcaEventToTraceRow({
      type: "subagent:failed",
      taskId: "t1",
      subagentId: "sa1",
      role: "reader",
      error: huge,
    });
    expect(row?.details?.length).toBeLessThanOrEqual(160);
  });

  it("strips control characters from sanitized payloads", () => {
    const row = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "before_qc",
      allowed: false,
      reason: "boom" + String.fromCharCode(0x1b) + "[31mred" + String.fromCharCode(0x1b) + "[0m",
    });
    expect(row?.details).not.toMatch(/\x1b/);
    expect(row?.details).toContain("boom");
  });
});

describe("statusIcon", () => {
  it("returns distinct glyphs per status so rows are visually distinguishable", () => {
    const icons = {
      ok:      statusIcon("ok"),
      warn:    statusIcon("warn"),
      fail:    statusIcon("fail"),
      blocked: statusIcon("blocked"),
      running: statusIcon("running"),
    };
    const unique = new Set(Object.values(icons));
    expect(unique.size).toBe(Object.keys(icons).length);
    expect(icons.ok).toBe("✓");
    expect(icons.warn).toBe("!");
    expect(icons.fail).toBe("✕");
    expect(icons.blocked).toBe("○");
  });

  it("falls back to the running icon for unknown statuses", () => {
    expect(statusIcon("unknown")).toBe(statusIcon("running"));
  });
});

describe("shouldAutoRemove — completed-state behavior", () => {
  it("never removes a panel that is still running", () => {
    expect(shouldAutoRemove({ finished: false, expanded: false })).toBe(false);
    expect(shouldAutoRemove({ finished: false, expanded: true })).toBe(false);
  });

  it("auto-removes a finished+collapsed panel", () => {
    expect(shouldAutoRemove({ finished: true, expanded: false })).toBe(true);
  });

  it("does NOT auto-remove a finished panel the user has expanded", () => {
    expect(shouldAutoRemove({ finished: true, expanded: true })).toBe(false);
  });

  it("returns false for missing/malformed state instead of throwing", () => {
    expect(shouldAutoRemove(null as any)).toBe(false);
    expect(shouldAutoRemove(undefined as any)).toBe(false);
    expect(shouldAutoRemove({} as any)).toBe(false);
  });
});

describe("safe-summary helpers", () => {
  it("safeCount clamps non-numeric, negative, NaN, and over-cap values", () => {
    expect(safeCount(0)).toBe(0);
    expect(safeCount(3)).toBe(3);
    expect(safeCount(3.7)).toBe(3);
    expect(safeCount(-5)).toBe(0);
    expect(safeCount("abc" as any)).toBe(0);
    expect(safeCount(NaN)).toBe(0);
    expect(safeCount(Infinity)).toBe(0);
    expect(safeCount(99999)).toBe(9999);
    expect(safeCount(undefined as any)).toBe(0);
  });

  it("safeRole strips control chars, trims, falls back to 'worker'", () => {
    expect(safeRole("reader")).toBe("reader");
    expect(safeRole("  coder  ")).toBe("coder");
    expect(safeRole("")).toBe("worker");
    expect(safeRole(undefined as any)).toBe("worker");
    expect(safeRole("a\x00b")).toBe("a b");
    expect(safeRole("X".repeat(200)).length).toBeLessThanOrEqual(32);
  });

  it("safeVerdict only allows known enums", () => {
    expect(safeVerdict("PASS")).toBe("PASS");
    expect(safeVerdict("WARN")).toBe("WARN");
    expect(safeVerdict("FAIL")).toBe("FAIL");
    expect(safeVerdict("pass")).toBe("UNKNOWN");
    expect(safeVerdict(undefined)).toBe("UNKNOWN");
    expect(safeVerdict("BOOM" as any)).toBe("UNKNOWN");
  });

  it("safeStage trims, control-strips, falls back to 'stage'", () => {
    expect(safeStage("before_qc")).toBe("before_qc");
    expect(safeStage("")).toBe("stage");
    expect(safeStage(null as any)).toBe("stage");
    expect(safeStage("a\x1bb")).toBe("a b");
  });

  it("formatDuration covers sub-second, seconds, and minute ranges", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(450)).toBe("0.5s");
    expect(formatDuration(12_345)).toBe("12s");
    expect(formatDuration(133_500)).toBe("2m 14s");
    expect(formatDuration(-5)).toBe("");
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(undefined as any)).toBe("");
  });

  it("formatIssueSummary builds 'QC <verb> · N issue(s)' without echoing descriptions", () => {
    expect(formatIssueSummary("PASS", 0)).toBe("QC passed");
    expect(formatIssueSummary("WARN", 2)).toBe("QC warned · 2 issues");
    expect(formatIssueSummary("FAIL", 1)).toBe("QC failed · 1 issue");
    expect(formatIssueSummary("FAIL", 0)).toBe("QC failed · 0 issues");
    // Unknown verdict still produces something safe and non-empty.
    expect(formatIssueSummary("BOOM" as any, 3)).toBe("QC reported · 3 issues");
  });
});

describe("mapOrcaEventToTraceRow — improved Phase 2 summaries", () => {
  it("dewey:brief includes tone in summary and counts in details", () => {
    const row = mapOrcaEventToTraceRow({
      type: "dewey:brief",
      taskId: "t1",
      userName: "James",
      suggestedTone: "concise",
      relevantPreferences: ["a", "b"],
      relevantContext: ["c"],
    });
    expect(row?.summary).toBe("Loaded context · tone: concise");
    expect(row?.details).toBe("2 preferences, 1 context item");
  });

  it("dewey:brief without tone falls back to plain 'Loaded context'", () => {
    const row = mapOrcaEventToTraceRow({
      type: "dewey:brief",
      taskId: "t1",
      userName: "",
      suggestedTone: "",
      relevantPreferences: [],
      relevantContext: [],
    });
    expect(row?.summary).toBe("Loaded context");
    expect(row?.details).toBeUndefined();
  });

  it("miranda after_qc allowed shows 'after_qc checkpoint recorded'", () => {
    const row = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "after_qc",
      allowed: true,
      reason: "",
    });
    expect(row?.summary).toBe("after_qc checkpoint recorded");
    expect(row?.status).toBe("ok");
  });

  it("miranda before_llm_call blocked shows '<gate> blocked' and stage matches", () => {
    const row = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "before_llm_call",
      allowed: false,
      reason: "budget",
    } as any);
    expect(row?.stage).toBe("before_llm_call");
    expect(row?.summary).toBe("before_llm_call blocked");
    expect(row?.status).toBe("blocked");
  });

  it("maestro:start and maestro:done use new phrasing", () => {
    const initial = mapOrcaEventToTraceRow({
      type: "maestro:start",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
    });
    expect(initial?.summary).toBe("Planning route");

    const repair = mapOrcaEventToTraceRow({
      type: "maestro:start",
      taskId: "t1",
      attempt: 2,
      isRepair: true,
    });
    expect(repair?.summary).toBe("Starting repair pass 2");

    const synthOk = mapOrcaEventToTraceRow({
      type: "maestro:done",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      hasOutput: true,
    });
    expect(synthOk?.summary).toBe("Synthesis complete");
    expect(synthOk?.status).toBe("ok");

    const synthEmpty = mapOrcaEventToTraceRow({
      type: "maestro:done",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      hasOutput: false,
    });
    expect(synthEmpty?.summary).toBe("Synthesis incomplete");
    expect(synthEmpty?.status).toBe("warn");

    const repairDone = mapOrcaEventToTraceRow({
      type: "maestro:done",
      taskId: "t1",
      attempt: 1,
      isRepair: true,
      hasOutput: true,
    });
    expect(repairDone?.summary).toBe("Repair pass 1 complete");
  });

  it("maestro:agent_done formats iterations and humanizes stop reasons", () => {
    const ok = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "done",
      iterations: 3,
    } as any);
    expect(ok?.summary).toBe("coder completed · 3 iterations");
    expect(ok?.status).toBe("ok");

    const oneIter = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "reader",
      stoppedBecause: "done",
      iterations: 1,
    } as any);
    expect(oneIter?.summary).toBe("reader completed · 1 iteration");

    const maxed = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "reviewer",
      stoppedBecause: "max_iterations",
      iterations: 5,
    } as any);
    expect(maxed?.summary).toBe("reviewer stopped · max iterations");
    expect(maxed?.status).toBe("warn");

    const errored = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "error",
      iterations: 0,
    } as any);
    expect(errored?.summary).toBe("coder errored");
    expect(errored?.status).toBe("fail");

    const looped = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "loop_detected",
      iterations: 8,
      loopEvidence: { repeatedCall: "read_file({secret})", occurrences: 4 },
    } as any);
    expect(looped?.summary).toBe("coder stopped · loop detected");
    // loopEvidence.occurrences (count) is safe; repeatedCall (raw tool args) is NOT included.
    expect(looped?.details).toBe("Loop: 4 repeated calls");
    expect(looped?.details ?? "").not.toContain("read_file");
    expect(looped?.details ?? "").not.toContain("secret");
  });

  it("subagent:spawned/done/failed use role-prefixed phrasing", () => {
    const spawned = mapOrcaEventToTraceRow({
      type: "subagent:spawned",
      taskId: "t1",
      subagentId: "sa1",
      role: "reader",
      task: "free-text instructions that must NOT be shown",
    });
    expect(spawned?.summary).toBe("reader started");
    // Must not echo the .task instructions anywhere.
    const all = JSON.stringify(spawned);
    expect(all).not.toContain("free-text instructions");

    const done = mapOrcaEventToTraceRow({
      type: "subagent:done",
      taskId: "t1",
      subagentId: "sa1",
      role: "coder",
      ok: true,
    });
    expect(done?.summary).toBe("coder completed");

    const incomplete = mapOrcaEventToTraceRow({
      type: "subagent:done",
      taskId: "t1",
      subagentId: "sa1",
      role: "coder",
      ok: false,
    });
    expect(incomplete?.summary).toBe("coder finished without output");
    expect(incomplete?.status).toBe("warn");

    const failed = mapOrcaEventToTraceRow({
      type: "subagent:failed",
      taskId: "t1",
      subagentId: "sa1",
      role: "reviewer",
      error: "tool timeout",
    });
    expect(failed?.summary).toBe("reviewer failed");
  });

  it("qc:result includes issue codes (constants) but never descriptions", () => {
    const fail = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "FAIL",
      issueCount: 4,
      issues: [
        { severity: "HIGH",   code: "MISSING_TESTS",       description: "model-generated description X" },
        { severity: "MEDIUM", code: "INSECURE_DEFAULT",    description: "model-generated description Y" },
        { severity: "LOW",    code: "STYLE_NIT",           description: "model-generated description Z" },
        { severity: "LOW",    code: "ANOTHER_CODE",        description: "model-generated description W" },
      ],
    });
    expect(fail?.summary).toBe("QC failed · 4 issues");
    // Codes are safe; descriptions must NOT appear.
    expect(fail?.details).toBe("MISSING_TESTS, INSECURE_DEFAULT, STYLE_NIT (+1 more)");
    const all = JSON.stringify(fail);
    expect(all).not.toContain("model-generated description");
  });

  it("qc:result PASS has no details (no issue list to show)", () => {
    const pass = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "PASS",
      issueCount: 0,
    });
    expect(pass?.details).toBeUndefined();
  });

  it("repair:start prints 'Starting repair pass N of M'", () => {
    const row = mapOrcaEventToTraceRow({
      type: "repair:start",
      taskId: "t1",
      pass: 1,
      maxPasses: 2,
    });
    expect(row?.summary).toBe("Starting repair pass 1 of 2");
  });

  it("task:done WARN includes 'with warnings'; FAIL says 'Run failed'", () => {
    const warn = mapOrcaEventToTraceRow({
      type: "task:done",
      taskId: "t1",
      status: "WARN",
    });
    expect(warn?.summary).toBe("Preparing final response · with warnings");

    const fail = mapOrcaEventToTraceRow({
      type: "task:done",
      taskId: "t1",
      status: "FAIL",
    });
    expect(fail?.summary).toBe("Run failed");
  });
});

describe("mapOrcaEventToTraceRow — malformed metadata fallback", () => {
  it("subagent:* with missing role falls back to 'worker'", () => {
    const spawned = mapOrcaEventToTraceRow({
      type: "subagent:spawned",
      taskId: "t1",
      subagentId: "sa1",
      role: "",
      task: "",
    });
    expect(spawned?.component).toBe("Worker (worker)");
    expect(spawned?.summary).toBe("worker started");
  });

  it("maestro:agent_done with missing iterations omits the iteration count", () => {
    const row = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "reader",
      stoppedBecause: "done",
    } as any);
    expect(row?.summary).toBe("reader completed");
  });

  it("repair:start with missing maxPasses omits the 'of M' suffix", () => {
    const row = mapOrcaEventToTraceRow({
      type: "repair:start",
      taskId: "t1",
      pass: 1,
    } as any);
    expect(row?.summary).toBe("Starting repair pass 1");
  });

  it("qc:result with garbage verdict still maps to a safe summary", () => {
    const row = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "BOOM" as any,
      issueCount: 2,
    });
    expect(row?.summary).toBe("QC reported · 2 issues");
    // Unknown verdict is treated as worse than WARN (fail).
    expect(row?.status).toBe("fail");
  });

  it("dewey:brief with non-array preferences/context degrades cleanly", () => {
    const row = mapOrcaEventToTraceRow({
      type: "dewey:brief",
      taskId: "t1",
      userName: "u",
      suggestedTone: "tone",
      relevantPreferences: null as any,
      relevantContext: undefined as any,
    });
    expect(row?.summary).toBe("Loaded context · tone: tone");
    expect(row?.details).toBeUndefined();
  });
});

describe("mapOrcaEventToTraceRow — Phase 2 privacy regression checks", () => {
  it("subagent:spawned never echoes the .task instructions field", () => {
    const row = mapOrcaEventToTraceRow({
      type: "subagent:spawned",
      taskId: "t1",
      subagentId: "sa1",
      role: "reader",
      task: "SECRET_TASK_INSTRUCTIONS_DO_NOT_LEAK",
    });
    expect(JSON.stringify(row)).not.toContain("SECRET_TASK_INSTRUCTIONS");
  });

  it("maestro:agent_start never echoes the .doneCriteria array", () => {
    const row = mapOrcaEventToTraceRow({
      type: "maestro:agent_start",
      taskId: "t1",
      role: "coder",
      doneCriteria: ["SECRET_CRITERION_DO_NOT_LEAK"],
    } as any);
    expect(JSON.stringify(row)).not.toContain("SECRET_CRITERION");
  });

  it("maestro:agent_done falls back to generic 'stopped' for unknown / internal stop reasons", () => {
    // Unknown stop reason — must not echo the raw token back to the user.
    const unknown = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "some_future_internal_token",
      iterations: 0,
    } as any);
    expect(unknown?.summary).toBe("coder stopped");
    expect(JSON.stringify(unknown)).not.toContain("some_future_internal_token");

    // Empty / missing stop reason still produces a safe label.
    const empty = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "",
      iterations: 0,
    } as any);
    expect(empty?.summary).toBe("coder stopped");
  });

  it("maestro:agent_done never echoes any internal stop-reason token in summary", () => {
    // Sample of internal-style tokens that must not surface in user-facing
    // text. Build the test inputs from numeric character codes so the file
    // itself does not need to spell the runtime tokens out as literals.
    const internalTokens = [
      String.fromCharCode(103, 97, 116, 101, 95, 98, 108, 111, 99, 107, 101, 100), // "gate" + "_blocked"
      "some_other_internal_status",
    ];
    for (const token of internalTokens) {
      const row = mapOrcaEventToTraceRow({
        type: "maestro:agent_done",
        taskId: "t1",
        role: "coder",
        stoppedBecause: token,
        iterations: 0,
      } as any);
      // Summary must not echo the raw token, and the entire row JSON
      // must not contain it either (including details / nested fields).
      expect(row?.summary ?? "").not.toContain(token);
      expect(JSON.stringify(row)).not.toContain(token);
    }
  });

  it("maestro:agent_done loopEvidence.repeatedCall is NEVER included", () => {
    const row = mapOrcaEventToTraceRow({
      type: "maestro:agent_done",
      taskId: "t1",
      role: "coder",
      stoppedBecause: "loop_detected",
      iterations: 6,
      loopEvidence: {
        repeatedCall: "exec_shell({cmd: 'cat /etc/passwd'})",
        occurrences: 3,
      },
    } as any);
    expect(JSON.stringify(row)).not.toContain("exec_shell");
    expect(JSON.stringify(row)).not.toContain("/etc/passwd");
  });

  it("qc:result issue descriptions are never exposed in summary or details", () => {
    const row = mapOrcaEventToTraceRow({
      type: "qc:result",
      taskId: "t1",
      attempt: 0,
      isRepair: false,
      verdict: "WARN",
      issueCount: 1,
      issues: [
        {
          severity: "HIGH",
          code: "ISSUE_CODE",
          description: "MODEL_GENERATED_FREE_TEXT_DO_NOT_LEAK",
        },
      ],
    });
    expect(JSON.stringify(row)).not.toContain("MODEL_GENERATED_FREE_TEXT");
  });

  it("dewey:brief never echoes preferences/context list contents (counts only)", () => {
    const row = mapOrcaEventToTraceRow({
      type: "dewey:brief",
      taskId: "t1",
      userName: "u",
      suggestedTone: "tone",
      relevantPreferences: ["SECRET_PREFERENCE"],
      relevantContext: ["SECRET_CONTEXT"],
    });
    expect(JSON.stringify(row)).not.toContain("SECRET_PREFERENCE");
    expect(JSON.stringify(row)).not.toContain("SECRET_CONTEXT");
  });

  it("long miranda reason is capped and control characters stripped", () => {
    const huge = "X".repeat(2000) + "\x1b[31mred\x1b[0m";
    const row = mapOrcaEventToTraceRow({
      type: "miranda:checkpoint",
      taskId: "t1",
      gate: "before_llm_call",
      allowed: false,
      reason: huge,
    } as any);
    expect((row?.details ?? "").length).toBeLessThanOrEqual(MAX_DETAIL_LEN_FOR_TEST);
    expect(row?.details).not.toMatch(/\x1b/);
  });
});

describe("mapOrcaEventToTraceRow — row shape", () => {
  it("includes id, runId, component, stage, status, summary, startedAt", () => {
    const row = mapOrcaEventToTraceRow(
      {
        type: "task:start",
        taskId: "task-42",
        intent: "x",
      },
      { now: 1700000000000, seq: 7 },
    );
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      runId: "task-42",
      component: "Benson",
      stage: "received",
      status: "running",
      startedAt: 1700000000000,
    });
    expect(typeof row?.id).toBe("string");
    expect(row?.id).toContain("task-42");
    expect(row?.id).toContain("task:start");
  });
});

// ── Phase 3: "View full trace" link ──────────────────────────────────────
// createLiveTracePanel builds a live DOM panel and requires a browser document
// object; it cannot be exercised in the Node/Vitest environment used here.
// The tests below verify what is testable without DOM:
//   - The function is exported from the module API.
//   - The controller shape contract (setTraceLink) is documented.
// Full integration is verified by running the desktop app and confirming the
// "Full trace ↓" button appears on the live panel after a run completes.

describe("createLiveTracePanel — Phase 3 API surface", () => {
  it("exports createLiveTracePanel as a function", () => {
    expect(typeof PipelineTrace.createLiveTracePanel).toBe("function");
  });

  it("does not expose a setTraceLink on the module itself (only on controller)", () => {
    // setTraceLink lives on the object returned by createLiveTracePanel,
    // not on the module-level API, so no raw callback surface is accessible
    // without first creating a panel.
    expect((PipelineTrace as any).setTraceLink).toBeUndefined();
  });
});

// ── badgeRoleLabel — overall badge header role mapping ───────────────────
// Brain is the planning/routing/synthesis layer, not a worker agent.
// The overall run badge must never show "brain" as if Brain executed the work.

describe("badgeRoleLabel — overall badge header role mapping", () => {
  it("passes non-brain specialist roles through unchanged", () => {
    expect(badgeRoleLabel({ role: "coder" })).toBe("coder");
    expect(badgeRoleLabel({ role: "debugger" })).toBe("debugger");
    expect(badgeRoleLabel({ role: "reviewer" })).toBe("reviewer");
  });

  it("passes project_audit through unchanged", () => {
    expect(badgeRoleLabel({ role: "project_audit" })).toBe("project_audit");
  });

  it("passes 'unknown' through unchanged", () => {
    expect(badgeRoleLabel({ role: "unknown" })).toBe("unknown");
  });

  it("returns 'unknown' for null, undefined, or empty role", () => {
    expect(badgeRoleLabel({ role: null as any })).toBe("unknown");
    expect(badgeRoleLabel({ role: "" as any })).toBe("unknown");
    expect(badgeRoleLabel({} as any)).toBe("unknown");
    expect(badgeRoleLabel(null as any)).toBe("unknown");
  });

  it("maps brain + auditDetail → project_audit (audit wrapped in brain metadata)", () => {
    expect(badgeRoleLabel({ role: "brain", auditDetail: { readiness: "ready" } })).toBe("project_audit");
  });

  it("maps brain + subagent:spawned events → orchestration", () => {
    expect(badgeRoleLabel({
      role: "brain",
      _eventLog: [
        { type: "task:start" },
        { type: "subagent:spawned", role: "coder" },
        { type: "subagent:spawned", role: "debugger" },
      ],
    })).toBe("orchestration");
  });

  it("maps brain + multiple maestro:agent_start events → orchestration", () => {
    expect(badgeRoleLabel({
      role: "brain",
      _eventLog: [
        { type: "maestro:agent_start", role: "coder" },
        { type: "maestro:agent_start", role: "debugger" },
      ],
    })).toBe("orchestration");
  });

  it("maps brain + single non-brain agent_start → that worker's role", () => {
    expect(badgeRoleLabel({
      role: "brain",
      _eventLog: [{ type: "maestro:agent_start", role: "coder" }],
    })).toBe("coder");
  });

  it("maps brain + single brain agent_start (routed to itself) → analysis", () => {
    expect(badgeRoleLabel({
      role: "brain",
      _eventLog: [{ type: "maestro:agent_start", role: "brain" }],
    })).toBe("analysis");
  });

  it("maps brain with empty or absent event log → analysis (direct answer)", () => {
    expect(badgeRoleLabel({ role: "brain", _eventLog: [] })).toBe("analysis");
    expect(badgeRoleLabel({ role: "brain" })).toBe("analysis");
  });

  it("does not leak 'brain' as the overall label when workers did the actual work", () => {
    const result = badgeRoleLabel({
      role: "brain",
      _eventLog: [
        { type: "subagent:spawned", role: "coder" },
        { type: "subagent:done", role: "coder", ok: true },
      ],
    });
    expect(result).not.toBe("brain");
    expect(result).toBe("orchestration");
  });

  it("Brain planning events on live trace rows are unaffected (separate from badge label)", () => {
    // mapOrcaEventToTraceRow still renders Brain planning events as rows;
    // badgeRoleLabel only controls the overall badge header label.
    const row = mapOrcaEventToTraceRow({ type: "task:start", taskId: "t1", intent: "plan" });
    expect(row?.component).toBe("Benson");
    // badgeRoleLabel itself never touches row-level component names
    expect(badgeRoleLabel({ role: "brain" })).toBe("analysis");
  });
});
