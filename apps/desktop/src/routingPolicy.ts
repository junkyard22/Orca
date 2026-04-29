import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { DecomposeDecision, DepartmentTask, RoleName } from "maestro-core";

export const DEFAULT_EXECUTION_ROLE: RoleName = "narrator";

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
  if (asksForCommandVerification(task)) {
    return {
      decision: {
        routing: "direct",
        role: "utility",
        done_criteria: decision?.done_criteria
          ?? (task.goals?.length
            ? task.goals
            : [
                "Output reports pass/fail for each requested command",
                "Output includes any command errors",
              ]),
      },
      remappedBrainExecution: decision?.routing !== "direct" || decision.role !== "utility",
      remapReason: "command_verification",
    };
  }

  if (!decision) {
    return {
      decision: auditFallback ?? {
        routing: "direct",
        role: DEFAULT_EXECUTION_ROLE,
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

function asksForCommandVerification(task: OrcaTaskSpec): boolean {
  const text = [task.originalUserMessage, task.intent, ...(task.goals ?? [])].join(" ");
  return (
    /\b(?:actually\s+)?run\b.{0,120}\b(?:commands?|tests?|build|lint|verification|contract:check)\b/i.test(text) ||
    /\bdo\s+not\s+do\s+a\s+read[-\s]?only\s+(?:project\s+)?audit\b/i.test(text) ||
    /\b(?:pnpm|npm|yarn|bun|cargo|go|pytest|python)\s+(?:run\s+)?[\w:.-]+/i.test(text)
  );
}
