/**
 * Brain's contract proposal: the pure, JSON-shaped description Brain may add
 * to its routing decision, and its validator.
 *
 * It lives here because Brain's decision is parsed here (decompose.ts) and
 * this package cannot depend on orca-core. orca-core imports these definitions
 * and builds the resolved TaskContract from them — authority, workspace
 * checks and the acceptance contract stay there.
 *
 * A proposal describes (kind, needs, expects) or restricts (prohibits). It
 * never grants: every key is checked against a fixed list, and anything else —
 * `authority`, `permissions`, `approved`, a workspace — is rejected.
 */
import { isCapabilityGroup } from './toolCapabilities';
import type { CapabilityGroup } from './toolCapabilities';

export type TaskIntentKind = "conversation" | "inspect" | "execute" | "modify";
export type ChangeKind = "bugfix" | "feature" | "refactor" | "docs" | "other";
export type ExpectedOutcome =
  | { id: string; type: "answer"; text: string }
  | { id: string; type: "inspection"; paths?: string[] }
  | { id: string; type: "file_change"; change: "create" | "modify" | "delete" | "any"; path?: string }
  | { id: string; type: "no_file_change" }
  | { id: string; type: "command"; purpose: "test" | "build" | "lint" | "typecheck" | "other"; mustPass: boolean };

/** Descriptive or restrictive only: a proposal never grants authority. */
export interface BrainContractProposal {
  kind: TaskIntentKind;
  change_kind?: ChangeKind;
  needs?: CapabilityGroup[];
  prohibits?: CapabilityGroup[];
  expects?: ExpectedOutcome[];
}

function invalid(reason: string): never {
  throw new Error(`Invalid contract proposal: ${reason}`);
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

function keys(raw: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid(`${label} has unknown key ${String(key)}`);
  }
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], label: string): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) invalid(`${label} has an unknown value`);
  return raw as T;
}

function nonEmpty(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) invalid(`${label} must be a non-empty string`);
  return raw;
}

function strings(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) invalid(`${label} must be an array`);
  return raw.map((value) => nonEmpty(value, label));
}

function outcome(raw: unknown): ExpectedOutcome {
  const o = record(raw, "outcome");
  const id = nonEmpty(o.id, "outcome.id");
  switch (o.type) {
    case "answer":
      keys(o, ["id", "type", "text"], "answer");
      return { id, type: o.type, text: nonEmpty(o.text, "answer.text") };
    case "inspection":
      keys(o, ["id", "type", "paths"], "inspection");
      return { id, type: o.type, ...(o.paths === undefined ? {} : { paths: strings(o.paths, "inspection.paths") }) };
    case "file_change":
      keys(o, ["id", "type", "change", "path"], "file_change");
      return { id, type: o.type, change: oneOf(o.change, ["create", "modify", "delete", "any"], "file_change.change"),
        ...(o.path === undefined ? {} : { path: nonEmpty(o.path, "file_change.path") }) };
    case "no_file_change":
      keys(o, ["id", "type"], "no_file_change");
      return { id, type: o.type };
    case "command":
      keys(o, ["id", "type", "purpose", "mustPass"], "command");
      if (typeof o.mustPass !== "boolean") invalid("command.mustPass must be a boolean");
      return { id, type: o.type, purpose: oneOf(o.purpose, ["test", "build", "lint", "typecheck", "other"], "command.purpose"), mustPass: o.mustPass };
    default: return invalid("outcome.type has an unknown value");
  }
}

/** Strict JSON-shaped validation; never accepts authority supplied by Brain. */
export function validateContractProposal(raw: unknown): BrainContractProposal {
  const p = record(raw, "contract");
  keys(p, ["kind", "change_kind", "needs", "prohibits", "expects"], "contract");
  const result: BrainContractProposal = {
    kind: oneOf(p.kind, ["conversation", "inspect", "execute", "modify"], "kind"),
  };
  if (p.change_kind !== undefined) result.change_kind = oneOf<ChangeKind>(p.change_kind, ["bugfix", "feature", "refactor", "docs", "other"], "change_kind");
  for (const field of ["needs", "prohibits"] as const) {
    if (p[field] !== undefined) result[field] = strings(p[field], field).map((value) => {
      if (!isCapabilityGroup(value)) invalid(`${field} has unknown capability ${value}`);
      return value;
    });
  }
  if (p.expects !== undefined) {
    if (!Array.isArray(p.expects) || p.expects.length > 6) invalid("expects must be an array of at most 6 outcomes");
    result.expects = p.expects.map(outcome);
  }
  return result;
}
