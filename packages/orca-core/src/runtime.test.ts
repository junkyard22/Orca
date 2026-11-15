/**
 * Orca Core — Runtime Unit Tests
 *
 * Tests createOrcaRuntime() and the execution flow with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOrcaRuntime, extractExplicitWorkspaceRoot } from "./runtime.js";
import { AHPLifecycle, AHPVerdict, appendAHPTrace, createChildPacket } from "./ahp/types.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createPappyPort } from "./adapters/pappyPort.js";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
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
  describe("task-scoped Miranda permissions", () => {
    it("passes a resource-permission gate to Maestro for file and connector calls", async () => {
      const decisions: boolean[] = [];
      const maestro: MaestroPort = {
        run: async (_task, ctx) => {
          decisions.push(ctx.gate!.beforeToolRun({
            tool: "read_file",
            args: { path: "README.md" },
          }).allowed);
          decisions.push(ctx.gate!.beforeToolRun({
            tool: "github_list_prs",
            args: { owner: "junkyard22", repo: "Orca" },
          }).allowed);
          return { outputText: "Permission checks completed.", summary: "checked" };
        },
      };
      const runtime = createOrcaRuntime({
        maestro,
        llm: createMockLLM(),
        connectorTools: ["github_list_prs"],
      });

      await runtime.executeTask(createTaskSpec({
        permissions: {
          fileRead: false,
          fileWrite: false,
          shellExec: false,
          networkAccess: false,
        },
      }));

      expect(decisions).toEqual([false, false]);
    });
  });

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

    it("verifies child AHP packets against subagent artifacts instead of the parent synthesis output", async () => {
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
            objective: "Confirm audit result",
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
            outputText: "Merged summary without the required keyword.",
            summary: "mock summary",
            ahpChildPackets: [child],
            subagentRuns: [{
              subagentId: "reviewer-0",
              packetId: child.id,
              role: "reviewer",
              task: "Confirm audit result",
              status: "done",
              outputText: "Output mentions audit.",
            }],
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
      expect(child?.verdict).toBe(AHPVerdict.PASS);
      expect(pappy.evaluate.mock.calls[0]?.[0]?.metadata?.ahpNonCompleteChildren).toBeUndefined();
    });

    it("enters repair when only a child AHP packet provides the repair prompt", async () => {
      let attempt = 0;
      let capturedRepairSpec: OrcaTaskSpec | undefined;
      const maestro: MaestroPort = {
        run: vi.fn(async (task, ctx) => {
          attempt++;
          if (attempt === 1) {
            if (!ctx.ahpRootPacket) {
              throw new Error("missing root AHP packet");
            }
            const child = createChildPacket(ctx.ahpRootPacket.id, {
              id: `${ctx.runId}_reviewer_0`,
              objective: "Confirm audit result",
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
            child.repairPrompt = [
              "Your previous response did not fully satisfy all acceptance criteria for:",
              '  "Confirm audit result"',
              "",
              '[PAC1: Output mentions audit] FAILED - explicit child repair path for runtime test.',
              '  -> Specifically address: "Output mentions audit".',
            ].join("\n");

            return {
              outputText: "Merged summary without the keyword.",
              summary: "mock summary",
              doneCriteria: ["Output mentions audit"],
              metadata: {
                role: "brain",
                decomposition: {
                  synthesisHint: "Keep the audit summary concise.",
                },
              },
              ahpChildPackets: [child],
              subagentRuns: [{
                subagentId: "reviewer-0",
                packetId: child.id,
                role: "reviewer",
                task: "Confirm audit result",
                status: "done",
                outputText: "This output never references the required audit keyword.",
              }],
            };
          }

          capturedRepairSpec = task;
          return {
            outputText: "Audit result verified.",
            summary: "repair summary",
          };
        }),
      };
      const pappy = {
        evaluate: vi.fn()
          .mockReturnValueOnce(createMockPappyResult("FAIL"))
          .mockReturnValueOnce(createMockPappyResult("PASS")),
      } satisfies PappyPort;

      const runtime = createOrcaRuntime({
        maestro,
        pappy,
        llm: createMockLLM(),
        maxRepairPasses: 1,
      });

      const result = await runtime.executeTask(createTaskSpec({
        originalUserMessage: "Audit the app",
        goals: ["Output mentions audit"],
      }));

      expect(result.status).toBe("SUCCESS");
      expect(maestro.run).toHaveBeenCalledTimes(2);
      expect(pappy.evaluate).toHaveBeenCalledTimes(2);
      const repair = capturedRepairSpec?.context?.["repair"] as Record<string, unknown> | undefined;
      expect(repair?.["targetRole"]).toBe("reviewer");
      expect((repair?.["targetChildPacket"] as { id?: string } | undefined)?.id).toMatch(/_reviewer_0$/);
      expect(Array.isArray(repair?.["priorSubagentRuns"])).toBe(true);
      expect((repair?.["repairInstruction"] as string | undefined)).toContain("Output mentions audit");
    });

    // Workspace selection (audit F-08, stages 1 and 1.5). The workspace root is
    // the boundary Miranda enforces, so only a structured choice sets it: the
    // host's configured root or an explicit `context.workspaceRoot`. A path
    // that merely appears in the conversation never does. Every path below is
    // a temporary fixture; nothing resolves to, scans or writes outside them.
    describe("workspace selection", () => {
      const fixtures: string[] = [];
      const fixture = (name: string) => { const d = mkdtempSync(join(tmpdir(), `orca-${name}-`)); fixtures.push(d); return d; };
      afterEach(() => { for (const d of fixtures.splice(0)) rmSync(d, { recursive: true, force: true }); });

      async function rootsSeen(deps: Partial<OrcaRuntimeDeps>, specs: Array<Partial<OrcaTaskSpec>>): Promise<Array<string | undefined>> {
        const seen: Array<string | undefined> = [];
        const maestro: MaestroPort = {
          run: async (_task, ctx) => { seen.push(ctx.workspaceRoot); return { outputText: "Looked.", summary: "mock summary" }; },
        };
        const runtime = createOrcaRuntime({
          maestro,
          pappy: { evaluate: vi.fn(() => createMockPappyResult("PASS")) } satisfies PappyPort,
          llm: createMockLLM(),
          ...deps,
        });
        for (const spec of specs) await runtime.executeTask(createTaskSpec(spec));
        return seen;
      }
      const proseMessages = (outside: string): Array<Partial<OrcaTaskSpec>> => [
        { originalUserMessage: `Compare our config with ${join(outside, "hosts.txt")} and report` },
        { originalUserMessage: ["Read package.json in this workspace.", outside, "Only check apps/desktop/package.json."].join("\n") },
        { originalUserMessage: "Tidy up.", intent: `clean ${outside}`, goals: [`Remove temp files under ${outside}`] },
      ];

      it("binds the workspace root to an explicit structured selection, over a configured root", async () => {
        const configuredRoot = fixture("configured-root");
        const selected = fixture("selected-root");
        expect(await rootsSeen({ workspaceRoot: configuredRoot }, [{ originalUserMessage: "Tidy up.", context: { workspaceRoot: selected } }]))
          .toEqual([selected]);
        expect(await rootsSeen({}, [{ originalUserMessage: "Tidy up.", context: { workspaceRoot: selected } }])).toEqual([selected]);
      });

      it("does not let a path mentioned in prose replace a configured workspace root that exists", async () => {
        const configuredRoot = fixture("configured-root");
        const outside = fixture("outside");
        writeFileSync(join(outside, "hosts.txt"), "fixture");
        expect(await rootsSeen({ workspaceRoot: configuredRoot }, proseMessages(outside))).toEqual([configuredRoot, configuredRoot, configuredRoot]);
      });

      it("does not establish a workspace from prose when no workspace is configured", async () => {
        const outside = fixture("outside");
        writeFileSync(join(outside, "hosts.txt"), "fixture");
        expect(await rootsSeen({}, proseMessages(outside))).toEqual([undefined, undefined, undefined]);
      });

      it("does not swap a configured workspace that does not exist for a path found in prose", async () => {
        const outside = fixture("outside");
        writeFileSync(join(outside, "hosts.txt"), "fixture");
        const missing = join(fixture("parent"), "not-created");
        expect(await rootsSeen({ workspaceRoot: missing }, proseMessages(outside))).toEqual([missing, missing, missing]);
        expect(existsSync(missing)).toBe(false);
      });

      it("ignores a structured selection that does not exist or is a filesystem root", async () => {
        const configuredRoot = fixture("configured-root");
        const fsRoot = parsePath(tmpdir()).root;
        const missing = join(fixture("parent"), "not-created");
        // Pure resolution for the filesystem root: no runtime is started on it, so nothing is scanned.
        expect(extractExplicitWorkspaceRoot(createTaskSpec({ context: { workspaceRoot: fsRoot } }))).toBeUndefined();
        expect(extractExplicitWorkspaceRoot(createTaskSpec({ originalUserMessage: "Should the CLI accept yes / no answers? Update cli.ts" }))).toBeUndefined();
        expect(extractExplicitWorkspaceRoot(createTaskSpec({ originalUserMessage: `Look at ${fsRoot}` }))).toBeUndefined();
        expect(await rootsSeen({ workspaceRoot: configuredRoot }, [{ context: { workspaceRoot: missing } }])).toEqual([configuredRoot]);
      });
    });

    // Stage 1.5: a pass whose required write never succeeded is judged on what
    // the host recorded, repaired through the normal loop, and — when the
    // repairs fail too — reported as failed. Nothing is written on its behalf.
    it("gives Pappy the recorded failures of a blocked write, repairs through the normal loop, and ends FAIL when repairs fail too", async () => {
      const root = mkdtempSync(join(tmpdir(), "orca-blocked-write-"));
      mkdirSync(join(root, "src"));
      const original = "export const last = (xs) => xs[xs.length];\n";
      writeFileSync(join(root, "src", "parse.js"), original);
      const blocked = { tool: "write_file", ok: false, summary: "write_file: blocked - File writes are not permitted for this request", raw: { path: "src/parse.js" } };
      const maestro = {
        run: vi.fn(async () => ({
          outputText: "I wrote the fix to src/parse.js and it now returns the last element.",
          toolEvents: [{ tool: "read_file", ok: true, summary: "read_file: ok (44 chars)", raw: { path: "src/parse.js" } }, blocked],
          filesChanged: [],
          metadata: { role: "strong_model", stoppedBecause: "required_action_incomplete" as const },
        })),
      } satisfies MaestroPort;
      const real = createPappyPort();
      const pappy = { evaluate: vi.fn((input: Parameters<PappyPort["evaluate"]>[0]) => real.evaluate(input)) } satisfies PappyPort;
      try {
        const runtime = createOrcaRuntime({ maestro, pappy, llm: createMockLLM(), workspaceRoot: root, maxRepairPasses: 2 });
        const result = await runtime.executeTask(createTaskSpec({
          originalUserMessage: "Fix the off-by-one bug in src/parse.js",
          intent: "fix bug",
          goals: ["Fix the off-by-one bug in src/parse.js"],
        }));

        // What Pappy was told, on every pass: the write failed, nothing changed, the worker did not finish.
        expect(pappy.evaluate.mock.calls.length).toBeGreaterThanOrEqual(1);
        for (const [input] of pappy.evaluate.mock.calls) {
          expect(input.toolEvents).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "write_file", ok: false })]));
          expect((input.toolEvents ?? []).some((e) => e.tool === "write_file" && e.ok)).toBe(false);
          expect(input.filesChanged ?? []).toEqual([]);
          expect(input.metadata?.stoppedBecause).toBe("required_action_incomplete");
          expect(input.workspace?.available).toBe(true);
        }
        for (const outcome of pappy.evaluate.mock.results) expect((outcome.value as PappyResult).verdict).toBe("FAIL");
        // Repaired through the normal loop (one Pappy verdict per Maestro pass), never around it.
        expect(maestro.run.mock.calls.length).toBe(pappy.evaluate.mock.calls.length);
        expect(maestro.run.mock.calls.length).toBe(3);
        expect(result.status).toBe("FAIL");
        // Nothing was written for the worker.
        expect(readFileSync(join(root, "src", "parse.js"), "utf8")).toBe(original);
        expect(readdirSync(join(root, "src"))).toEqual(["parse.js"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("runs project audit mode before Maestro and records pipeline visibility", async () => {
      const explicitRoot = mkdtempSync(join(tmpdir(), "orca-audit-runtime-"));
      mkdirSync(join(explicitRoot, "src"));
      writeFileSync(join(explicitRoot, "package.json"), JSON.stringify({
        name: "audit-runtime",
        scripts: { build: "tsc", test: "vitest" },
      }));

      const maestro: MaestroPort = {
        run: async () => {
          throw new Error("maestro should not run for deterministic project audit mode");
        },
      };
      const pappy = {
        evaluate: vi.fn(() => createMockPappyResult("PASS")),
      } satisfies PappyPort;
      const writeTrace = vi.fn();

      try {
        const runtime = createOrcaRuntime({
          maestro,
          pappy,
          llm: createMockLLM(),
          writeTrace,
        });
        const recorder = createEventRecorder();
        runtime.on("task:start", recorder.record);
        runtime.on("maestro:start", recorder.record);
        runtime.on("maestro:done", recorder.record);
        runtime.on("qc:result", recorder.record);
        runtime.on("task:done", recorder.record);
        runtime.on("pipeline:summary", recorder.record);

        const result = await runtime.executeTask(createTaskSpec({
          originalUserMessage: `Check this app for production readiness\n${explicitRoot}`,
          intent: "check this app",
          mode: "project_audit",
          permissions: { fileRead: true, fileWrite: false, shellExec: false },
          context: { auditPath: explicitRoot },
        }));

        expect(result.status).toBe("SUCCESS");
        expect(result.userFacingText).toContain("Runtime commands:");
        expect(pappy.evaluate.mock.calls[0]?.[0].metadata?.audit).toBeDefined();
        const qcInput = pappy.evaluate.mock.calls[0]?.[0];
        expect(qcInput).toBeDefined();
        expect(qcInput!.toolEvents?.some((event) => event.tool === "audit_preflight")).toBe(true);
        expect(qcInput!.toolEvents?.some((event) => event.tool === "audit_classification")).toBe(true);
        expect(qcInput!.toolEvents?.some((event) => event.tool === "audit_command_policy")).toBe(true);
        expect(recorder.getTypes()).toEqual([
          "task:start",
          "maestro:start",
          "maestro:done",
          "qc:result",
          "task:done",
          "pipeline:summary",
        ]);
        const summary = recorder.findByType("pipeline:summary")[0];
        expect(summary).toEqual(expect.objectContaining({
          verdict: "FAIL",
          role: "project_audit",
          traceStages: expect.arrayContaining(["audit.mode.activated", "qc.run.result", "task.completed"]),
        }));
        expect(summary.issueCount).toBeGreaterThan(0);
        expect(summary.confidence).toBeLessThan(1);
        const trace = writeTrace.mock.calls[0]?.[0] as any;
        expect(trace.entries.map((entry: any) => entry.stage)).toEqual(expect.arrayContaining([
          "audit.mode.activated",
          "audit.preflight",
          "audit.classification",
          "audit.probes",
          "audit.command_policy",
          "audit.readiness",
        ]));
      } finally {
        rmSync(explicitRoot, { recursive: true, force: true });
      }
    });

    it("routes project-audit verification through the QC gate", async () => {
      const explicitRoot = mkdtempSync(join(tmpdir(), "orca-audit-qc-gate-"));
      writeFileSync(join(explicitRoot, "package.json"), JSON.stringify({ name: "audit-qc-gate" }));
      const gate = {
        beforeQC: vi.fn(() => ({ allowed: false, reason: "audit-qc-blocked" })),
        afterQC: vi.fn(() => ({ allowed: true, reason: "ok" })),
      };
      const pappy = {
        evaluate: vi.fn(() => createMockPappyResult("PASS")),
      } satisfies PappyPort;

      try {
        const result = await createOrcaRuntime({
          maestro: { run: vi.fn() },
          pappy,
          llm: createMockLLM(),
          gate: gate as any,
        }).executeTask(createTaskSpec({
          originalUserMessage: `Audit this app\n${explicitRoot}`,
          intent: "audit this app",
          mode: "project_audit",
          permissions: { fileRead: true, fileWrite: false, shellExec: false },
          context: { auditPath: explicitRoot },
        }));

        expect(result.status).toBe("FAIL");
        expect(gate.beforeQC).toHaveBeenCalledTimes(1);
        expect(pappy.evaluate).not.toHaveBeenCalled();
        expect(gate.afterQC).not.toHaveBeenCalled();
      } finally {
        rmSync(explicitRoot, { recursive: true, force: true });
      }
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
    it("propagates abort errors and persists the run as cancelled", async () => {
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
      // Phase 5: a cancelled task is recorded (never as completed) so the history says what happened.
      expect(store.saveRun).toHaveBeenCalledTimes(1);
      expect(store.saveRun.mock.calls[0]?.[0]).toMatchObject({ status: "FAIL", stoppedBecause: "cancelled" });
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
