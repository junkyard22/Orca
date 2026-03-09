/**
 * Orca Core — Runtime Unit Tests
 *
 * Tests createOrcaRuntime() and the execution flow with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrcaRuntime } from "./runtime.js";
import type { PappyResult } from "@clawde/pappy-core";
import type { OrcaRuntime, OrcaRuntimeDeps, OrcaTaskSpec, OrcaExecutionResult, MaestroPort, PappyPort, OrcaEvent } from "./types.js";

// Mock types
interface MockMaestroPort extends MaestroPort {
  outputToReturn: string;
  shouldThrow: boolean;
}

interface MockPappyPort extends PappyPort {
  verdictToReturn: "PASS" | "WARN" | "FAIL";
  repairTaskToReturn?: string;
  callCount: number;
}

function createMockMaestro(output: string, shouldThrow = false): MockMaestroPort {
  return {
    outputToReturn: output,
    shouldThrow,
    run: async (_task: OrcaTaskSpec, _ctx: unknown) => {
      if (shouldThrow) {
        throw new Error("Maestro runtime error");
      }
      return { outputText: output, summary: "mock summary" };
    },
  };
}

function createMockPappyResult(
  verdict: "PASS" | "WARN" | "FAIL",
  repairTask?: string,
): PappyResult {
  return {
    verdict,
    confidence: 1.0,
    summary: `Summary for ${verdict}`,
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: verdict === "FAIL" ? [{
      issueId: "TEST:123",
      severity: "HIGH",
      code: "TEST",
      category: "Completeness",
      description: "test issue",
      expected_receipt: "test",
      evidence: "test",
      fix_hint: "test fix",
      message: "test message",
    }] : [],
    repair_task: repairTask ? { title: repairTask, steps: ["step 1"], required_proofs: [] } : null,
    internalSummary: `verdict=${verdict}`,
  };
}

function createMockPappy(
  verdict: "PASS" | "WARN" | "FAIL",
  repairTask?: string,
): MockPappyPort {
  return {
    verdictToReturn: verdict,
    repairTaskToReturn: repairTask,
    callCount: 0,
    evaluate: (input) => {
      // Track call count for repair loop tests
      (input as unknown as MockPappyPort).callCount++;
      return createMockPappyResult(verdict, repairTask);
    },
  };
}

function createMockLLM() {
  return {
    complete: async (prompt: string) => ({ text: `response to: ${prompt}` }),
  };
}

function createBasicDeps(
  maestro: MockMaestroPort,
  pappy: MockPappyPort,
): OrcaRuntimeDeps {
  return {
    maestro,
    pappy,
    llm: createMockLLM(),
    maxRepairPasses: 2,
  };
}

function createTaskSpec(overrides: Partial<OrcaTaskSpec> = {}): OrcaTaskSpec {
  return {
    originalUserMessage: "Test task",
    intent: "test",
    goals: ["Test goal"],
    ...overrides,
  };
}

// Event recorder helper
function createEventRecorder() {
  const events: OrcaEvent[] = [];
  return {
    events,
    record: (event: OrcaEvent) => events.push(event),
    getTypes: () => events.map((e) => e.type),
    findByType: <T extends OrcaEvent["type"]>(type: T) =>
      events.filter((e) => e.type === type) as Extract<OrcaEvent, { type: T }>[],
  };
}

describe("createOrcaRuntime", () => {
  describe("SUCCESS path — maestro returns output, pappy returns PASS", () => {
    it("returns status SUCCESS with userFacingText", async () => {
      const maestro = createMockMaestro("Task completed successfully");
      const pappy = createMockPappy("PASS");
      const runtime = createOrcaRuntime(createBasicDeps(maestro, pappy));

      const result = await runtime.executeTask(createTaskSpec());

      expect(result.status).toBe("SUCCESS");
      expect(result.userFacingText).toBe("Task completed successfully");
    });
  });

  describe("WARN path — maestro returns output, pappy returns WARN", () => {
    it("returns status SUCCESS (WARN is not a failure)", async () => {
      const maestro = createMockMaestro("Task completed with warnings");
      const pappy = createMockPappy("WARN");
      const runtime = createOrcaRuntime(createBasicDeps(maestro, pappy));

      const result = await runtime.executeTask(createTaskSpec());

      expect(result.status).toBe("SUCCESS");
      expect(result.userFacingText).toBe("Task completed with warnings");
    });
  });

  describe("FAIL without repairTask — pappy returns FAIL, no repairTask", () => {
    it("returns status FAIL immediately, no repair attempted", async () => {
      const maestro = createMockMaestro("Task failed");
      const pappy = createMockPappy("FAIL", undefined); // No repair task
      const runtime = createOrcaRuntime(createBasicDeps(maestro, pappy));

      const result = await runtime.executeTask(createTaskSpec());

      expect(result.status).toBe("FAIL");
      expect(result.userFacingText).toBe("Task failed");
    });
  });

  describe("FAIL with repair — pappy returns FAIL with repairTask", () => {
    it("returns FAIL when repair passes exhausted (maxRepairPasses=0)", async () => {
      const maestro = createMockMaestro("Task failed");
      const pappy = createMockPappy("FAIL", "Fix the issue");
      const runtime = createOrcaRuntime({
        ...createBasicDeps(maestro, pappy),
        maxRepairPasses: 0, // No repair passes allowed
      });

      const result = await runtime.executeTask(createTaskSpec());

      // With maxRepairPasses=0, should fail immediately without repair
      expect(result.status).toBe("FAIL");
    });
  });

  describe("Event emission — verify all expected events fire in order", () => {
    it("emits task:start → maestro:start → maestro:done → qc:result → task:done", async () => {
      const maestro = createMockMaestro("Task completed");
      const pappy = createMockPappy("PASS");
      const runtime = createOrcaRuntime(createBasicDeps(maestro, pappy));

      const recorder = createEventRecorder();
      runtime.on("task:start", recorder.record);
      runtime.on("maestro:start", recorder.record);
      runtime.on("maestro:done", recorder.record);
      runtime.on("qc:result", recorder.record);
      runtime.on("task:done", recorder.record);

      await runtime.executeTask(createTaskSpec());

      const eventTypes = recorder.getTypes();
      expect(eventTypes).toContain("task:start");
      expect(eventTypes).toContain("maestro:start");
      expect(eventTypes).toContain("maestro:done");
      expect(eventTypes).toContain("qc:result");
      expect(eventTypes).toContain("task:done");

      // Verify order
      const startIdx = eventTypes.indexOf("task:start");
      const maestroStartIdx = eventTypes.indexOf("maestro:start");
      const maestroDoneIdx = eventTypes.indexOf("maestro:done");
      const qcResultIdx = eventTypes.indexOf("qc:result");
      const doneIdx = eventTypes.indexOf("task:done");

      expect(startIdx).toBeLessThan(maestroStartIdx);
      expect(maestroStartIdx).toBeLessThan(maestroDoneIdx);
      expect(maestroDoneIdx).toBeLessThan(qcResultIdx);
      expect(qcResultIdx).toBeLessThan(doneIdx);
    });
  });

  describe("Runtime error — maestro.run() throws", () => {
    it("returns status FAIL with error in summary, does not throw", async () => {
      const maestro = createMockMaestro("", true); // shouldThrow = true
      const pappy = createMockPappy("PASS");
      const runtime = createOrcaRuntime(createBasicDeps(maestro, pappy));

      const result = await runtime.executeTask(createTaskSpec());

      expect(result.status).toBe("FAIL");
      expect(result.summary).toContain("Runtime error");
    });
  });

  describe("QC disabled mode — no pappy provided", () => {
    it("returns SUCCESS immediately after maestro completes", async () => {
      const maestro = createMockMaestro("Direct output");
      const runtime = createOrcaRuntime({
        maestro,
        llm: createMockLLM(),
        // pappy is undefined - QC disabled
      });

      const result = await runtime.executeTask(createTaskSpec());

      expect(result.status).toBe("SUCCESS");
      expect(result.userFacingText).toBe("Direct output");
    });
  });
});