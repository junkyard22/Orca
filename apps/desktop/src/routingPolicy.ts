import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { DecomposeDecision, DepartmentTask, RoleName } from "maestro-core";

export const DEFAULT_EXECUTION_ROLE: RoleName = "narrator";
const COMMAND_VERIFICATION_ROLE: RoleName = "debugger";
/** Fallback executors for requests that change code (narrator cannot write files). */
const DEFECT_FIX_ROLE: RoleName = "debugger";
const CHANGE_ROLE: RoleName = "strong_model";

export type RoutingPolicyResult = {
  decision: DecomposeDecision;
  remappedBrainExecution: boolean;
  remapReason?: "audit_fallback" | "command_verification" | "direct_default" | "department_default" | "missing_decision";
};

function remapDepartment(department: DepartmentTask): { department: DepartmentTask; remapped: boolean } {
  if (department.head !== "brain") {
    return { department, remapped: false };
  }

  return {
    department: {
      ...department,
      head: DEFAULT_EXECUTION_ROLE,
      context: department.context
        ? `${department.context}\n\nRouting note: Brain planned this task; ${DEFAULT_EXECUTION_ROLE} executes it.`
        : `Routing note: Brain planned this task; ${DEFAULT_EXECUTION_ROLE} executes it.`,
    },
    remapped: true,
  };
}

/**
 * Brain may plan, decompose, route, and synthesize. It must not be selected as
 * the first execution worker. If Brain routes direct-to-brain, use a specialist
 * execution role instead; for audit-shaped tasks, prefer deterministic
 * multi-role audit decomposition.
 */
export function normalizeDesktopRoutingForExecution(
  task: OrcaTaskSpec,
  decision: DecomposeDecision | null,
  auditFallback: DecomposeDecision | null,
): RoutingPolicyResult {
  // Command verification replaces the plan only when running commands IS the
  // whole request. "Fix the bug, then run the tests" is a change request whose
  // objective (and acceptance criteria) must survive to Pappy.
  if (asksForCommandVerification(task) && !requestsChanges(taskText(task))) {
    const requestedCommands = extractRequestedCommands(task);
    const commandCriteria = requestedCommands.length > 0
      ? [
          ...requestedCommands.map((command) => `Reported completion status for command: ${command}`),
          "Reported overall verification result",
          "Command output details are included for any non-zero command exit",
        ]
      : [
          "Reported completion status for each requested command",
          "Reported overall verification result",
          "Command output details are included for any non-zero command exit",
        ];

    return {
      decision: {
        routing: "direct",
        role: COMMAND_VERIFICATION_ROLE,
        done_criteria: commandCriteria,
      },
      remappedBrainExecution: decision?.routing !== "direct" || decision.role !== COMMAND_VERIFICATION_ROLE,
      remapReason: "command_verification",
    };
  }

  if (!decision) {
    const text = taskText(task);
    const fallbackRole = !requestsChanges(text)
      ? DEFAULT_EXECUTION_ROLE
      : DEFECT_NOUN.test(text) ? DEFECT_FIX_ROLE : CHANGE_ROLE;
    return {
      decision: auditFallback ?? {
        routing: "direct",
        role: fallbackRole,
        done_criteria: task.goals ?? [],
      },
      remappedBrainExecution: !auditFallback,
      remapReason: auditFallback ? undefined : "missing_decision",
    };
  }

  if (decision.routing === "direct") {
    if (decision.role !== "brain") {
      return { decision, remappedBrainExecution: false };
    }

    if (auditFallback) {
      return {
        decision: auditFallback,
        remappedBrainExecution: true,
        remapReason: "audit_fallback",
      };
    }

    return {
      decision: {
        ...decision,
        role: DEFAULT_EXECUTION_ROLE,
      },
      remappedBrainExecution: true,
      remapReason: "direct_default",
    };
  }

  const remappedDepartments = decision.departments.map(remapDepartment);
  const anyRemapped = remappedDepartments.some((entry) => entry.remapped);
  if (!anyRemapped) {
    return { decision, remappedBrainExecution: false };
  }

  return {
    decision: {
      ...decision,
      departments: remappedDepartments.map((entry) => entry.department),
    },
    remappedBrainExecution: true,
    remapReason: "department_default",
  };
}

function taskText(task: OrcaTaskSpec): string {
  return [task.originalUserMessage, task.intent, ...(task.goals ?? [])].join(" ");
}

const CHANGE_INTENT =
  /\b(?:fix|fixes|fixing|repair|resolve|correct|implement|add|create|write|change|modify|update|refactor|rename|remove|delete|migrate|patch|edit|replace|rewrite|improve|optimi[sz]e)\b/i;
// Clauses that forbid a change ("do not modify the tests") are not change requests.
const PROHIBITION_CLAUSE = /\b(?:do not|don't|never|without|must not|should not|avoid)\b[^.;\n]*/gi;
const DEFECT_NOUN = /\b(?:bugs?|issues?|defects?|regressions?|broken|incorrect|wrong|failing|fails?|errors?|crash\w*)\b/i;

/** True when the request asks Orca to change something (not just run or report). */
export function requestsChanges(text: string): boolean {
  return CHANGE_INTENT.test(text.replace(PROHIBITION_CLAUSE, " "));
}

function asksForCommandVerification(task: OrcaTaskSpec): boolean {
  const text = taskText(task);
  return (
    /\b(?:actually\s+)?run\b.{0,120}\b(?:commands?|tests?|build|lint|verification|contract:check)\b/i.test(text) ||
    /\bdo\s+not\s+do\s+a\s+read[-\s]?only\s+(?:project\s+)?audit\b/i.test(text) ||
    /\b(?:pnpm|npm|yarn|bun|cargo|go|pytest|python)\s+(?:run\s+)?[\w:.-]+/i.test(text)
  );
}

function extractRequestedCommands(task: OrcaTaskSpec): string[] {
  const text = [task.originalUserMessage, ...(task.goals ?? [])].join("\n");
  const commands = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^[`'"]|[`'"]$/g, ""))
    .filter((line) => /^(?:pnpm|npm|yarn|bun|cargo|go|pytest|python)\b/i.test(line))
    .map((line) => line.replace(/[.;]\s*$/, ""));

  return [...new Set(commands)];
}
