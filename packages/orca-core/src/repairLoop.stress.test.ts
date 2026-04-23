/**
 * Orca Core — Repair Loop Stress Tests
 *
 * Covers gaps not in repairLoop.test.ts (which has only one test):
 *   - maxPasses=1 exhausted → FAIL with correct summary
 *   - maxPasses=N, all passes fail → exhausted FAIL
 *   - WARN on first repair pass → exits immediately with SUCCESS
 *   - Budget stop mid-loop (after first repair pass)
 *   - Abort signal fired during a repair pass
 *   - repairTask becomes null mid-loop → early exit
 *   - Cost accumulation tracked across passes
 *   - Role hint preserved in all repair specs
 *   - initialErrorMessage appended to exhausted FAIL summary
 *   - initialGateBlockReason appended when no errorMessage
 *   - Context carries original task info on every repair spec
 *   - recordTrace is called at key checkpoints
 */

import { describe, it, expect, vi } from "vitest";
import { handleRepairLoop } from "./repairLoop.js";
import type { OrcaTaskSpec, OrcaRunCtx, MaestroPort, PappyPort } from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";
import { createChildPacket } from "./ahp/types.js";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<OrcaTaskSpec> = {}): OrcaTaskSpec {
  return {
    originalUserMessage: "do the thing",
    intent: "test",
    goals: ["produce output", "satisfy requirements"],
    permissions: {
      fileRead: true,
      fileWrite: true,
      shellExec: false,
      toolsAllowed: ["read_file", "write_file"],
    },
    outputFormat: "prose",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<OrcaRunCtx> = {}): OrcaRunCtx {
  return {
    llm: { complete: vi.fn(async () => ({ text: "llm response" })) },
    runId: "repair-stress-run",
    recordTrace: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

function makeEmitter() {
  return { emit: vi.fn() } as any;
}

function makeFailResult(repairTask = "Fix the issues"): PappyResult {
  return {
    verdict: "FAIL",
    confidence: 0.4,
    summary: "fail summary",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [
      {
        issueId: "STRESS:001",
        severity: "HIGH",
        code: "STRESS_HIGH",
        category: "Completeness",
        description: "critical issue",
        expected_receipt: "none",
        evidence: "test",
        fix_hint: "fix it",
        message: "critical",
        suggestedFix: "add more content",
      },
    ],
    repair_task: { title: repairTask, steps: ["step 1"], required_proofs: [] },
    internalSummary: "verdict=FAIL 1xHIGH",
    repairTask,
  };
}

function makePassResult(): PappyResult {
  return {
    verdict: "PASS",
    confidence: 1.0,
    summary: "pass",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [],
    repair_task: null,
    internalSummary: "verdict=PASS no_issues",
  };
}

function makeWarnResult(): PappyResult {
  return {
    verdict: "WARN",
    confidence: 0.8,
    summary: "warn",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [
      {
        issueId: "STRESS:warn",
        severity: "MEDIUM",
        code: "STRESS_MEDIUM",
        category: "Completeness",
        description: "medium issue",
        expected_receipt: "none",
        evidence: "test",
        fix_hint: "look again",
        message: "medium",
      },
    ],
    repair_task: null,
    internalSummary: "verdict=WARN 1xMEDIUM",
  };
}

// ===========================================================================
// 1. Exhaustion scenarios
// ===========================================================================

describe("repair loop exhaustion", () => {
  it("returns FAIL after maxPasses=1 when repair still fails", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "still wrong" })),
    };
    const pappy: PappyPort = {
      evaluate: vi.fn(() => makeFailResult()),
    };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      1, // maxPasses
    );

    expect(result.status).toBe("FAIL");
    expect(result.summary).toContain("1 repair pass");
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns FAIL after maxPasses=3 when all passes fail", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "still wrong" })),
    };
    const pappy: PappyPort = {
      evaluate: vi.fn(() => makeFailResult()),
    };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3, // maxPasses
    );

    expect(result.status).toBe("FAIL");
    expect(result.summary).toContain("3 repair pass");
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("preserves lastOutputText from the final repair pass even on exhausted FAIL", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: vi.fn(async () => {
        callCount++;
        return { outputText: `pass-${callCount}-output` };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      2,
      "seed-output",
    );

    // The last maestro call was pass 2
    expect(result.userFacingText).toBe("pass-2-output");
  });

  it("appends initialErrorMessage to exhausted FAIL summary", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      1,
      undefined,  // initialOutputText
      undefined,  // role
      undefined,  // budgetUsd
      undefined,  // spentSoFar
      "timeout after 30s", // initialErrorMessage
    );

    expect(result.summary).toContain("timeout after 30s");
  });

  it("appends initialGateBlockReason when no errorMessage", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,  // no errorMessage
      "blocked by compliance gate", // gateBlockReason
    );

    expect(result.summary).toContain("blocked by compliance gate");
  });
});

// ===========================================================================
// 2. Early exit on PASS / WARN
// ===========================================================================

describe("repair loop early exit", () => {
  it("exits on PASS from first repair pass and returns SUCCESS", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "fixed output", metadata: { costUsd: 0.001 } })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePassResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,
    );

    expect(result.status).toBe("SUCCESS");
    expect(result.userFacingText).toBe("fixed output");
    // Only one Maestro call needed
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("exits on WARN from first repair pass and returns SUCCESS", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "partial fix" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeWarnResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,
    );

    expect(result.status).toBe("SUCCESS");
    expect(result.userFacingText).toBe("partial fix");
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("stops early on pass 2 when repairTask becomes null", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: vi.fn(async () => {
        callCount++;
        return { outputText: `output-${callCount}` };
      }),
    };

    // Pass 1: FAIL with repairTask → continue
    // Pass 2: FAIL without repairTask → break early
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makeFailResult("fix it"))
        .mockReturnValueOnce({
          ...makeFailResult(),
          repair_task: null,
          repairTask: undefined,
        }),
    };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,
    );

    // Loop breaks at pass 2 because repairTask is null
    expect(callCount).toBe(2);
    expect(result.status).toBe("FAIL");
  });
});

// ===========================================================================
// 3. Budget enforcement during repair
// ===========================================================================

describe("budget enforcement in repair loop", () => {
  it("stops repair loop when accumulated spend >= budget", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: vi.fn(async () => {
        callCount++;
        // Each repair pass costs $0.03
        return { outputText: "still bad", metadata: { costUsd: 0.03 } };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    // Budget $0.05, initial spend $0.04, first repair costs $0.03 → budget hit after pass 1
    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,         // maxPasses
      "seed",    // initialOutputText
      undefined, // originalRole
      0.05,      // budgetUsd
      0.04,      // spentSoFarUsd (already close to limit)
    );

    // First pass runs (0.04 < 0.05), second is skipped (0.07 >= 0.05)
    expect(callCount).toBe(1);
    expect(result.status).toBe("WARN");
    expect(result.summary).toContain("Budget cap");
  });

  it("returns WARN with correct spend/budget amounts in summary", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({
        outputText: "bad",
        metadata: { costUsd: 0.10 },
      })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,
      "seed",
      undefined,
      0.10,  // budgetUsd
      0.01,  // spentSoFarUsd — pass 1 will push total to $0.11 >= $0.10
    );

    expect(result.status).toBe("WARN");
    // Summary should reference the budget ceiling
    expect(result.summary).toMatch(/\$0\.10/);
  });

  it("skips ALL passes when initial spend already exceeds budget", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "unreachable" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      3,
      "initial-output",
      undefined,
      0.05,  // budget
      0.10,  // already over budget
    );

    // Maestro should never be called
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(result.status).toBe("WARN");
    expect(result.userFacingText).toBe("initial-output");
  });
});

// ===========================================================================
// 4. Abort handling
// ===========================================================================

describe("abort handling in repair loop", () => {
  it("throws AbortError when signal is already aborted before loop starts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "unreachable" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePassResult()) };
    const ctx = makeCtx({ abortSignal: controller.signal });

    await expect(
      handleRepairLoop(
        makeTask(),
        makeFailResult(),
        ctx,
        maestro,
        pappy,
        makeEmitter(),
        2,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("throws AbortError when signal fires during a repair pass", async () => {
    const controller = new AbortController();

    const maestro: MaestroPort = {
      run: vi.fn(async (_task, ctx) => {
        // Abort mid-pass
        controller.abort(new Error("user cancelled"));
        // Simulate the adapter checking abortSignal
        if (ctx.abortSignal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }
        return { outputText: "unreachable" };
      }),
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePassResult()) };
    const ctx = makeCtx({ abortSignal: controller.signal });

    await expect(
      handleRepairLoop(
        makeTask(),
        makeFailResult(),
        ctx,
        maestro,
        pappy,
        makeEmitter(),
        2,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ===========================================================================
// 5. Repair spec shape correctness
// ===========================================================================

describe("repair spec correctness", () => {
  it("sets intent='repair' on every repair spec", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "still bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 2);

    for (const spec of capturedSpecs) {
      expect(spec.intent).toBe("repair");
    }
  });

  it("preserves original goals in repair spec goals", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const originalTask = makeTask({ goals: ["produce output", "satisfy requirements"] });

    await handleRepairLoop(originalTask, makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 1);

    const repairGoals = capturedSpecs[0]?.goals ?? [];
    expect(repairGoals).toContain("produce output");
    expect(repairGoals).toContain("satisfy requirements");
    expect(repairGoals).toHaveLength(2);
  });

  it("prefers the latest QC repairTask over prior AHP repair prompts", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "still bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const poisonedPacket = createChildPacket("root", {
      id: "repair-child",
      objective: "Repair prior attempt",
      expectedOutput: { schema: {}, acceptanceCriteria: [] },
    });
    poisonedPacket.repairPrompt = "POISONED_REPAIR_PROMPT";

    await handleRepairLoop(
      makeTask(),
      makeFailResult("LATEST_QC_REPAIR_TASK"),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      poisonedPacket,
    );

    expect(capturedSpecs[0]?.originalUserMessage).toContain("LATEST_QC_REPAIR_TASK");
    expect(capturedSpecs[0]?.originalUserMessage).not.toContain("POISONED_REPAIR_PROMPT");
  });

  it("includes role hint in originalUserMessage when originalRole is given", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      1,
      undefined,
      "reviewer", // originalRole
    );

    expect(capturedSpecs[0]?.originalUserMessage).toContain("reviewer");
  });

  it("carries original task intent in repair spec context", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const originalTask = makeTask({ intent: "write-feature-X" });

    await handleRepairLoop(originalTask, makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 1);

    const repairContext = capturedSpecs[0]?.context?.["repair"] as any;
    expect(repairContext?.original?.intent).toBe("write-feature-X");
    expect(repairContext?.original?.message).toBe("do the thing");
  });

  it("includes issue codes in repair context on every pass", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    let callCount = 0;
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        callCount++;
        capturedSpecs.push(task);
        return { outputText: "still bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult("keep fixing")) };

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 2);

    for (const spec of capturedSpecs) {
      const repairCtx = spec.context?.["repair"] as any;
      expect(Array.isArray(repairCtx?.issues)).toBe(true);
      expect(repairCtx.issues.length).toBeGreaterThan(0);
    }
  });

  it("preserves permissions and outputFormat on every repair pass", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "bad" };
      }),
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makeFailResult("fix 1"))
        .mockReturnValueOnce(makeFailResult("fix 2"))
        .mockReturnValueOnce(makePassResult()),
    };

    const originalTask = makeTask({
      permissions: {
        fileRead: true,
        fileWrite: false,
        shellExec: false,
        toolsAllowed: ["read_file"],
      },
      outputFormat: "code",
    });

    await handleRepairLoop(originalTask, makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 3);

    for (const spec of capturedSpecs) {
      expect(spec.permissions).toEqual(originalTask.permissions);
      expect(spec.outputFormat).toBe("code");
    }
  });

  it("increments pass number in repair context on each pass", async () => {
    const capturedSpecs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: vi.fn(async (task) => {
        capturedSpecs.push(task);
        return { outputText: "bad" };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, makeEmitter(), 3);

    for (let i = 0; i < capturedSpecs.length; i++) {
      const repairCtx = capturedSpecs[i]?.context?.["repair"] as any;
      expect(repairCtx?.pass).toBe(i + 1);
      expect(repairCtx?.maxPasses).toBe(3);
    }
  });
});

// ===========================================================================
// 6. Cost accumulation
// ===========================================================================

describe("cost accumulation", () => {
  it("accumulates cost across repair passes before checking budget", async () => {
    // Budget $0.10. Initial spent $0.02. Each repair pass costs $0.04.
    // After pass 1: spent = 0.06 < 0.10 → continue
    // After pass 2: spent = 0.10 >= 0.10 → stop
    let callCount = 0;
    const maestro: MaestroPort = {
      run: vi.fn(async () => {
        callCount++;
        return { outputText: "bad", metadata: { costUsd: 0.04 } };
      }),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    const result = await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx(),
      maestro,
      pappy,
      makeEmitter(),
      5,       // maxPasses — would allow 5 without budget
      "seed",
      undefined,
      0.10,   // budgetUsd
      0.02,   // spentSoFarUsd
    );

    // Pass 1 runs: 0.02 + 0.04 = 0.06 < 0.10
    // Pass 2 runs: 0.06 + 0.04 = 0.10 >= 0.10 → WARN
    expect(callCount).toBe(2);
    expect(result.status).toBe("WARN");
  });
});

// ===========================================================================
// 7. Event emission from repair loop
// ===========================================================================

describe("event emission", () => {
  it("emits repair:start for each pass", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };
    const emitter = makeEmitter();

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, emitter, 2);

    const repairStartEmits = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: any[]) => call[0]?.type === "repair:start");
    expect(repairStartEmits).toHaveLength(2);
    expect(repairStartEmits[0]![0]!.pass).toBe(1);
    expect(repairStartEmits[1]![0]!.pass).toBe(2);
  });

  it("emits maestro:start + maestro:done for each repair pass", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };
    const emitter = makeEmitter();

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, emitter, 2);

    const emitCalls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]?.type);
    const maestroStarts = emitCalls.filter((t: string) => t === "maestro:start");
    const maestroDones = emitCalls.filter((t: string) => t === "maestro:done");

    expect(maestroStarts).toHaveLength(2);
    expect(maestroDones).toHaveLength(2);
  });

  it("emits qc:result with isRepair=true for each pass", async () => {
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makeFailResult())
        .mockReturnValueOnce(makePassResult()),
    };
    const emitter = makeEmitter();

    await handleRepairLoop(makeTask(), makeFailResult(), makeCtx(), maestro, pappy, emitter, 2);

    const qcEvents = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: any[]) => call[0]?.type === "qc:result")
      .map((call: any[]) => call[0]!);

    expect(qcEvents).toHaveLength(2);
    for (const e of qcEvents) {
      expect(e.isRepair).toBe(true);
    }
  });
});

// ===========================================================================
// 8. recordTrace calls
// ===========================================================================

describe("recordTrace calls", () => {
  it("calls recordTrace with repair.pass.spec on every pass", async () => {
    const recordTrace = vi.fn();
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx({ recordTrace }),
      maestro,
      pappy,
      makeEmitter(),
      2,
    );

    const passSpecCalls = recordTrace.mock.calls.filter(
      (call) => call[0] === "repair.pass.spec",
    );
    expect(passSpecCalls).toHaveLength(2);
  });

  it("calls recordTrace with repair.exhausted after all passes fail", async () => {
    const recordTrace = vi.fn();
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "bad" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makeFailResult()) };

    await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx({ recordTrace }),
      maestro,
      pappy,
      makeEmitter(),
      1,
    );

    const exhaustedCall = recordTrace.mock.calls.find(
      (call) => call[0] === "repair.exhausted",
    );
    expect(exhaustedCall).toBeDefined();
  });

  it("calls recordTrace with repair.pass.success when a pass succeeds", async () => {
    const recordTrace = vi.fn();
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({ outputText: "fixed" })),
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePassResult()) };

    await handleRepairLoop(
      makeTask(),
      makeFailResult(),
      makeCtx({ recordTrace }),
      maestro,
      pappy,
      makeEmitter(),
      2,
    );

    const successCall = recordTrace.mock.calls.find(
      (call) => call[0] === "repair.pass.success",
    );
    expect(successCall).toBeDefined();
  });
});
