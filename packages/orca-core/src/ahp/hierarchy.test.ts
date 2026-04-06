/**
 * Orca Core — AHP Root/Child Packet Hierarchy Tests
 *
 * Verifies that runtime.ts creates, populates, and finalizes the root AHP
 * packet correctly for single-run tasks (Option A) and for legacy maestro
 * results that carry a pre-hierarchy `ahpPacket`.
 */

import { describe, it, expect } from "vitest";
import { createOrcaRuntime } from "../runtime.js";
import type { MaestroPort, OrcaTaskSpec, OrcaRuntimeDeps, PappyPort } from "../types.js";
import type { AHPPacket } from "./types.js";
import { AHPLifecycle, AHPPacketRole } from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";

// ---------------------------------------------------------------------------
// Shared helpers (mirror the patterns in runtime.test.ts)
// ---------------------------------------------------------------------------

function makePassPappyResult(): PappyResult {
  return {
    verdict: "PASS",
    confidence: 1.0,
    summary: "All good",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [],
    repair_task: null,
    internalSummary: "verdict=PASS",
  };
}

function makeFailPappyResult(): PappyResult {
  return {
    verdict: "FAIL",
    confidence: 0.1,
    summary: "Something failed",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [{
      issueId: "TEST:001",
      severity: "HIGH" as const,
      code: "TEST",
      category: "Completeness",
      description: "test failure",
      expected_receipt: "n/a",
      evidence: "n/a",
      fix_hint: "fix it",
      message: "test fail message",
    }],
    repair_task: null,
    internalSummary: "verdict=FAIL",
  };
}

function makeWarnPappyResult(): PappyResult {
  return {
    verdict: "WARN",
    confidence: 0.7,
    summary: "Completed with warnings",
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues: [],
    repair_task: null,
    internalSummary: "verdict=WARN",
  };
}

/** Maestro that returns a simple text output with no AHP packet. */
function simpleMaestro(outputText = "done"): MaestroPort {
  return {
    run: async () => ({ outputText, summary: "mock summary" }),
  };
}

/** Maestro that returns an ahpPacket (legacy or explicit child). */
function maestroWithPacket(
  outputText: string,
  ahpPacket: AHPPacket,
): MaestroPort {
  return {
    run: async () => ({ outputText, summary: "mock summary", ahpPacket }),
  };
}

/** Maestro that returns ahpChildPackets list. */
function maestroWithChildPackets(
  outputText: string,
  ahpChildPackets: AHPPacket[],
): MaestroPort {
  return {
    run: async () => ({ outputText, summary: "mock summary", ahpChildPackets }),
  };
}

/**
 * Build a bare AHPPacket without parentPacketId to simulate a legacy Maestro
 * adapter that pre-dates hierarchy support (parentPacketId is undefined).
 * The runtime is expected to hydrate parentPacketId at finalization time.
 */
function makeLegacyChildPacket(id: string, lifecycle = AHPLifecycle.COMPLETE): AHPPacket {
  const now = new Date().toISOString();
  return {
    id,
    objective: `Legacy child ${id}`,
    lifecycle,
    role: AHPPacketRole.Child,
    // parentPacketId intentionally absent — runtime should hydrate it
    inputs: [],
    constraints: [],
    expectedOutput: { schema: {}, acceptanceCriteria: [] },
    trace: [],
    meta: { createdAt: now, updatedAt: now, ackRequired: false },
  };
}

function makePappy(result: PappyResult): PappyPort {
  return { evaluate: () => result };
}

function makeDeps(
  maestro: MaestroPort,
  pappyResult: PappyResult = makePassPappyResult(),
): OrcaRuntimeDeps {
  return {
    maestro,
    pappy: makePappy(pappyResult),
    llm: { complete: async (p: string) => ({ text: `response to: ${p}` }) },
    maxRepairPasses: 0,
  };
}

function makeTask(overrides: Partial<OrcaTaskSpec> = {}): OrcaTaskSpec {
  return {
    originalUserMessage: "hierarchy test task",
    intent: "test hierarchy",
    goals: ["verify AHP packet structure"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Root packet — existence and basic shape
// ---------------------------------------------------------------------------

describe("AHP root packet — existence", () => {
  it("result.ahpRootPacket is defined for every run", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket).toBeDefined();
  });

  it("root packet id ends with _root", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.id).toMatch(/_root$/);
  });

  it("root packet role is Root", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.role).toBe(AHPPacketRole.Root);
  });

  it("root packet has no parentPacketId", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.parentPacketId).toBeUndefined();
  });

  it("root packet objective reflects the task intent", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(
      makeTask({ intent: "write a sorting algorithm" }),
    );
    expect(result.ahpRootPacket!.objective).toBe("write a sorting algorithm");
  });
});

// ---------------------------------------------------------------------------
// Root packet — lifecycle finalization (Option A)
// ---------------------------------------------------------------------------

describe("AHP root packet — lifecycle finalization (Option A, no children)", () => {
  it("lifecycle is COMPLETE when result is SUCCESS", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro(), makePassPappyResult()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.status).toBe("SUCCESS");
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.COMPLETE);
  });

  it("lifecycle is COMPLETE when Pappy verdict is WARN (maps to SUCCESS status, AHP COMPLETE)", async () => {
    // Pappy WARN verdict → execution result status = SUCCESS (WARN is not a failure).
    // The AHP root lifecycle should still be COMPLETE for any non-FAIL result.
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro(), makeWarnPappyResult()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.status).toBe("SUCCESS"); // WARN verdict from pappy → SUCCESS status
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.COMPLETE);
  });

  it("lifecycle is COMPLETE when result is WARN via budget-exceeded path", async () => {
    // Budget-exceeded path: Pappy says FAIL with a repairTask, but spend >= budget.
    // The runtime skips repair and returns WARN → AHP root lifecycle COMPLETE.
    const budgetMaestro: MaestroPort = {
      run: async () => ({ outputText: "partial work", summary: "ran over budget", metadata: { costUsd: 1.0 } }),
    };
    const failWithRepair: PappyResult = {
      verdict: "FAIL",
      confidence: 0.2,
      summary: "needs repair but budget exceeded",
      acceptance_criteria: [],
      claims: [],
      receipt_ledger: [],
      issues: [{
        issueId: "BUDGET:001",
        severity: "HIGH" as const,
        code: "BUDGET",
        category: "Completeness",
        description: "incomplete",
        expected_receipt: "n/a",
        evidence: "n/a",
        fix_hint: "redo",
        message: "incomplete output",
      }],
      // repair_task must be present so the "no repairTask → FAIL" branch is skipped.
      // repairTask (string) is the deprecated field the runtime actually checks.
      repair_task: { title: "Fix the incomplete output", steps: ["step 1"], required_proofs: [] },
      repairTask: "Fix the incomplete output",
      internalSummary: "verdict=FAIL",
    };
    const deps = {
      maestro: budgetMaestro,
      pappy: makePappy(failWithRepair),
      llm: { complete: async (p: string) => ({ text: `response to: ${p}` }) },
      maxRepairPasses: 2,
      budgetUsd: 0.50, // spend (1.0) >= budget (0.50) → WARN path
    };
    const runtime = createOrcaRuntime(deps);
    const result  = await runtime.executeTask(makeTask());
    expect(result.status).toBe("WARN");
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.COMPLETE);
  });

  it("lifecycle is FAILED when result is FAIL", async () => {
    // maxRepairPasses=0 so no repair loop — straight FAIL
    const deps    = makeDeps(simpleMaestro("output"), makeFailPappyResult());
    const runtime = createOrcaRuntime({ ...deps, maxRepairPasses: 0 });
    const result  = await runtime.executeTask(makeTask());
    expect(result.status).toBe("FAIL");
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.FAILED);
  });

  it("runtime re-throws AbortError (the abort path does not swallow the error)", async () => {
    // When maestro throws an AbortError the runtime sets abortError and then
    // re-throws it after finalizing the AHP packet.  The AHP INCONCLUSIVE lifecycle
    // is recorded internally; from the outside the run rejects with AbortError.
    const abortingMaestro: MaestroPort = {
      run: async () => {
        const err  = new Error("Stopped.");
        err.name   = "AbortError";
        throw err;
      },
    };
    const runtime = createOrcaRuntime(makeDeps(abortingMaestro));
    await expect(runtime.executeTask(makeTask())).rejects.toMatchObject({
      name:    "AbortError",
      message: "Stopped.",
    });
  });
});

// ---------------------------------------------------------------------------
// Root packet — timestamps and trace
// ---------------------------------------------------------------------------

describe("AHP root packet — trace and timestamps", () => {
  it("root packet trace has at least two entries (RUNNING + terminal)", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.trace.length).toBeGreaterThanOrEqual(2);
  });

  it("first trace entry state is RUNNING", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.trace[0].state).toBe(AHPLifecycle.RUNNING);
  });

  it("last trace entry state matches the final lifecycle", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    const trace   = result.ahpRootPacket!.trace;
    expect(trace[trace.length - 1].state).toBe(result.ahpRootPacket!.lifecycle);
  });

  it("meta.startedAt is set and is a valid ISO date", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    const { startedAt } = result.ahpRootPacket!.meta;
    expect(startedAt).toBeDefined();
    expect(() => new Date(startedAt!)).not.toThrow();
  });

  it("meta.completedAt is set and is a valid ISO date", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    const { completedAt } = result.ahpRootPacket!.meta;
    expect(completedAt).toBeDefined();
    expect(() => new Date(completedAt!)).not.toThrow();
  });

  it("meta.startedAt is before meta.completedAt", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    const { startedAt, completedAt } = result.ahpRootPacket!.meta;
    expect(new Date(startedAt!).getTime()).toBeLessThanOrEqual(
      new Date(completedAt!).getTime(),
    );
  });

  it("trace actor is orca-runtime for both entries", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    for (const entry of result.ahpRootPacket!.trace) {
      expect(entry.actor).toBe("orca-runtime");
    }
  });
});

// ---------------------------------------------------------------------------
// Option A: no children for a plain single-run task
// ---------------------------------------------------------------------------

describe("AHP hierarchy — Option A (single-run, no child packets)", () => {
  it("ahpChildPackets is undefined when maestro returns no ahpPacket", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpChildPackets).toBeUndefined();
  });

  it("root packet childPacketIds is an empty array (no children linked)", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.childPacketIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Child packet linking — when maestro returns an ahpPacket
// ---------------------------------------------------------------------------

describe("AHP hierarchy — child packet linking", () => {
  // Use makeLegacyChildPacket so parentPacketId is undefined — verifying runtime hydration.
  function buildChildPacket(): AHPPacket {
    return makeLegacyChildPacket("maestro-child-1", AHPLifecycle.COMPLETE);
  }

  it("result.ahpChildPackets contains the maestro ahpPacket", async () => {
    const child   = buildChildPacket();
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpChildPackets).toBeDefined();
    expect(result.ahpChildPackets!).toContain(child);
  });

  it("child packet parentPacketId is set to the root packet id", async () => {
    const child   = buildChildPacket();
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result = await runtime.executeTask(makeTask());
    expect(child.parentPacketId).toBe(result.ahpRootPacket!.id);
  });

  it("root packet childPacketIds contains the child packet id", async () => {
    const child   = buildChildPacket();
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.childPacketIds).toContain(child.id);
  });

  it("root lifecycle derived from child: COMPLETE child → root COMPLETE", async () => {
    const child = buildChildPacket(); // child is COMPLETE
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result  = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.COMPLETE);
  });

  it("root lifecycle derived from child: FAILED child → root FAILED", async () => {
    const child   = buildChildPacket();
    child.lifecycle = AHPLifecycle.FAILED;
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("failed output", child), makeFailPappyResult()),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.lifecycle).toBe(AHPLifecycle.FAILED);
  });

  it("child evalMeta is preserved — not cleared by finalization", async () => {
    const child = buildChildPacket();
    (child as AHPPacket & { evalMeta?: unknown }).evalMeta = {
      verdict: "COMPLETE",
      acResults: [],
      evaluatedAt: new Date().toISOString(),
    };
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result = await runtime.executeTask(makeTask());
    expect(
      (result.ahpChildPackets![0] as AHPPacket & { evalMeta?: unknown }).evalMeta,
    ).toBeDefined();
  });

  it("ahpChildPackets has exactly one entry when maestro returns one ahpPacket", async () => {
    const child   = buildChildPacket();
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithPacket("done", child)),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpChildPackets!).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple children via ahpChildPackets
// ---------------------------------------------------------------------------

describe("AHP hierarchy — explicit ahpChildPackets list from maestro", () => {
  // Use makeLegacyChildPacket (no parentPacketId) to verify the runtime hydrates each one.
  function makeCompleteChild(id: string): AHPPacket {
    return makeLegacyChildPacket(id, AHPLifecycle.COMPLETE);
  }

  it("all explicit ahpChildPackets appear in result.ahpChildPackets", async () => {
    const c1 = makeCompleteChild("c1");
    const c2 = makeCompleteChild("c2");
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithChildPackets("done", [c1, c2])),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpChildPackets).toContain(c1);
    expect(result.ahpChildPackets).toContain(c2);
  });

  it("root childPacketIds contains all child ids", async () => {
    const c1 = makeCompleteChild("c1");
    const c2 = makeCompleteChild("c2");
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithChildPackets("done", [c1, c2])),
    );
    const result = await runtime.executeTask(makeTask());
    expect(result.ahpRootPacket!.childPacketIds).toContain("c1");
    expect(result.ahpRootPacket!.childPacketIds).toContain("c2");
  });

  it("each child parentPacketId is hydrated with the root id", async () => {
    const c1 = makeCompleteChild("c1");
    const c2 = makeCompleteChild("c2");
    const runtime = createOrcaRuntime(
      makeDeps(maestroWithChildPackets("done", [c1, c2])),
    );
    const result = await runtime.executeTask(makeTask());
    const rootId = result.ahpRootPacket!.id;
    expect(c1.parentPacketId).toBe(rootId);
    expect(c2.parentPacketId).toBe(rootId);
  });
});

// ---------------------------------------------------------------------------
// Isolation — two runs do not share packet objects
// ---------------------------------------------------------------------------

describe("AHP hierarchy — run isolation", () => {
  it("two successive runs produce distinct root packet objects", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const r1 = await runtime.executeTask(makeTask());
    const r2 = await runtime.executeTask(makeTask());
    expect(r1.ahpRootPacket).not.toBe(r2.ahpRootPacket);
  });

  it("two successive runs produce distinct root packet ids", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const r1 = await runtime.executeTask(makeTask());
    const r2 = await runtime.executeTask(makeTask());
    expect(r1.ahpRootPacket!.id).not.toBe(r2.ahpRootPacket!.id);
  });

  it("trace appended to run-1 root does not appear on run-2 root", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const r1 = await runtime.executeTask(makeTask());
    const r2 = await runtime.executeTask(makeTask());
    // After both runs the trace lengths should equal (both are independent)
    expect(r1.ahpRootPacket!.trace).not.toBe(r2.ahpRootPacket!.trace);
  });
});

// ---------------------------------------------------------------------------
// Terminal state not re-opened (defensive)
// ---------------------------------------------------------------------------

describe("AHP root packet — terminal state guard", () => {
  it("root packet lifecycle is terminal after the run completes", async () => {
    const runtime = createOrcaRuntime(makeDeps(simpleMaestro()));
    const result  = await runtime.executeTask(makeTask());
    const terminalStates = new Set([
      AHPLifecycle.COMPLETE,
      AHPLifecycle.FAILED,
      AHPLifecycle.INCONCLUSIVE,
    ]);
    expect(terminalStates.has(result.ahpRootPacket!.lifecycle)).toBe(true);
  });
});
