import { classifyTaskKind, prohibitsTestEdits } from "@clawde/orca-core";

/**
 * Worker goals that state, up front, the evidence Pappy will require for the
 * kind of work requested. Uses Pappy's own task classification so the
 * instruction and the check agree. Pappy verifies what the evidence proves
 * either way; this only tells the worker what to leave behind.
 */
export function verificationGuidance(requestText: string): string[] {
  const kind = classifyTaskKind(requestText);
  const goals: string[] = [];
  switch (kind) {
    case "bugfix":
      goals.push(
        "Before changing any source code, run the project's full test suite (or the failing test) and record that the reported failure reproduces.",
        "Fix the root cause in the source code, then run the full test suite again — unfiltered — and confirm every test passes, including the one that failed before.",
        "If the project has no tests or the failure cannot be reproduced with one, add a line \"Alternative verification: <command>\" to your final answer naming the exact command you ran after the fix; its recorded output must show the corrected behaviour. A source edit alone is not verification.",
      );
      break;
    case "feature":
      goals.push(
        "Implement the requested behaviour in the source code, then show it working: add a test with assertions that exercises the new behaviour and run the full test suite, or add a line \"Alternative verification: <command>\" naming a command you ran after the change whose recorded output shows the feature working. The presence of the code is not evidence that it works.",
      );
      break;
    case "refactor":
      goals.push(
        "Run the full test suite before and after the refactor and confirm the same tests pass; if the project has no tests, run a build or type check after the change and say so. Do not remove or weaken tests.",
      );
      break;
    case "docs":
      goals.push(
        "Write the requested content into the document itself; the final file is checked for it, not your summary of the edit.",
      );
      break;
    default:
      break;
  }
  if (goals.length > 0 && prohibitsTestEdits(requestText)) {
    goals.push("Do not modify, delete, skip, or weaken any existing test.");
  }
  return goals;
}
