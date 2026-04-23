import { describe, expect, it } from "vitest";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import { getRepairOriginalRole, getRepairRoutingSourceTask } from "./repairRouting";

function makeRepairTask(): OrcaTaskSpec {
  return {
    originalUserMessage: "Fix the routing defect",
    intent: "repair",
    goals: ["repair goal"],
    constraints: { dont: "create" },
    permissions: { fileRead: true, fileWrite: true, shellExec: true },
    context: {
      conversationHistory: [{ role: "user", content: "original request" }],
      repair: {
        original: {
          intent: "Work only inside",
          goals: [
            "check.js exists inside ./tmp-test/orca-transparency-fail",
            "script is executed successfully",
            "final output includes a touched-files summary",
          ],
          message: "Work only inside ./tmp-test/orca-transparency-fail",
          role: "brain",
        },
        issues: [
          {
            code: "ROUTING_CRITERIA_MISMATCH",
            message: "done_criteria contain limitation language",
          },
        ],
      },
    },
  };
}

describe("repairRouting", () => {
  it("preserves original brain role for non-targeted repair tasks", () => {
    expect(getRepairOriginalRole(makeRepairTask())).toBe("brain");
  });

  it("routes repairs using the original task instead of the repair directive", () => {
    const routingTask = getRepairRoutingSourceTask(makeRepairTask());

    expect(routingTask.intent).toBe("Work only inside");
    expect(routingTask.originalUserMessage).toBe("Work only inside ./tmp-test/orca-transparency-fail");
    expect(routingTask.goals).toEqual([
      "check.js exists inside ./tmp-test/orca-transparency-fail",
      "script is executed successfully",
      "final output includes a touched-files summary",
    ]);
    expect(routingTask.context).toEqual({
      conversationHistory: [{ role: "user", content: "original request" }],
    });
  });
});
