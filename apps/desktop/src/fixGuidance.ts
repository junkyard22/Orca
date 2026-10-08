import { isDefectFixTask, prohibitsTestEdits } from "@clawde/orca-core";

/**
 * Worker goals that state, up front, the evidence Pappy requires for a bug fix.
 * Uses Pappy's own task classification so the instruction and the check agree.
 */
export function fixVerificationGuidance(requestText: string): string[] {
  if (!isDefectFixTask(requestText)) return [];
  const goals = [
    "Before changing any source code, run the project's full test suite (or the failing test) and record that the reported failure reproduces.",
    "Fix the root cause in the source code, then run the full test suite again — unfiltered — and confirm every test passes, including the one that failed before.",
    "If the failure cannot be reproduced with a test, add a line \"Alternative verification: <method>\" to your final answer that names the exact command you ran after the fix to verify it.",
  ];
  if (prohibitsTestEdits(requestText)) {
    goals.push("Do not modify, delete, skip, or weaken any existing test.");
  }
  return goals;
}
