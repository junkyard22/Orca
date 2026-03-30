/**
 * dewey-core — Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dewey } from "./dewey.js";
import { ContextStore } from "./context/contextStore.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "dewey-test-"));
}

// ---------------------------------------------------------------------------
// ContextStore
// ---------------------------------------------------------------------------

describe("ContextStore", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new ContextStore(join(tmpDir, "context.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads default template when no file exists", async () => {
    const ctx = await store.load();
    expect(ctx.hot.name).toBeDefined();
    expect(ctx.hot.timezone).toBeDefined();
    expect(ctx.warm.learnedPreferences).toBeDefined();
  });

  it("persists and reloads context", async () => {
    await store.load();
    await store.addSignal("prefer_email", "communication");

    const store2 = new ContextStore(join(tmpDir, "context.json"));
    const ctx2 = await store2.load();
    expect(ctx2.warm.learnedPreferences.communication).toContain("prefer_email");
  });

  it("getRelevantContext returns preferences for the task type", async () => {
    await store.load();
    await store.addSignal("use_calendar_events", "scheduling");

    const result = store.getRelevantContext("scheduling");
    expect(result.preferences).toContain("use_calendar_events");
    expect(result.availableApps).toBeDefined();
    expect(Array.isArray(result.notes)).toBe(true);
  });

  it("getRelevantContext falls back to general for unknown type", async () => {
    await store.load();
    const result = store.getRelevantContext("unknown_category_xyz");
    expect(result.preferences).toBeDefined();
    expect(Array.isArray(result.preferences)).toBe(true);
  });

  it("addSignal does not duplicate existing signals", async () => {
    await store.load();
    await store.addSignal("prefer_brief", "communication");
    await store.addSignal("prefer_brief", "communication");

    const result = store.getRelevantContext("communication");
    const count = result.preferences.filter((p) => p === "prefer_brief").length;
    expect(count).toBe(1);
  });

  it("migrates legacy preference buckets into learned preferences", async () => {
    writeFileSync(
      join(tmpDir, "context.json"),
      JSON.stringify({
        hot: {
          name: "User",
          timezone: "America/New_York",
          currentSession: { startedAt: "", recentTasks: [] },
        },
        warm: {
          preferences: {
            scheduling: [],
            communication: ["prefer_brief"],
            food: [],
            work: [],
            general: [],
          },
          patterns: { commonTaskTypes: [], peakHours: [] },
          household: { notes: [] },
          connectedApps: { gmail: false, outlook: false, calendar: false },
        },
      }),
      "utf-8",
    );

    const ctx = await store.load();
    expect(ctx.warm.learnedPreferences.communication).toContain("prefer_brief");
  });

  it("startSession resets recent tasks and records start time", async () => {
    await store.load();
    await store.recordTask("old task");
    await store.startSession();

    const ctx = await new ContextStore(join(tmpDir, "context.json")).load();
    expect(ctx.hot.currentSession.recentTasks).toHaveLength(0);
    expect(ctx.hot.currentSession.startedAt).not.toBe("");
  });

  it("recordTask appends to session history", async () => {
    await store.load();
    await store.startSession();
    await store.recordTask("implement auth");
    await store.recordTask("write tests");

    const ctx = await new ContextStore(join(tmpDir, "context.json")).load();
    expect(ctx.hot.currentSession.recentTasks).toContain("implement auth");
    expect(ctx.hot.currentSession.recentTasks).toContain("write tests");
  });
});

// ---------------------------------------------------------------------------
// Dewey
// ---------------------------------------------------------------------------

describe("Dewey", () => {
  let tmpDir: string;
  let dewey: Dewey;

  beforeEach(() => {
    tmpDir = makeTempDir();
    dewey = new Dewey(join(tmpDir, "context.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("brief()", () => {
    it("returns a valid UserBrief for any task", async () => {
      const brief = await dewey.brief("implement a login form");
      expect(brief.userName).toBeDefined();
      expect(brief.timezone).toBeDefined();
      expect(Array.isArray(brief.relevantPreferences)).toBe(true);
      expect(Array.isArray(brief.relevantContext)).toBe(true);
      expect(Array.isArray(brief.availableApps)).toBe(true);
      expect(["brief", "detailed", "casual", "formal"]).toContain(brief.suggestedTone);
    });

    it("detects work task type for coding tasks", async () => {
      // work-type tasks should return work preferences (initially empty)
      const brief = await dewey.brief("implement a REST API endpoint");
      expect(brief).toBeDefined();
      expect(brief.suggestedTone).toBeDefined();
    });

    it("detects scheduling task type", async () => {
      const brief = await dewey.brief("schedule a meeting with the team");
      expect(brief).toBeDefined();
    });

    it("detects communication task type", async () => {
      const brief = await dewey.brief("send an email to the client");
      expect(brief).toBeDefined();
    });

    it("returns casual tone when no communication prefs are set", async () => {
      const brief = await dewey.brief("help me with something");
      expect(brief.suggestedTone).toBe("casual");
    });

    it("does not turn profile data into learned preferences", async () => {
      writeFileSync(
        join(tmpDir, "context.json"),
        JSON.stringify({
          hot: {
            name: "James",
            timezone: "America/New_York",
            currentSession: { startedAt: "", recentTasks: [] },
          },
          warm: {
            learnedPreferences: {
              scheduling: [],
              communication: [],
              food: [],
              work: [],
              general: [],
            },
            patterns: { commonTaskTypes: [], peakHours: [] },
            household: { notes: ["Prefers local tools when available"] },
            connectedApps: { gmail: true, outlook: false, calendar: false },
          },
        }),
        "utf-8",
      );

      const brief = await dewey.brief("help me with something");
      expect(brief.userName).toBe("James");
      expect(brief.timezone).toBe("America/New_York");
      expect(brief.availableApps).toContain("gmail");
      expect(brief.relevantContext).toContain("Prefers local tools when available");
      expect(brief.relevantPreferences).toEqual([]);
      expect(brief.suggestedTone).toBe("casual");
    });

    it("applies communication preferences across task types", async () => {
      await dewey.observe({
        taskType: "work",
        taskSummary: "Implement feature",
        timestamp: new Date().toISOString(),
        verdict: "PASS",
        preferencesApplied: [],
        newSignals: ["prefer_brief"],
      });

      const brief = await dewey.brief("summarize this file");
      expect(brief.suggestedTone).toBe("brief");
      expect(brief.relevantPreferences).toContain("prefer_brief");
    });
  });

  describe("reviewPlan()", () => {
    it("returns an approved review for a safe plan", async () => {
      const review = await dewey.reviewPlan(
        { steps: ["read file", "summarize"], toolsRequired: ["read_file"], role: "reader" },
        "summarize this document",
      );
      expect(review.approved).toBeDefined();
      expect(Array.isArray(review.concerns)).toBe(true);
      expect(Array.isArray(review.suggestions)).toBe(true);
    });

    it("uses a provided brief instead of fetching a new one", async () => {
      const brief = await dewey.brief("any task");
      // Should not throw; just verifies the method accepts an existing brief
      const review = await dewey.reviewPlan(
        { steps: ["write code"], toolsRequired: [], role: "strong_model" },
        "write a function",
        brief,
      );
      expect(review).toBeDefined();
    });
  });

  describe("observe()", () => {
    it("records a task in session history", async () => {
      await dewey.startSession();
      await dewey.observe({
        taskType: "work",
        taskSummary: "Implement authentication",
        timestamp: new Date().toISOString(),
        verdict: "PASS",
        preferencesApplied: [],
        newSignals: [],
      });

      // Verify by briefing again — no error expected
      const brief = await dewey.brief("next task");
      expect(brief).toBeDefined();
    });

    it("learns new signals for the relevant category", async () => {
      await dewey.observe({
        taskType: "communication",
        taskSummary: "Draft email",
        timestamp: new Date().toISOString(),
        verdict: "PASS",
        preferencesApplied: [],
        newSignals: ["prefer_formal_tone"],
      });

      // A new Dewey instance pointing at the same file should see the signal
      const dewey2 = new Dewey(join(tmpDir, "context.json"));
      const brief = await dewey2.brief("send an email");
      expect(brief.relevantPreferences).toContain("prefer_formal_tone");
    });

    it("routes response-style signals into communication preferences", async () => {
      await dewey.observe({
        taskType: "work",
        taskSummary: "Explain code",
        timestamp: new Date().toISOString(),
        verdict: "PASS",
        preferencesApplied: [],
        newSignals: ["prefer_bullets"],
      });

      const ctx = await new ContextStore(join(tmpDir, "context.json")).load();
      expect(ctx.warm.learnedPreferences.communication).toContain("prefer_bullets");
    });

    it("does not throw on empty newSignals", async () => {
      await expect(
        dewey.observe({
          taskType: "general",
          taskSummary: "misc task",
          timestamp: new Date().toISOString(),
          verdict: "WARN",
          preferencesApplied: [],
          newSignals: [],
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("startSession()", () => {
    it("resets session without throwing", async () => {
      await expect(dewey.startSession()).resolves.toBeUndefined();
    });

    it("can be called multiple times", async () => {
      await dewey.startSession();
      await dewey.startSession();
      // No errors — each call resets to a clean session
    });
  });
});
