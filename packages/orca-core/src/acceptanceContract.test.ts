/**
 * One acceptance contract per task (release stabilization after live
 * rehearsal A7, where the first verdict judged Brain's criteria and the repair
 * verdict judged the user's request instead).
 */
import { describe, expect, it, vi } from "vitest";
import { buildAcceptanceContract } from "./acceptanceContract.js";
import { buildPappyInput } from "./helpers.js";
import { createOrcaRuntime } from "./runtime.js";
import type { MaestroPort, OrcaPipelineTrace, OrcaTaskSpec, PappyPort, PappyResult } from "./types.js";

const MESSAGE = "Fix the failing test in src/parse.js and run the tests.";
const BRAIN = ["Root cause of the failing test in src/parse.js is identified", "The failing test is fixed", "Tests are run and pass successfully"];
const spec = (goals: string[] = [MESSAGE]) => ({ originalUserMessage: MESSAGE, intent: "fix", goals, permissions: { fileRead: true, fileWrite: true, shellExec: true } }) as unknown as OrcaTaskSpec;
const makeLLM = () => ({ complete: vi.fn(async () => ({ text: "x" })), stream: vi.fn(async () => ({ text: "x" })) });
const verdict = (v: "PASS" | "FAIL"): PappyResult => ({
  verdict: v, trainingEligibility: "needs_human_review", confidence: 1, summary: "", acceptance_criteria: [], claims: [], receipt_ledger: [],
  issues: v === "FAIL" ? [{ issueId: "x", severity: "HIGH", code: "FIX_TESTS_NOT_RERUN", category: "Proof", description: "not re-run", expected_receipt: "", evidence: "", fix_hint: "re-run", message: "not re-run" }] : [],
  repair_task: null, repairTask: v === "FAIL" ? "repair: re-run the tests" : undefined, internalSummary: `verdict=${v}`,
} as unknown as PappyResult);

describe("acceptance contract", () => {
  it("keeps every user goal first, adds Brain's criteria, drops duplicates — Brain cannot remove or replace a user requirement", () => {
    const c = buildAcceptanceContract(spec([MESSAGE, "Do not modify the tests"]), [...BRAIN, MESSAGE.toUpperCase(), "  "]);
    expect(c.userGoals).toEqual([MESSAGE, "Do not modify the tests"]);
    expect(c.derivedCriteria).toEqual(BRAIN);
    expect(c.goals).toEqual([MESSAGE, "Do not modify the tests", ...BRAIN]);
    expect(buildAcceptanceContract(spec([]), []).goals).toEqual([MESSAGE]); // no goals: the request itself
  });

  it("a Brain criterion unrelated to the request is kept as advisory, not mandatory — it can neither block a genuine fix nor replace a user goal", () => {
    const c = buildAcceptanceContract(spec(), [...BRAIN, "Update the README with usage examples", "Output is non-empty", "src/parse.js keeps its public API"]);
    expect(c.derivedCriteria).toEqual([...BRAIN, "src/parse.js keeps its public API"]);
    expect(c.advisoryCriteria).toEqual(["Update the README with usage examples", "Output is non-empty"]);
    expect(c.goals).toEqual([MESSAGE, ...BRAIN, "src/parse.js keeps its public API"]);
    expect(c.goals[0]).toBe(MESSAGE);
  });

  it("an invented criterion is traced as advisory and is not what Pappy judges; the user's goal still is", async () => {
    const seen: string[][] = [];
    const pappy: PappyPort = { evaluate: (input) => { seen.push([...input.goals]); return verdict("PASS"); } };
    const maestro: MaestroPort = { run: async () => ({ outputText: "Fixed.", doneCriteria: ["Update the README with usage examples"] }) };
    const traces: OrcaPipelineTrace[] = [];
    await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, maxRepairPasses: 0, writeTrace: (t: OrcaPipelineTrace) => { traces.push(t); } } as never).executeTask(spec());
    expect(seen).toEqual([[MESSAGE]]);
    expect(traces[0]!.entries.find((e) => e.stage === "acceptance.contract")?.detail).toMatchObject({ advisoryCriteria: ["Update the README with usage examples"] });
  });

  it("buildPappyInput judges the contract when one is given, whatever a pass's own done criteria say", () => {
    const input = buildPappyInput(spec(), { outputText: "x", doneCriteria: ["Output is non-empty"] }, undefined, undefined, [MESSAGE, ...BRAIN]);
    expect(input.goals).toEqual([MESSAGE, ...BRAIN]);
    expect(buildPappyInput(spec(), { outputText: "x", doneCriteria: BRAIN }).goals).toEqual(BRAIN); // legacy callers unchanged
  });

  it("first pass, repair and final result use one contract — a repair that reports easier criteria cannot change the standard", async () => {
    const seen: Array<{ goals: string[] }> = [];
    let n = 0;
    const pappy: PappyPort = { evaluate: (input) => { seen.push({ goals: [...input.goals] }); return verdict(++n === 1 ? "FAIL" : "PASS"); } };
    const specs: OrcaTaskSpec[] = [];
    const maestro: MaestroPort = {
      run: async (task) => {
        specs.push(task);
        return task.intent === "repair"
          ? { outputText: "Ran the tests: 13 passed.", doneCriteria: ["Output is non-empty"] }
          : { outputText: "Fixed src/parse.js.", doneCriteria: BRAIN };
      },
    };
    const traces: OrcaPipelineTrace[] = [];
    const result = await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, maxRepairPasses: 1, writeTrace: (t: OrcaPipelineTrace) => { traces.push(t); } } as never).executeTask(spec());
    expect(seen).toHaveLength(2);
    expect(seen[0]!.goals).toEqual([MESSAGE, ...BRAIN]);
    expect(seen[1]!.goals).toEqual([MESSAGE, ...BRAIN]);
    expect(specs[1]!.goals).toEqual([MESSAGE, ...BRAIN]); // the repair works to the same contract
    const contracts = traces[0]!.entries.filter((e) => e.stage === "acceptance.contract");
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.detail).toMatchObject({ userGoals: [MESSAGE], derivedCriteria: BRAIN });
    expect(result.qcResult?.verdict).toBe("PASS");
  });

  it("Brain fallback (no derived criteria): the user's goals are the contract", async () => {
    const seen: string[][] = [];
    const pappy: PappyPort = { evaluate: (input) => { seen.push([...input.goals]); return verdict("PASS"); } };
    const maestro: MaestroPort = { run: async () => ({ outputText: "Fixed." }) };
    await createOrcaRuntime({ maestro, pappy, llm: makeLLM() as never, maxRepairPasses: 0 } as never).executeTask(spec());
    expect(seen).toEqual([[MESSAGE]]);
  });

  it("a cancelled task is not judged against a different standard: no verdict is produced after Stop", async () => {
    const controller = new AbortController();
    const evaluate = vi.fn(() => verdict("PASS"));
    const maestro: MaestroPort = { run: async () => { controller.abort(new Error("Stopped")); return { outputText: "x", doneCriteria: ["Output is non-empty"] }; } };
    const outcome = await createOrcaRuntime({ maestro, pappy: { evaluate } as never, llm: makeLLM() as never, maxRepairPasses: 1 } as never)
      .executeTask(spec(), { abortSignal: controller.signal })
      .then((r) => r, (e: unknown) => e);
    expect(evaluate).not.toHaveBeenCalled();
    if (outcome instanceof Error) expect(outcome.name).toBe("AbortError");
    else expect((outcome as { qcResult?: { verdict?: string } }).qcResult?.verdict).not.toBe("PASS");
  });
});
