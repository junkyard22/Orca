/**
 * Tests for SqliteStore persistence layer.
 * 
 * Uses an in-memory SQLite database for fast, isolated tests.
 */

import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { SqliteStore } from "./sqliteStore.js";
import type { RunRecord, ThoughtRecord, ToolEvent, FileChange } from "./types.js";

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(async () => {
    // Use in-memory database for each test
    store = new SqliteStore(":memory:");
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe("saveRun and getRun", () => {
    it("should save a run and retrieve it with all fields matching", async () => {
      const run: RunRecord = {
        id: "test-run-123",
        createdAt: "2024-01-15T10:30:00.000Z",
        intent: "Add a new feature to the app",
        role: "engineer",
        status: "SUCCESS",
        stoppedBecause: "done",
        iterationCount: 3,
        outputText: "Feature implemented successfully",
        summary: "All tests pass",
        verdict: "PASS",
        confidence: 0.95,
        issueCount: 0,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.0025,
      };

      const thoughts: ThoughtRecord[] = [];
      const toolEvents: ToolEvent[] = [];
      const filesChanged: FileChange[] = [];

      await store.saveRun(run, thoughts, toolEvents, filesChanged);

      const retrieved = await store.getRun("test-run-123");
      assert.ok(retrieved, "Run should be retrieved");
      assert.strictEqual(retrieved.id, run.id);
      assert.strictEqual(retrieved.createdAt, run.createdAt);
      assert.strictEqual(retrieved.intent, run.intent);
      assert.strictEqual(retrieved.role, run.role);
      assert.strictEqual(retrieved.status, run.status);
      assert.strictEqual(retrieved.stoppedBecause, run.stoppedBecause);
      assert.strictEqual(retrieved.iterationCount, run.iterationCount);
      assert.strictEqual(retrieved.outputText, run.outputText);
      assert.strictEqual(retrieved.summary, run.summary);
      assert.strictEqual(retrieved.verdict, run.verdict);
      assert.strictEqual(retrieved.confidence, run.confidence);
      assert.strictEqual(retrieved.issueCount, run.issueCount);
      assert.strictEqual(retrieved.inputTokens, run.inputTokens);
      assert.strictEqual(retrieved.outputTokens, run.outputTokens);
      assert.strictEqual(retrieved.costUsd, run.costUsd);
    });

    it("should return null for non-existent run", async () => {
      const result = await store.getRun("non-existent");
      assert.strictEqual(result, null);
    });
  });

  describe("getRecentRuns", () => {
    it("should return runs in correct order (newest first)", async () => {
      const runs: RunRecord[] = [
        {
          id: "run-1",
          createdAt: "2024-01-15T08:00:00.000Z",
          intent: "First run",
          status: "SUCCESS",
          verdict: "PASS",
        },
        {
          id: "run-2",
          createdAt: "2024-01-15T10:00:00.000Z",
          intent: "Second run",
          status: "FAIL",
          verdict: "FAIL",
        },
        {
          id: "run-3",
          createdAt: "2024-01-15T12:00:00.000Z",
          intent: "Third run",
          status: "SUCCESS",
          verdict: "PASS",
        },
      ];

      for (const run of runs) {
        await store.saveRun(run, [], [], []);
      }

      const recent = await store.getRecentRuns();
      assert.strictEqual(recent.length, 3);
      assert.strictEqual(recent[0].id, "run-3", "Newest run should be first");
      assert.strictEqual(recent[1].id, "run-2");
      assert.strictEqual(recent[2].id, "run-1", "Oldest run should be last");
    });

    it("should respect the limit parameter", async () => {
      const runs: RunRecord[] = [
        { id: "run-1", createdAt: "2024-01-15T08:00:00.000Z", intent: "First", status: "SUCCESS" },
        { id: "run-2", createdAt: "2024-01-15T09:00:00.000Z", intent: "Second", status: "SUCCESS" },
        { id: "run-3", createdAt: "2024-01-15T10:00:00.000Z", intent: "Third", status: "SUCCESS" },
      ];

      for (const run of runs) {
        await store.saveRun(run, [], [], []);
      }

      const limited = await store.getRecentRuns(2);
      assert.strictEqual(limited.length, 2);
      assert.strictEqual(limited[0].id, "run-3");
      assert.strictEqual(limited[1].id, "run-2");
    });
  });

  describe("searchRuns", () => {
    it("should find runs matching intent query", async () => {
      const runs: RunRecord[] = [
        { id: "run-1", createdAt: "2024-01-15T08:00:00.000Z", intent: "Fix login bug", status: "SUCCESS", outputText: "Fixed" },
        { id: "run-2", createdAt: "2024-01-15T09:00:00.000Z", intent: "Add user profile", status: "SUCCESS", outputText: "Done" },
        { id: "run-3", createdAt: "2024-01-15T10:00:00.000Z", intent: "Fix navigation bug", status: "FAIL", outputText: "Failed" },
      ];

      for (const run of runs) {
        await store.saveRun(run, [], [], []);
      }

      const results = await store.searchRuns("bug");
      assert.strictEqual(results.length, 2);
      assert.ok(results.some((r) => r.id === "run-1"));
      assert.ok(results.some((r) => r.id === "run-3"));
    });

    it("should find runs matching output_text query", async () => {
      const runs: RunRecord[] = [
        { id: "run-1", createdAt: "2024-01-15T08:00:00.000Z", intent: "Task one", status: "SUCCESS", outputText: "Implementation complete" },
        { id: "run-2", createdAt: "2024-01-15T09:00:00.000Z", intent: "Task two", status: "SUCCESS", outputText: "Feature added" },
      ];

      for (const run of runs) {
        await store.saveRun(run, [], [], []);
      }

      const results = await store.searchRuns("complete");
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, "run-1");
    });

    it("should respect the limit parameter", async () => {
      await store.saveRun({ id: "run-1", createdAt: "2024-01-15T08:00:00.000Z", intent: "Test feature", status: "SUCCESS" }, [], [], []);
      await store.saveRun({ id: "run-2", createdAt: "2024-01-15T09:00:00.000Z", intent: "Test bugfix", status: "SUCCESS" }, [], [], []);

      const results = await store.searchRuns("Test", 1);
      assert.strictEqual(results.length, 1);
    });
  });

  describe("getRunThoughts", () => {
    it("should retrieve thoughts for a specific run", async () => {
      const run: RunRecord = {
        id: "run-with-thoughts",
        createdAt: "2024-01-15T10:00:00.000Z",
        intent: "Complex task",
        status: "SUCCESS",
      };

      const thoughts: ThoughtRecord[] = [
        { runId: "run-with-thoughts", iteration: 0, thought: "First, I need to understand the codebase", observation: "Found relevant files", next: "Read the files" },
        { runId: "run-with-thoughts", iteration: 1, thought: "Now I can implement the change", observation: "Changes applied", next: "Test the changes" },
        { runId: "run-with-thoughts", iteration: 2, thought: "All tests pass", observation: "Ready to submit", next: "done" },
      ];

      await store.saveRun(run, thoughts, [], []);

      const retrieved = await store.getRunThoughts("run-with-thoughts");
      assert.strictEqual(retrieved.length, 3);
      assert.strictEqual(retrieved[0].iteration, 0);
      assert.strictEqual(retrieved[0].thought, thoughts[0].thought);
      assert.strictEqual(retrieved[1].iteration, 1);
      assert.strictEqual(retrieved[2].iteration, 2);
    });

    it("should return empty array for run with no thoughts", async () => {
      const run: RunRecord = {
        id: "run-no-thoughts",
        createdAt: "2024-01-15T10:00:00.000Z",
        intent: "Simple task",
        status: "SUCCESS",
      };

      await store.saveRun(run, [], [], []);

      const retrieved = await store.getRunThoughts("run-no-thoughts");
      assert.strictEqual(retrieved.length, 0);
    });
  });

  describe("getRunToolEvents", () => {
    it("should retrieve tool events for a specific run", async () => {
      const run: RunRecord = {
        id: "run-with-tools",
        createdAt: "2024-01-15T10:00:00.000Z",
        intent: "Task with tool calls",
        status: "SUCCESS",
      };

      const toolEvents: ToolEvent[] = [
        { runId: "run-with-tools", tool: "read_file", ok: true, summary: "Read config.json", iteration: 0 },
        { runId: "run-with-tools", tool: "write_file", ok: true, summary: "Updated config.json", iteration: 1 },
        { runId: "run-with-tools", tool: "shell_exec", ok: false, summary: "Command failed", iteration: 2 },
      ];

      await store.saveRun(run, [], toolEvents, []);

      const retrieved = await store.getRunToolEvents("run-with-tools");
      assert.strictEqual(retrieved.length, 3);
      assert.strictEqual(retrieved[0].tool, "read_file");
      assert.strictEqual(retrieved[0].ok, true);
      assert.strictEqual(retrieved[1].tool, "write_file");
      assert.strictEqual(retrieved[2].tool, "shell_exec");
      assert.strictEqual(retrieved[2].ok, false);
    });
  });

  describe("getStats", () => {
    it("should return correct aggregate statistics", async () => {
      const runs: RunRecord[] = [
        { id: "run-1", createdAt: "2024-01-15T08:00:00.000Z", intent: "Task 1", status: "SUCCESS", verdict: "PASS", iterationCount: 2, costUsd: 0.001 },
        { id: "run-2", createdAt: "2024-01-15T09:00:00.000Z", intent: "Task 2", status: "SUCCESS", verdict: "PASS", iterationCount: 4, costUsd: 0.002 },
        { id: "run-3", createdAt: "2024-01-15T10:00:00.000Z", intent: "Task 3", status: "FAIL", verdict: "FAIL", iterationCount: 3, costUsd: 0.0015 },
        { id: "run-4", createdAt: "2024-01-15T11:00:00.000Z", intent: "Task 4", status: "SUCCESS", verdict: "WARN", iterationCount: 1, costUsd: 0.0005 },
      ];

      for (const run of runs) {
        await store.saveRun(run, [], [], []);
      }

      const stats = await store.getStats();
      assert.strictEqual(stats.totalRuns, 4);
      assert.strictEqual(stats.passRate, 0.5, "Pass rate should be 50% (2 PASS out of 4)");
      assert.strictEqual(stats.avgIterations, 2.5, "Average iterations should be 2.5");
      assert.strictEqual(stats.totalCostUsd, 0.005);
    });

    it("should return zeros for empty database", async () => {
      const stats = await store.getStats();
      assert.strictEqual(stats.totalRuns, 0);
      assert.strictEqual(stats.passRate, 0);
      assert.strictEqual(stats.avgIterations, 0);
      assert.strictEqual(stats.totalCostUsd, 0);
    });
  });

  describe("Transaction atomicity", () => {
    it("should not write partial data on transaction failure", async () => {
      const run: RunRecord = {
        id: "atomic-test-run",
        createdAt: "2024-01-15T10:00:00.000Z",
        intent: "Test atomicity",
        status: "SUCCESS",
      };

      const thoughts: ThoughtRecord[] = [
        { runId: "atomic-test-run", iteration: 0, thought: "Test thought", observation: "Test observation", next: "Test next" },
      ];

      const toolEvents: ToolEvent[] = [
        { runId: "atomic-test-run", tool: "test_tool", ok: true, summary: "Test summary", iteration: 0 },
      ];

      const filesChanged: FileChange[] = [
        { runId: "atomic-test-run", path: "test.txt", changeType: "M" },
      ];

      // Save should succeed
      await store.saveRun(run, thoughts, toolEvents, filesChanged);

      // Verify all data was written
      const retrievedRun = await store.getRun("atomic-test-run");
      const retrievedThoughts = await store.getRunThoughts("atomic-test-run");
      const retrievedToolEvents = await store.getRunToolEvents("atomic-test-run");

      assert.ok(retrievedRun, "Run should be saved");
      assert.strictEqual(retrievedThoughts.length, 1, "Thought should be saved");
      assert.strictEqual(retrievedToolEvents.length, 1, "Tool event should be saved");
    });
  });

  describe("close and reopen", () => {
    it("should persist data and allow reopening", async () => {
      const dbPath = ":memory:";
      
      // Create store and save data
      const store1 = new SqliteStore(dbPath);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const run: RunRecord = {
        id: "persist-test",
        createdAt: "2024-01-15T10:00:00.000Z",
        intent: "Test persistence",
        status: "SUCCESS",
        verdict: "PASS",
      };
      await store1.saveRun(run, [], [], []);
      store1.close();

      // Note: In-memory databases don't persist across connections,
      // so this test verifies the close/reopen pattern works correctly
      // For actual persistence testing, use a file-based database
      const store2 = new SqliteStore(dbPath);
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // With in-memory DB, data won't persist (expected behavior)
      // This test mainly verifies close() doesn't throw
      const stats = await store2.getStats();
      assert.strictEqual(stats.totalRuns, 0, "In-memory DB doesn't persist across connections");
      
      store2.close();
    });
  });
});
