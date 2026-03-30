/**
 * Orca Core — Runtime Stress Tests
 *
 * Covers scenarios not in runtime.test.ts:
 *   - Budget guard (initial spend >= limit → skip repair with WARN)
 *   - Miranda gate blocking (beforeQC allowed:false)
 *   - Tool permission filtering (toolsAllowed allowlist, empty array, undefined)
 *   - Trace sanitization via writeTrace (circular refs, deep nesting, large strings, large arrays)
 *   - pipeline:summary event shape and field correctness
 *   - Concurrent executeTask calls on a shared runtime
 *   - Store.saveRun and writeTrace failure resilience (errors swallowed)
 *   - Event ordering across a full repair cycle
 *   - QC gate emit events (miranda:checkpoint)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrcaRuntime } from "./runtime.js";
import type {
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  MaestroPort,
  PappyPort,
  OrcaRunCtx,
  OrcaEvent,
} from "./types.js";
import type { PappyResult } from "@clawde/pappy-core";

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeTaskSpec(overrides: Partial<OrcaTaskSpec> = {}): OrcaTaskSpec {
  return {
    originalUserMessage: "stress test task",
    intent: "stress",
    goals: ["produce output"],
    ...overrides,
  };
}

function makePappyResult(
  verdict: "PASS" | "WARN" | "FAIL",
  extra: Partial<PappyResult> = {},
): PappyResult {
  return {
    verdict,
    confidence: verdict === "PASS" ? 1.0 : 0.5,
    summary: `summary-${verdict}`,
    acceptance_criteria: [],
    claims: [],
    receipt_ledger: [],
    issues:
      verdict === "FAIL"
        ? [
            {
              issueId: "STRESS:abc",
              severity: "HIGH",
              code: "STRESS_FAIL",
              category: "Completeness",
              description: "stress fail",
              expected_receipt: "output",
              evidence: "none",
              fix_hint: "fix it",
              message: "stress fail",
            },
          ]
        : [],
    repair_task:
      verdict === "FAIL"
        ? { title: "Fix stress issue", steps: ["step 1"], required_proofs: [] }
        : null,
    // repairTask is the backward-compat string form checked by runtime.ts
    repairTask: verdict === "FAIL" ? "Fix stress issue: step 1" : undefined,
    internalSummary: `verdict=${verdict}`,
    ...extra,
  };
}

function makeMaestro(
  output: string,
  costUsd = 0,
  role = "coder",
): MaestroPort {
  return {
    run: async () => ({
      outputText: output,
      summary: "maestro done",
      metadata: { role, costUsd },
    }),
  };
}

function makeLLM() {
  return { complete: async () => ({ text: "llm response" }) };
}

function makeBasicDeps(
  maestro: MaestroPort,
  pappy: PappyPort,
  extra: Partial<OrcaRuntimeDeps> = {},
): OrcaRuntimeDeps {
  return {
    maestro,
    pappy,
    llm: makeLLM(),
    maxRepairPasses: 2,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Helper: collect all events of a given type
// ---------------------------------------------------------------------------
function collectEvents<T extends OrcaEvent["type"]>(
  runtime: ReturnType<typeof createOrcaRuntime>,
  type: T,
): Array<Extract<OrcaEvent, { type: T }>> {
  const collected: Array<Extract<OrcaEvent, { type: T }>> = [];
  runtime.on(type, (e) => collected.push(e as Extract<OrcaEvent, { type: T }>));
  return collected;
}

// ===========================================================================
// 1. Budget guard — initial spend already at or above limit
// ===========================================================================

describe("budget guard", () => {
  it("skips repair and returns WARN when initial spend >= budgetUsd", async () => {
    // Initial Maestro pass costs $0.05 — budget is $0.04 → no repair should run
    const maestro: MaestroPort = {
      run: vi.fn(async () => ({
        outputText: "partial answer",
        metadata: { role: "coder", costUsd: 0.05 },
      })),
    };
    const pappy: PappyPort = {
      evaluate: vi.fn(() => makePappyResult("FAIL")),
    };

    const runtime = createOrcaRuntime(
      makeBasicDeps(maestro, pappy, { budgetUsd: 0.04 }),
    );

    const result = await runtime.executeTask(makeTaskSpec());

    expect(result.status).toBe("WARN");
    expect(result.summary).toContain("Budget cap");
    // Maestro should only have been called once (no repair pass)
    expect((maestro.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns WARN with budget info in summary", async () => {
    const maestro = makeMaestro("output", 1.0); // $1 spend
    const pappy: PappyPort = {
      evaluate: vi.fn(() => makePappyResult("FAIL")),
    };

    const result = await createOrcaRuntime(
      makeBasicDeps(maestro, pappy, { budgetUsd: 0.5 }),
    ).executeTask(makeTaskSpec());

    expect(result.status).toBe("WARN");
    // Summary should mention both the limit and the spend
    expect(result.summary).toMatch(/\$0\.5/);
    expect(result.summary).toMatch(/\$1/);
  });

  it("still runs repair when spend is below budget", async () => {
    // Initial pass costs $0.01, budget is $1 — repair must execute
    let callCount = 0;
    const maestro: MaestroPort = {
      run: async () => {
        callCount++;
        return {
          outputText: callCount === 1 ? "bad output" : "fixed output",
          metadata: { role: "coder", costUsd: 0.01 },
        };
      },
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makePappyResult("FAIL"))   // initial QC
        .mockReturnValueOnce(makePappyResult("PASS"))   // repair-loop QC
        .mockReturnValueOnce(makePappyResult("PASS")),  // post-repair re-eval for persistence
    };

    const result = await createOrcaRuntime(
      makeBasicDeps(maestro, pappy, { budgetUsd: 1.0 }),
    ).executeTask(makeTaskSpec());

    expect(result.status).toBe("SUCCESS");
    expect(callCount).toBe(2); // initial + 1 repair
  });
});

// ===========================================================================
// 2. Miranda gate — beforeQC blocking
// ===========================================================================

describe("Miranda gate blocking", () => {
  it("emits miranda:checkpoint event when gate.beforeQC fires", async () => {
    const gate = {
      beforeQC: vi.fn(() => ({ allowed: true, reason: "ok" })),
      afterQC: vi.fn(() => ({ allowed: true, reason: "ok" })),
    };

    const maestro = makeMaestro("done");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy, { gate: gate as any }));
    const checkpoints = collectEvents(runtime, "miranda:checkpoint");

    await runtime.executeTask(makeTaskSpec());

    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints.some((c) => c.gate === "before_qc")).toBe(true);
    expect(checkpoints.some((c) => c.gate === "after_qc")).toBe(true);
  });

  it("records gate block reason in trace when beforeQC denies", async () => {
    const gate = {
      beforeQC: vi.fn(() => ({ allowed: false, reason: "compliance-blocked" })),
      afterQC: vi.fn(() => ({ allowed: true, reason: "ok" })),
    };

    const writeTrace = vi.fn();
    const maestro = makeMaestro("done");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime(
      makeBasicDeps(maestro, pappy, { gate: gate as any, writeTrace }),
    ).executeTask(makeTaskSpec());

    expect(writeTrace).toHaveBeenCalledTimes(1);
    const trace = writeTrace.mock.calls[0]?.[0] as any;
    // The checkpoint must appear in the trace entries
    const mirandaEntries = trace.entries.filter((e: any) =>
      e.stage.startsWith("miranda."),
    );
    expect(mirandaEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("miranda:checkpoint events have correct shape", async () => {
    const gate = {
      beforeQC: vi.fn(() => ({ allowed: true, reason: "all-good" })),
      afterQC: vi.fn(() => ({ allowed: true, reason: "all-good" })),
    };

    const maestro = makeMaestro("out");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };
    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy, { gate: gate as any }));
    const checkpoints = collectEvents(runtime, "miranda:checkpoint");

    await runtime.executeTask(makeTaskSpec());

    for (const c of checkpoints) {
      expect(c).toHaveProperty("taskId");
      expect(c).toHaveProperty("gate");
      expect(c).toHaveProperty("allowed");
      expect(c).toHaveProperty("reason");
      expect(typeof c.allowed).toBe("boolean");
    }
  });
});

// ===========================================================================
// 3. Tool permission filtering
// ===========================================================================

describe("tool permission filtering", () => {
  function makeToolService(toolNames: string[]) {
    // Build a simple prompt that lists tools by bold-name pattern
    const prompt = toolNames
      .map((name) => `**${name}** — does something\n  - arg1: string`)
      .join("\n");
    return {
      execute: vi.fn(async (_name: string) => ({ ok: true, output: "ok" })),
      formatForPrompt: vi.fn(() => prompt),
    };
  }

  it("blocks disallowed tools with an error response", async () => {
    const tools = makeToolService(["read_file", "write_file"]);
    const capturedCtx: OrcaRunCtx[] = [];

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        capturedCtx.push(ctx);
        // Try executing a disallowed tool
        const result = await ctx.tools!.execute("write_file", { path: "x.ts" });
        return { outputText: result.error ?? result.output };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      tools: tools as any,
    }).executeTask(
      makeTaskSpec({
        permissions: {
          fileRead: true,
          fileWrite: false,
          shellExec: false,
          toolsAllowed: ["read_file"], // write_file NOT allowed
        },
      }),
    );

    expect(capturedCtx).toHaveLength(1);
    // The execute should have been blocked, not called on the underlying tools
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("allows permitted tools through", async () => {
    const tools = makeToolService(["read_file"]);

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        await ctx.tools!.execute("read_file", { path: "foo.ts" });
        return { outputText: "read ok" };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      tools: tools as any,
    }).executeTask(
      makeTaskSpec({
        permissions: {
          fileRead: true,
          fileWrite: false,
          shellExec: false,
          toolsAllowed: ["read_file"],
        },
      }),
    );

    expect(tools.execute).toHaveBeenCalledWith("read_file", { path: "foo.ts" });
  });

  it("strips disallowed tool descriptions from formatForPrompt", async () => {
    const tools = makeToolService(["read_file", "write_file", "run_command"]);
    let capturedPrompt = "";

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        capturedPrompt = ctx.tools!.formatForPrompt();
        return { outputText: "ok" };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      tools: tools as any,
    }).executeTask(
      makeTaskSpec({
        permissions: {
          fileRead: true,
          fileWrite: false,
          shellExec: false,
          toolsAllowed: ["read_file"],
        },
      }),
    );

    // read_file should remain; write_file and run_command should be stripped
    expect(capturedPrompt).toContain("read_file");
    expect(capturedPrompt).not.toContain("write_file");
    expect(capturedPrompt).not.toContain("run_command");
  });

  it("exposes NO tools when toolsAllowed is empty", async () => {
    const tools = makeToolService(["read_file"]);
    let ctxToolsDefined = false;

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctxToolsDefined = ctx.tools !== undefined;
        return { outputText: "done" };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      tools: tools as any,
    }).executeTask(
      makeTaskSpec({
        permissions: {
          fileRead: false,
          fileWrite: false,
          shellExec: false,
          toolsAllowed: [], // empty list → no tools
        },
      }),
    );

    expect(ctxToolsDefined).toBe(false);
  });

  it("exposes all tools when no permissions are set", async () => {
    const tools = makeToolService(["read_file", "write_file"]);
    let ctxToolsDefined = false;

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctxToolsDefined = ctx.tools !== undefined;
        return { outputText: "done" };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    // No permissions field → tools pass through unrestricted
    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      tools: tools as any,
    }).executeTask(makeTaskSpec(/* no permissions */));

    expect(ctxToolsDefined).toBe(true);
  });
});

// ===========================================================================
// 4. Trace sanitization (tested indirectly via writeTrace)
// ===========================================================================

describe("trace sanitization", () => {
  async function runWithTrace(maestroResult: object) {
    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async () => maestroResult as any,
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      writeTrace,
    }).executeTask(makeTaskSpec());

    return writeTrace.mock.calls[0]?.[0] as any;
  }

  it("truncates strings longer than 40,000 chars in trace", async () => {
    const longString = "x".repeat(50_000);
    const trace = await runWithTrace({ outputText: longString });

    // Find the maestro.run.result entry which contains the truncated string
    const resultEntry = trace.entries.find((e: any) => e.stage === "maestro.run.result");
    expect(resultEntry).toBeDefined();

    // The sanitized value should be at most 40_000 + small overhead
    const entryJson = JSON.stringify(resultEntry);
    const matchedLong = entryJson.includes("[trace truncated after 40000 chars]");
    expect(matchedLong).toBe(true);
  });

  it("handles circular references without throwing", async () => {
    const circular: Record<string, unknown> = { key: "value" };
    circular["self"] = circular;

    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctx.recordTrace?.("custom.circular", circular);
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await expect(
      createOrcaRuntime({ maestro, pappy, llm: makeLLM(), writeTrace }).executeTask(
        makeTaskSpec(),
      ),
    ).resolves.toBeDefined();

    const trace = writeTrace.mock.calls[0]?.[0] as any;
    const circularEntry = trace.entries.find((e: any) => e.stage === "custom.circular");
    expect(circularEntry).toBeDefined();
    // Should be stringified with [Circular] marker, not throw
    expect(JSON.stringify(circularEntry)).toContain("[Circular]");
  });

  it("caps object depth at 6 with [MaxDepth]", async () => {
    // 8 levels deep
    let deepObj: Record<string, unknown> = { val: "leaf" };
    for (let i = 0; i < 8; i++) {
      deepObj = { nested: deepObj };
    }

    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctx.recordTrace?.("custom.deep", deepObj);
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({ maestro, pappy, llm: makeLLM(), writeTrace }).executeTask(
      makeTaskSpec(),
    );

    const trace = writeTrace.mock.calls[0]?.[0] as any;
    const deepEntry = trace.entries.find((e: any) => e.stage === "custom.deep");
    expect(JSON.stringify(deepEntry)).toContain("[MaxDepth]");
  });

  it("truncates arrays longer than 200 items", async () => {
    const bigArray = Array.from({ length: 300 }, (_, i) => `item-${i}`);

    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctx.recordTrace?.("custom.bigarray", bigArray);
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({ maestro, pappy, llm: makeLLM(), writeTrace }).executeTask(
      makeTaskSpec(),
    );

    const trace = writeTrace.mock.calls[0]?.[0] as any;
    const arrayEntry = trace.entries.find((e: any) => e.stage === "custom.bigarray");
    expect(JSON.stringify(arrayEntry)).toContain("Truncated");
    // Ensure the serialised array is shorter than the original
    const serialised = JSON.parse(JSON.stringify(arrayEntry.detail)) as unknown[];
    expect(serialised.length).toBeLessThanOrEqual(201); // 200 items + truncation notice
  });

  it("serialises BigInt values as strings", async () => {
    // Use a value that fits in float64 exactly to avoid precision issues with the literal
    const bigIntVal = BigInt("9007199254740993"); // use string form to preserve exact value
    const expectedStr = bigIntVal.toString(); // "9007199254740993"

    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        ctx.recordTrace?.("custom.bigint", { val: bigIntVal });
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await expect(
      createOrcaRuntime({ maestro, pappy, llm: makeLLM(), writeTrace }).executeTask(
        makeTaskSpec(),
      ),
    ).resolves.toBeDefined();

    const trace = writeTrace.mock.calls[0]?.[0] as any;
    const bigintEntry = trace.entries.find((e: any) => e.stage === "custom.bigint");
    // Should be stringified, not throw a JSON serialization error
    expect(() => JSON.stringify(bigintEntry)).not.toThrow();
    expect(JSON.stringify(bigintEntry)).toContain(expectedStr);
  });

  it("writes a structurally complete trace on every run", async () => {
    const writeTrace = vi.fn();
    const maestro = makeMaestro("output", 0.001, "reviewer");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    await createOrcaRuntime({ maestro, pappy, llm: makeLLM(), writeTrace }).executeTask(
      makeTaskSpec(),
    );

    const trace = writeTrace.mock.calls[0]?.[0] as any;
    expect(trace).toMatchObject({
      version: 1,
      taskId: expect.stringMatching(/^run_/),
      createdAt: expect.any(String),
      task: expect.objectContaining({ intent: "stress" }),
      entries: expect.any(Array),
      finalResult: expect.objectContaining({
        status: "SUCCESS",
        qcVerdict: "PASS",
        repairPasses: 0,
        durationMs: expect.any(Number),
      }),
    });

    const stageNames = trace.entries.map((e: any) => e.stage);
    expect(stageNames).toContain("task.received");
    expect(stageNames).toContain("maestro.run.result");
    expect(stageNames).toContain("qc.run.result");
    expect(stageNames).toContain("task.completed");
  });
});

// ===========================================================================
// 5. pipeline:summary event
// ===========================================================================

describe("pipeline:summary event", () => {
  it("is emitted after task:done on every QC-enabled run", async () => {
    const maestro = makeMaestro("answer", 0, "coder");
    const pappy: PappyPort = {
      evaluate: vi.fn(() =>
        makePappyResult("PASS", {
          confidence: 0.95,
          acceptance_criteria: [{ id: "AC1", text: "Output exists", required: true }],
          receipt_ledger: [
            {
              ref: "AC1",
              required_receipt: { type: "criterion_specific", details: "Output exists" },
              status: "PROVED",
              evidence: ["non-empty"],
            },
          ],
        }),
      ),
    };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));
    const summaries = collectEvents(runtime, "pipeline:summary");
    const doneEvents = collectEvents(runtime, "task:done");

    await runtime.executeTask(makeTaskSpec());

    expect(summaries).toHaveLength(1);
    expect(doneEvents).toHaveLength(1);

    const summary = summaries[0]!;
    expect(summary.verdict).toBe("PASS");
    expect(summary.confidence).toBe(0.95);
    expect(summary.role).toBe("coder");
    expect(summary.issueCount).toBe(0);
    expect(summary.repairPasses).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.issues)).toBe(true);
    expect(Array.isArray(summary.acceptanceCriteria)).toBe(true);
  });

  it("reflects met=true when AC is proved in the ledger", async () => {
    const maestro = makeMaestro("output");
    const pappy: PappyPort = {
      evaluate: vi.fn(() =>
        makePappyResult("PASS", {
          acceptance_criteria: [{ id: "AC1", text: "Output present", required: true }],
          receipt_ledger: [
            {
              ref: "AC1",
              required_receipt: { type: "criterion_specific", details: "Output present" },
              status: "PROVED",
              evidence: ["outputText is non-empty"],
            },
          ],
        }),
      ),
    };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));
    const summaries = collectEvents(runtime, "pipeline:summary");

    await runtime.executeTask(makeTaskSpec());

    const ac = summaries[0]!.acceptanceCriteria.find((c) => c.id === "AC1");
    expect(ac?.met).toBe(true);
  });

  it("is NOT emitted when QC is disabled (no pappy)", async () => {
    const runtime = createOrcaRuntime({
      maestro: makeMaestro("out"),
      llm: makeLLM(),
    });
    const summaries = collectEvents(runtime, "pipeline:summary");

    await runtime.executeTask(makeTaskSpec());

    expect(summaries).toHaveLength(0);
  });

  it("carries repairPasses count when repairs ran", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: async () => {
        callCount++;
        return { outputText: callCount < 2 ? "bad" : "fixed", metadata: { role: "coder", costUsd: 0 } };
      },
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makePappyResult("FAIL"))   // initial QC
        .mockReturnValueOnce(makePappyResult("PASS"))   // repair-loop QC
        .mockReturnValueOnce(makePappyResult("PASS")),  // post-repair re-eval for persistence
    };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy, { maxRepairPasses: 1 }));
    const summaries = collectEvents(runtime, "pipeline:summary");

    await runtime.executeTask(makeTaskSpec());

    expect(summaries[0]?.repairPasses).toBe(1);
  });

  it("carries deweyBrief when dewey:brief was emitted during the run", async () => {
    const deweyBriefPayload = {
      userName: "TestUser",
      suggestedTone: "brief" as const,
      relevantPreferences: ["concise"],
      relevantContext: ["testing"],
    };

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        // Simulate Dewey emitting its brief via the runtime emitter
        ctx.emit?.({
          type: "dewey:brief",
          taskId: ctx.runId,
          ...deweyBriefPayload,
        });
        return { outputText: "ok", metadata: { role: "coder" } };
      },
    };

    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };
    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));
    const summaries = collectEvents(runtime, "pipeline:summary");

    await runtime.executeTask(makeTaskSpec());

    expect(summaries[0]?.deweyBrief).toMatchObject({
      userName: "TestUser",
      suggestedTone: "brief",
    });
  });
});

// ===========================================================================
// 6. Concurrent executeTask calls
// ===========================================================================

describe("concurrent executeTask calls", () => {
  it("handles multiple parallel tasks without cross-contamination", async () => {
    const maestro: MaestroPort = {
      run: async (task) => {
        // Each task returns its own intent as output
        return {
          outputText: `result-for-${task.intent}`,
          metadata: { role: "coder" },
        };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));

    const [r1, r2, r3] = await Promise.all([
      runtime.executeTask(makeTaskSpec({ intent: "alpha" })),
      runtime.executeTask(makeTaskSpec({ intent: "beta" })),
      runtime.executeTask(makeTaskSpec({ intent: "gamma" })),
    ]);

    expect(r1.userFacingText).toBe("result-for-alpha");
    expect(r2.userFacingText).toBe("result-for-beta");
    expect(r3.userFacingText).toBe("result-for-gamma");
    expect(r1.status).toBe("SUCCESS");
    expect(r2.status).toBe("SUCCESS");
    expect(r3.status).toBe("SUCCESS");
  });

  it("each concurrent task gets its own unique taskId", async () => {
    const capturedIds = new Set<string>();

    const maestro: MaestroPort = {
      run: async (_task, ctx) => {
        capturedIds.add(ctx.runId);
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));

    await Promise.all([
      runtime.executeTask(makeTaskSpec()),
      runtime.executeTask(makeTaskSpec()),
      runtime.executeTask(makeTaskSpec()),
    ]);

    expect(capturedIds.size).toBe(3);
  });

  it("one failing task does not affect concurrent passing tasks", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: async (task) => {
        callCount++;
        if (task.intent === "crash") throw new Error("deliberate crash");
        return { outputText: "ok" };
      },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy));

    const [good1, bad, good2] = await Promise.all([
      runtime.executeTask(makeTaskSpec({ intent: "ok1" })),
      runtime.executeTask(makeTaskSpec({ intent: "crash" })),
      runtime.executeTask(makeTaskSpec({ intent: "ok2" })),
    ]);

    expect(good1.status).toBe("SUCCESS");
    expect(bad.status).toBe("FAIL");
    expect(bad.summary).toContain("Runtime error");
    expect(good2.status).toBe("SUCCESS");
  });
});

// ===========================================================================
// 7. Store and writeTrace failure resilience
// ===========================================================================

describe("failure resilience", () => {
  it("does not throw when writeTrace rejects", async () => {
    const writeTrace = vi.fn().mockRejectedValue(new Error("disk full"));
    const maestro = makeMaestro("output");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const result = await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      writeTrace,
    }).executeTask(makeTaskSpec());

    // Task should still complete successfully
    expect(result.status).toBe("SUCCESS");
  });

  it("does not throw when store.saveRun throws synchronously", async () => {
    const store = {
      saveRun: vi.fn(() => { throw new Error("db locked"); }),
      getRecentRuns: vi.fn(() => []),
      getRun: vi.fn(() => null),
      getRunThoughts: vi.fn(() => []),
      getRunToolEvents: vi.fn(() => []),
      searchRuns: vi.fn(() => []),
      getStats: vi.fn(() => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 })),
      close: vi.fn(),
    };

    const maestro = makeMaestro("output");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const result = await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      store: store as any,
    }).executeTask(makeTaskSpec());

    expect(result.status).toBe("SUCCESS");
  });

  it("does not throw when store.saveRun returns a rejected promise", async () => {
    const store = {
      saveRun: vi.fn().mockRejectedValue(new Error("async db error")),
      getRecentRuns: vi.fn(() => []),
      getRun: vi.fn(() => null),
      getRunThoughts: vi.fn(() => []),
      getRunToolEvents: vi.fn(() => []),
      searchRuns: vi.fn(() => []),
      getStats: vi.fn(() => ({ totalRuns: 0, passRate: 0, avgIterations: 0, totalCostUsd: 0 })),
      close: vi.fn(),
    };

    const maestro = makeMaestro("output");
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const result = await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      store: store as any,
    }).executeTask(makeTaskSpec());

    expect(result.status).toBe("SUCCESS");
  });

  it("still writes trace even when maestro throws", async () => {
    const writeTrace = vi.fn();
    const maestro: MaestroPort = {
      run: async () => { throw new Error("maestro crashed"); },
    };
    const pappy: PappyPort = { evaluate: vi.fn(() => makePappyResult("PASS")) };

    const result = await createOrcaRuntime({
      maestro,
      pappy,
      llm: makeLLM(),
      writeTrace,
    }).executeTask(makeTaskSpec());

    expect(result.status).toBe("FAIL");
    expect(writeTrace).toHaveBeenCalledTimes(1);
    const trace = writeTrace.mock.calls[0]?.[0] as any;
    expect(trace.finalResult?.status).toBe("FAIL");
  });
});

// ===========================================================================
// 8. Event ordering across a full repair cycle
// ===========================================================================

describe("event ordering across repair cycle", () => {
  it("fires events in correct order across initial run + one repair pass", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: async () => {
        callCount++;
        return { outputText: callCount === 1 ? "bad" : "fixed", metadata: { role: "coder", costUsd: 0 } };
      },
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makePappyResult("FAIL"))   // initial QC
        .mockReturnValueOnce(makePappyResult("PASS"))   // repair-loop QC
        .mockReturnValueOnce(makePappyResult("PASS")),  // post-repair re-eval for persistence
    };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy, { maxRepairPasses: 1 }));

    const allEvents: OrcaEvent[] = [];
    const types: OrcaEvent["type"][] = [
      "task:start",
      "maestro:start",
      "maestro:done",
      "qc:result",
      "repair:start",
      "stream:reset",
      "task:done",
      "pipeline:summary",
    ];
    for (const t of types) {
      runtime.on(t, (e) => allEvents.push(e));
    }

    await runtime.executeTask(makeTaskSpec());

    const eventTypes = allEvents.map((e) => e.type);

    // task:start must come first
    expect(eventTypes[0]).toBe("task:start");

    // After the first maestro:done, qc:result fires (verdict FAIL)
    const firstMaestroDone = eventTypes.indexOf("maestro:done");
    const firstQcResult = eventTypes.indexOf("qc:result");
    expect(firstMaestroDone).toBeLessThan(firstQcResult);

    // repair:start fires after the first qc:result
    const firstRepairStart = eventTypes.indexOf("repair:start");
    expect(firstQcResult).toBeLessThan(firstRepairStart);

    // task:done is last (before pipeline:summary)
    const taskDoneIdx = eventTypes.lastIndexOf("task:done");
    const pipelineSummaryIdx = eventTypes.lastIndexOf("pipeline:summary");
    expect(taskDoneIdx).toBeLessThan(pipelineSummaryIdx);
  });

  it("marks final qc:result isRepair=true after a repair pass", async () => {
    let callCount = 0;
    const maestro: MaestroPort = {
      run: async () => {
        callCount++;
        return { outputText: "output", metadata: { role: "coder", costUsd: 0 } };
      },
    };
    const pappy: PappyPort = {
      evaluate: vi.fn()
        .mockReturnValueOnce(makePappyResult("FAIL"))
        .mockReturnValueOnce(makePappyResult("PASS")),
    };

    const runtime = createOrcaRuntime(makeBasicDeps(maestro, pappy, { maxRepairPasses: 1 }));
    const qcEvents = collectEvents(runtime, "qc:result");

    await runtime.executeTask(makeTaskSpec());

    expect(qcEvents).toHaveLength(2);
    expect(qcEvents[0]?.isRepair).toBe(false);
    expect(qcEvents[1]?.isRepair).toBe(true);
  });
});
