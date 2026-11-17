import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { classifyToolPermissionRequirement, classifyToolVerb, collectExplicitPathArguments } from "@clawde/miranda-core";
import type { GateResult, MirandaGate, ToolGateContext } from "@clawde/miranda-core";
import type { UserRestrictions } from "./userProhibitions.js";

const PASS: GateResult = { allowed: true, reason: "" };
const refuse = (reason: string): GateResult => ({ allowed: false, reason, violations: [reason] });

/** Where a path really leads: its nearest existing ancestor with links followed, plus the rest. */
function realLocation(candidate: string): string {
  let existing = candidate;
  for (;;) {
    try { lstatSync(existing); break; }
    catch {
      const parent = path.dirname(existing);
      if (parent === existing) return candidate;
      existing = parent;
    }
  }
  let real = existing;
  try { real = realpathSync.native(existing); } catch { /* keep the spelling */ }
  const resolved = path.join(real, path.relative(existing, candidate));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Enforces the user's explicit restrictions at the tool boundary. Refuse-only:
 * it never allows what another gate refused, and every hook other than
 * beforeToolRun passes. It sits in the host chain, so it applies to fallback,
 * direct, decomposed and repair workers and survives inference replacement.
 * It runs before a tool executes, so no exact-call approval is ever requested
 * for a refused call and approval cannot override it.
 */
export function createUserRestrictionGate(restrictions: UserRestrictions, connectorTools: readonly string[] = []): MirandaGate | undefined {
  const noShell = restrictions.prohibits.includes("shell");
  const noWrite = restrictions.prohibits.includes("filesystem-write");
  const scope = restrictions.writeScope;
  if (!noShell && !noWrite && !scope) return undefined;

  const inScope = (ctx: ToolGateContext): boolean => {
    if (!scope || !ctx.workspaceRoot) return false;
    const root = path.resolve(ctx.workspaceRoot);
    const allowed = new Set(scope.map((name) => realLocation(path.resolve(root, name))));
    const targets = collectExplicitPathArguments(ctx.args ?? {});
    return targets.length > 0 && targets.every((target) => allowed.has(realLocation(path.resolve(root, target))));
  };

  return {
    beforeLLMCall: () => PASS,
    afterLLMCall: () => PASS,
    afterToolRun: () => PASS,
    beforeQC: () => PASS,
    afterQC: () => PASS,
    beforeToolRun(ctx) {
      const requirement = classifyToolPermissionRequirement(ctx.tool, connectorTools);
      if (requirement === "shell_exec") {
        return noShell ? refuse(noWrite || scope
          ? "Shell execution is not permitted: the request limits file changes, and a command could change files"
          : "Shell execution is not permitted: the request prohibits running commands") : PASS;
      }
      const writes = requirement === "file_write" || requirement === "connector_write" ||
        (requirement === "none" && classifyToolVerb(ctx.tool) === "write");
      if (!writes) return PASS;
      if (noWrite) return refuse("File changes are not permitted: the request prohibits modifying files");
      if (scope && !(requirement === "file_write" && inScope(ctx))) {
        return refuse(`File changes are limited by the request to: ${scope.join(", ")}`);
      }
      return PASS;
    },
  };
}
