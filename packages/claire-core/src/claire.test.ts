/**
 * Claire re-voices a task's result. After live rehearsal A6 she is given the
 * host's record of what the task did, and her reply passes through the app's
 * review before it is shown.
 */
import { describe, expect, it } from "vitest";
import { createClaire } from "./claire.js";
import type { ClaireMessage, ExecutionResult } from "./types.js";

const RECORD = "Host record of this task so far (recorded by Orca's runtime, not any worker's account):\n- src/parse.js (modified) — changed by this task in the first pass (debugger).";

function claireWith(result: ExecutionResult, reply: string, review?: (reply: string, result: ExecutionResult) => string) {
  const prompts: ClaireMessage[][] = [];
  const claire = createClaire({
    complete: async (messages) => { prompts.push(messages); return reply; },
    executeTask: async () => result,
    ...(review ? { reviewReply: review } : {}),
  });
  return { claire, prompts };
}

describe("Claire and the host record", () => {
  it("keeps WARN conversation findings and an unverified notice without a narrator", async () => {
    const result: ExecutionResult = { status: "SUCCESS", userFacingText: "An explanation.", contract: { kind: "conversation" }, qcResult: { verdict: "WARN", issues: [{ description: "Some proof is missing." }] } };
    const { claire, prompts } = claireWith(result, "rewritten");
    const reply = await claire.handleUserMessage("Explain how to fix a failing test.");
    expect(reply).toContain("An explanation.");
    expect(reply).toContain("Answered without reading any files.");
    expect(reply).toContain("not verified");
    expect(reply).toContain("Some proof is missing.");
    expect(prompts).toHaveLength(0);
  });
  it.each(["SUCCESS", "FAIL"] as const)("preserves legacy presentation for disputed conversations: %s", async (status) => {
    const { claire, prompts } = claireWith({ status, userFacingText: "No changes made.", contract: { kind: "conversation", kindDisputed: true } }, "Unverified: no changes made.");
    expect(await claire.handleUserMessage("Can you fix the failing test?")).toBe("Unverified: no changes made.");
    expect(prompts).toHaveLength(1);
  });
  it("leaves the closed social shortcut unchanged", async () => {
    const { claire, prompts } = claireWith({ status: "FAIL" }, "Hello!");
    expect(await claire.handleUserMessage("hi")).toBe("Hello!");
    expect(prompts).toHaveLength(1);
  });
  it("preserves failed conversation output and findings without a rewrite or success disclosure", async () => {
    const result = { status: "FAIL", userFacingText: "Use `[]`.", contract: { kind: "conversation" }, qcResult: { issues: [{ description: "The requested proof is missing." }] } } as ExecutionResult;
    const { claire, prompts } = claireWith(result, "rewritten");
    const reply = await claire.handleUserMessage("How do I create a list in Python?");
    expect(reply).toContain("Use `[]`.");
    expect(reply).toContain("not verified");
    expect(reply).toContain("The requested proof is missing.");
    expect(reply).not.toContain("Answered without reading any files.");
    expect(prompts).toHaveLength(0);
  });
  it("delivers an ordinary conversation verbatim with the fixed disclosure and no narrator", async () => {
    const result = { status: "SUCCESS", userFacingText: "Use `[]`.\n\nKeep this formatting.", contract: { kind: "conversation" } } as ExecutionResult;
    const { claire, prompts } = claireWith(result, "rewritten");
    expect(await claire.handleUserMessage("How do I create a list in Python?")).toBe(`${result.userFacingText}\n\nAnswered without reading any files.`);
    expect(prompts).toHaveLength(0);
  });
  it("the narrator is given the recorded facts and told they win over the result text", async () => {
    const { claire, prompts } = claireWith({ status: "SUCCESS", userFacingText: "All 13 tests pass.", hostRecord: { available: true, text: RECORD } }, "Done — all 13 tests pass.");
    await claire.handleUserMessage("Fix the failing test in src/parse.js and run the tests.");
    const prompt = prompts.at(-1)!.at(-1)!.content;
    expect(prompt).toMatch(/Recorded facts/);
    expect(prompt).toContain("src/parse.js (modified) — changed by this task in the first pass");
    expect(prompt).toMatch(/never say a change was already there or made by someone else unless they say so/);
  });

  it("the reply passes through the app's review before it is returned", async () => {
    const { claire } = claireWith(
      { status: "SUCCESS", userFacingText: "x", hostRecord: { available: true, text: RECORD } },
      "Someone had corrected parse.js in a prior session.",
      (reply) => `${reply}\n\nCorrection from Orca's records: src/parse.js was changed by this task in the first pass.`,
    );
    expect(await claire.handleUserMessage("Fix the failing test in src/parse.js and run the tests.")).toMatch(/Correction from Orca's records/);
  });

  it("without a record nothing is added and nothing is reviewed away", async () => {
    const { claire, prompts } = claireWith({ status: "SUCCESS", userFacingText: "Done." }, "Done.");
    expect(await claire.handleUserMessage("Fix the failing test in src/parse.js and run the tests.")).toBe("Done.");
    expect(prompts.at(-1)!.at(-1)!.content).not.toMatch(/Recorded facts/);
  });
});
