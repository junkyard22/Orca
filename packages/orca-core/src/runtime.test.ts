/**
 * Orca Core — Runtime Unit Tests
 *
 * Tests createOrcaRuntime() and the execution flow with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrcaRuntime } from "./runtime.js";
import { AHPLifecycle, appendAHPTrace, createChildPacket } from "./ahp/types.js";
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

function createAbortError(message = "Stopped."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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

    it("derives filesChanged from successful write_file tool events before QC and persistence", async () => {
      const pappy = {
        evaluate: vi.fn(() => createMockPappyResult("PASS")),
      } satisfies PappyPort;

      const store = {
        saveRun: vi.fn(),
        getRecentRuns: vi.fn(() => []),
        getRun: vi.fn(() => null),
        getRunThoughts: vi.fn(() => []),
        getRunToolEvents: vi.fn(() => []),
        searchRuns: vi.fn(() => []),
        getStats: vi.fn(() => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 })),
        close: vi.fn(),
      };

      const maestro: MaestroPort = {
        run: async () => ({
          outputText: "Created tmp-test/prompt2-calculator.py.",
          summary: "mock summary",
          toolEvents: [
            {
              tool: "write_file",
              ok: true,
              summary: "write_file: ok (42 chars)",
              raw: { path: "tmp-test/prompt2-calculator.py" },
            },
          ],
        }),
      };

      const runtime = createOrcaRuntime({
        maestro,
        pappy,
        llm: createMockLLM(),
        store: store as any,
      });

      const result = await runtime.executeTask(createTaskSpec({
        originalUserMessage: "Create tmp-test/prompt2-calculator.py",
      }));

      const qcInput = pappy.evaluate.mock.calls[0]?.[0];
      expect(qcInput?.filesChanged).toEqual([
        { path: "tmp-test/prompt2-calculator.py", changeType: "M" },
      ]);

      const savedFiles = store.saveRun.mock.calls[0]?.[3];
      expect(savedFiles).toEqual([
        expect.objectContaining({
          path: "tmp-test/prompt2-calculator.py",
          changeType: "M",
        }),
      ]);

      const artifacts = result.artifacts as { filesChanged?: Array<{ path: string; changeType: string }>; metadata?: { filesChanged?: Array<{ path: string; changeType: string }> } };
      expect(artifacts.filesChanged).toEqual([
        { path: "tmp-test/prompt2-calculator.py", changeType: "M" },
      ]);
      expect(artifacts.metadata?.filesChanged).toEqual([
        { path: "tmp-test/prompt2-calculator.py", changeType: "M" },
      ]);
    });

    it("verifies explicit child AHP packets returned by Maestro", async () => {
      const pappy = {
        evaluate: vi.fn(() => createMockPappyResult("PASS")),
      } satisfies PappyPort;

      const maestro: MaestroPort = {
        run: async (_task, ctx) => {
          if (!ctx.ahpRootPacket) {
            throw new Error("missing root AHP packet");
          }
          const child = createChildPacket(ctx.ahpRootPacket.id, {
            id: `${ctx.runId}_reviewer_0`,
            objective: "Review the audit result",
            expectedOutput: {
              schema: {},
              acceptanceCriteria: ["Output mentions audit"],
            },
          });
          child.lifecycle = AHPLifecycle.COMPLETE;
          appendAHPTrace(child, {
            timestamp: new Date().toISOString(),
            state: AHPLifecycle.COMPLETE,
            actor: "reviewer",
            note: "review worker completed",
          });

          return {
            outputText: "Audit result verified.",
            summary: "mock summary",
            ahpChildPackets: [child],
          };
        },
      };

      const runtime = createOrcaRuntime({
        maestro,
        pappy,
        llm: createMockLLM(),
      });

      const result = await runtime.executeTask(createTaskSpec({
        originalUserMessage: "Audit the app",
        goals: ["Output mentions audit"],
      }));

      const child = result.ahpChildPackets?.[0];
      expect(child?.verdict).toBeDefined();
      expect(child?.trace.some((entry) => entry.actor === "pappy")).toBe(true);
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

  describe("Pipeline trace", () => {
    it("writes a structured trace for a completed run", async () => {
      const maestro = createMockMaestro("Task completed successfully");
      const pappy = {
        evaluate: vi.fn(() => createMockPappyResult("PASS")),
      } satisfies PappyPort;
      const writeTrace = vi.fn();
      const runtime = createOrcaRuntime({
        maestro,
        pappy,
        llm: createMockLLM(),
        writeTrace,
      });

      await runtime.executeTask(createTaskSpec());

      expect(writeTrace).toHaveBeenCalledTimes(1);
      const trace = writeTrace.mock.calls[0]?.[0] as any;
      expect(trace.task.intent).toBe("test");
      expect(trace.entries.map((entry: any) => entry.stage)).toEqual(
        expect.arrayContaining(["task.received", "maestro.run.result", "qc.run.result", "task.completed"]),
      );
      expect(trace.finalResult?.status).toBe("SUCCESS");
      expect(trace.finalResult?.qcVerdict).toBe("PASS");
    });
  });

  describe("Abort handling", () => {
    it("propagates abort errors and skips persistence", async () => {
      const store = {
        saveRun: vi.fn(),
        close: vi.fn(),
      };
      const writeTrace = vi.fn();

      const maestro: MaestroPort = {
        run: async (_task, ctx) => {
          if (ctx.abortSignal?.aborted) {
            throw createAbortError();
          }
          await new Promise((_, reject) => {
            ctx.abortSignal?.addEventListener("abort", () => reject(createAbortError()), { once: true });
          });
          return { outputText: "unreachable" };
        },
      };

      const runtime = createOrcaRuntime({
        maestro,
        pappy: createMockPappy("PASS"),
        llm: createMockLLM(),
        store: store as any,
        writeTrace,
      });

      const controller = new AbortController();
      const task = runtime.executeTask(createTaskSpec(), { abortSignal: controller.signal });
      controller.abort(new Error("Stopped."));

      await expect(task).rejects.toMatchObject({ name: "AbortError" });
      expect(store.saveRun).not.toHaveBeenCalled();
      expect(writeTrace).toHaveBeenCalledTimes(1);
      expect(writeTrace.mock.calls[0]?.[0]?.finalResult?.status).toBe("ABORTED");
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
