import { classifyTaskKind } from "@clawde/orca-core";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { DecomposeDecision, DepartmentTask, RoleName } from "maestro-core";

export const DEFAULT_EXECUTION_ROLE: RoleName = "narrator";
const COMMAND_VERIFICATION_ROLE: RoleName = "debugger";

/**
 * The worker a request falls back to when Brain produced no usable plan,
 * chosen by what the request asks for. A request that changes code never
 * falls back to Narrator (a non-editing role); it goes to the debugger for a
 * defect, the strong model for a feature, refactor or documentation change,
 * the reader for inspection, and Narrator only for conversation-shaped work.
 */
export function fallbackExecutionRole(task: OrcaTaskSpec): RoleName {
  const text = requestText(task);
  const kind = classifyTaskKind(text);
  switch (kind) {
    case "bugfix": return "debugger";
    case "feature":
    case "refactor":
    case "docs": return "strong_model";
    case "inspect": return restatesKnownInformation(text) ? DEFAULT_EXECUTION_ROLE : "reader";
    default: return DEFAULT_EXECUTION_ROLE;
  }
}

/**
 * Pappy's "inspect" kind covers two different jobs: gathering information
 * from the workspace (review, audit, explain how X in src/ works) and
 * restating information already in hand (summarize the facts, report the
 * findings, tell the user what was found). The first needs the reader, who
 * can open files; the second is a response, which is Narrator's job. The
 * rule looks at the object of the request, not at particular phrasings: a
 * response-shaped verb whose object is prior information or the user, with
 * nothing in the workspace named, is a response.
 */
const RESPONSE_VERB = /\b(summari[sz]e|describe|explain|report\s+on|tell\s+me|recap|restate|present)\b/i;
const KNOWN_INFORMATION = /\b(facts?|findings?|results?|conclusions?|outcomes?|answers?|the\s+above|these|this|so\s+far|what\s+(?:you|we)\s+(?:found|learned|have|know)|for\s+the\s+user|in\s+plain\s+(?:english|language|words)|the\s+(?:output|conversation|discussion|thread))\b/i;
const WORKSPACE_OBJECT = /\b(code|codebase|source|repo(?:sitory)?|project|module|package|file|files|folder|director(?:y|ies)|function|class|method|component|service|schema|config(?:uration)?|architecture|implementation|tests?|logs?|diff|commit|branch|src|lib)\b|[\w./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|md|json|ya?ml|toml|css|html)\b/i;

export function restatesKnownInformation(text: string): boolean {
  return RESPONSE_VERB.test(text) && KNOWN_INFORMATION.test(text) && !WORKSPACE_OBJECT.test(text);
}

function requestText(task: OrcaTaskSpec): string {
  return [task.originalUserMessage, task.intent, ...(task.goals ?? [])].filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

/** The request with its command lines removed: "pnpm build" names a command to run, not a change to make. */
function withoutCommandLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*[-*]?\s*[`'"]?(?:pnpm|npm|npx|yarn|bun|cargo|go|pytest|python3?|node|make)\b/i.test(line))
    .join("\n");
}

/** Whether the request asks for code, tests or documents to be changed (prohibitions stripped). */
export function requestsChanges(task: OrcaTaskSpec): boolean {
  const kind = classifyTaskKind(withoutCommandLines(requestText(task)));
  return kind === "bugfix" || kind === "feature" || kind === "refactor" || kind === "docs";
}

export type RoutingPolicyResult = {
  decision: DecomposeDecision;
  remappedBrainExecution: boolean;
  remapReason?: "audit_fallback" | "command_verification" | "direct_default" | "department_default" | "missing_decision";
};

function remapDepartment(department: DepartmentTask, task: OrcaTaskSpec): { department: DepartmentTask; remapped: boolean } {
  if (department.head !== "brain") {
    return { department, remapped: false };
  }

  const role = fallbackExecutionRole({ ...task, originalUserMessage: department.subtask, intent: department.subtask, goals: [] });
  return {
    department: {
      ...department,
      head: role,
      context: department.context
        ? `${department.context}\n\nRouting note: Brain planned this task; ${role} executes it.`
        : `Routing note: Brain planned this task; ${role} executes it.`,
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
  // Command verification is a route only when running commands *is* the
  // request. "Fix the bug, then run the tests" asks for a fix: its objective
  // and the user's goals stay the acceptance criteria, and Pappy judges them.
  if (asksForCommandVerification(task) && !requestsChanges(task)) {
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
    // No usable plan: a worker that can do the kind of work requested, with
    // the user's own goals preserved as the acceptance criteria.
    return {
      decision: auditFallback ?? {
        routing: "direct",
        role: fallbackExecutionRole(task),
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
        role: fallbackExecutionRole(task),
        done_criteria: decision.done_criteria?.length ? decision.done_criteria : (task.goals ?? []),
      },
      remappedBrainExecution: true,
      remapReason: "direct_default",
    };
  }

  const remappedDepartments = decision.departments.map((department) => remapDepartment(department, task));
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
