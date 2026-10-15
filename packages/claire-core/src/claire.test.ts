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
