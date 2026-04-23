import type { OrcaTaskSpec } from "@clawde/orca-core";
import type { RoleName } from "maestro-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getRepairOriginalRecord(task: OrcaTaskSpec): Record<string, unknown> | null {
  if (task.intent !== "repair") return null;
  const repair = isRecord(task.context?.["repair"]) ? task.context["repair"] : null;
  if (!repair) return null;
  return isRecord(repair["original"]) ? repair["original"] : null;
}

export function getRepairOriginalRole(task: OrcaTaskSpec): RoleName | undefined {
  const original = getRepairOriginalRecord(task);
  const role = original?.["role"];
  return typeof role === "string" && role.trim().length > 0 ? role as RoleName : undefined;
}

export function getRepairRoutingSourceTask(task: OrcaTaskSpec): OrcaTaskSpec {
  const original = getRepairOriginalRecord(task);
  if (!original) return task;

  const originalMessage = typeof original["message"] === "string" && original["message"].trim().length > 0
    ? original["message"]
    : task.originalUserMessage;
  const originalIntent = typeof original["intent"] === "string" && original["intent"].trim().length > 0
    ? original["intent"]
    : task.intent;
  const originalGoals = Array.isArray(original["goals"])
    ? original["goals"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : task.goals;
  const context = isRecord(task.context)
    ? Object.fromEntries(Object.entries(task.context).filter(([key]) => key !== "repair"))
    : undefined;

  return {
    originalUserMessage: originalMessage,
    intent: originalIntent,
    goals: originalGoals,
    constraints: task.constraints,
    permissions: task.permissions,
    outputFormat: task.outputFormat,
    context: context && Object.keys(context).length > 0 ? context : undefined,
  };
}
