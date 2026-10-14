/**
 * Constraints Orca attaches to a worker's AHP packet.
 *
 * `no_file_writes` (enforced by Miranda on `write_file`) exists for pure
 * command-execution work — "run the tests", "npm run build" — where the
 * worker's job is to run and report, and a write would change what it was
 * asked to measure. A request that asks for a change and *then* to run the
 * tests ("Fix the failing test in src/parse.js and run the tests") is a
 * change request: it must not carry the constraint.
 *
 * Found in the 1.7.0 live rehearsal: the objective text matched "run the
 * tests", so every bug-fix worker was told "ACTION REQUIRED: Call
 * write_file" and, in the same prompt, "Constraints: no_file_writes"; every
 * edit it attempted was refused. Routing had been taught the difference in
 * phase 5 (`requestsChanges`); this second copy of the rule had not.
 */
import type { AHPPacket, OrcaTaskSpec } from "@clawde/orca-core";
import { appendAHPTrace, AHPVerdict } from "@clawde/orca-core";
import { createMirandaGate } from "@clawde/miranda-core";
import type { MirandaGate } from "@clawde/miranda-core";
import { requestsChanges } from "./routingPolicy";

/** The objective text describes running a build, test or lint pipeline. */
export function isCommandExecutionObjective(objective: string): boolean {
  const t = objective.toLowerCase();
  return /\b(run the (tests?|build|lint)|run (tests?|build|lint)|npm run|npm test|pnpm run|pnpm test|yarn run|yarn test|build and test|build\/test(?:\/lint)?|execute these|execute this)\b/.test(t);
}

/**
 * An explicit instruction to change something. The task-kind classifier alone
 * reads "tell me what fails" as a bug fix; dropping the constraint needs both
 * a change request and a change verb, so a run-and-report request keeps it.
 */
const CHANGE_VERB = /\b(fix|repair|correct|resolve|patch|add|implement|create|write|update|change|modify|edit|refactor|rename|remove|delete|rewrite|replace|migrate|document)\w*\b/i;

function requestText(task: OrcaTaskSpec): string {
  return [task.originalUserMessage, task.intent, ...(task.goals ?? [])]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join("\n");
}

/**
 * Whether a worker for `objective` must not write files: when the objective
 * is command execution, unless the user's request explicitly asks for a change
 * to code, tests or documents (prohibitions such as "do not change" are not
 * change requests: `requestsChanges` strips them).
 */
export function workerMustNotWriteFiles(task: OrcaTaskSpec, objective: string): boolean {
  if (!isCommandExecutionObjective(objective)) return false;
  return !(requestsChanges(task) && CHANGE_VERB.test(requestText(task)));
}

/**
 * The per-worker Miranda gate that enforces the packet's constraints
 * (`no_file_writes` refuses `write_file`). Scoped to one worker run so the
 * constraint state never leaks across workers. Moved here from main.ts
 * unchanged so the worker-protocol tests run the production gate.
 */
export function constraintGateFor(childPacket: AHPPacket | undefined): MirandaGate | undefined {
  if (!childPacket || childPacket.constraints.length === 0) return undefined;
  return createMirandaGate({
    ahpPacket: childPacket,
    checkConstraint: (constraint, gateCtx) => {
      if (constraint.rule === "no_file_writes") {
        return gateCtx.tool !== "write_file";
      }
      return true;
    },
    onViolation: (packet, violated) => {
      packet.verdict = AHPVerdict.VIOLATION;
      appendAHPTrace(packet, {
        timestamp: new Date().toISOString(),
        state: packet.lifecycle,
        actor: "miranda",
        note: `Constraint violation blocked tool call: ${violated.map((c) => c.rule).join(", ")}`,
      });
    },
  });
}
