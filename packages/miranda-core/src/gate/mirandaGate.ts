/**
 * Miranda Gate — The 6 validation checkpoints that wrap every step.
 *
 * Miranda never calls the LLM. She only validates.
 * She is the compliance and governance layer — the guardrails.
 *
 * Checkpoints:
 *   before_llm_call  → model in allowlist? within budget?
 *   after_llm_call   → output shape matches stage contract?
 *   before_tool_run  → tool in allowlist? args well-formed?
 *   after_tool_run   → receipt captured?
 *   before_qc        → non-empty output ready for QC?
 *   after_qc         → verdict well-formed and receipt-consistent?
 *
 * AHP enforcement (layered within gate logic):
 *   - transitionAHPLifecycle  validates state-machine transitions; throws on illegal moves
 *   - beforeToolRun           blocks tool execution when lifecycle ≠ RUNNING
 *   - beforeToolRun           evaluates constraints[]; VIOLATION verdict on any failure
 */

import type { AHPPacket, AHPConstraint } from "../ahp/types.js";
import { AHPLifecycle, AHPVerdict } from "../ahp/types.js";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// AHP lifecycle transition enforcement
// ---------------------------------------------------------------------------

const LEGAL_AHP_TRANSITIONS: ReadonlyArray<readonly [AHPLifecycle, AHPLifecycle]> = [
  [AHPLifecycle.PENDING, AHPLifecycle.RUNNING],
  [AHPLifecycle.RUNNING, AHPLifecycle.COMPLETE],
  [AHPLifecycle.RUNNING, AHPLifecycle.FAILED],
  [AHPLifecycle.RUNNING, AHPLifecycle.INCONCLUSIVE],
] as const;

/**
 * Validate an AHP lifecycle state transition.
 *
 * Throws with a descriptive message if the transition is not in the legal set:
 *   PENDING → RUNNING
 *   RUNNING → COMPLETE
 *   RUNNING → FAILED
 *   RUNNING → INCONCLUSIVE
 *
 * All other transitions are illegal.
 */
export function transitionAHPLifecycle(from: AHPLifecycle, to: AHPLifecycle): void {
  const legal = LEGAL_AHP_TRANSITIONS.some(([f, t]) => f === from && t === to);
  if (!legal) {
    throw new Error(
      `[AHP] Illegal lifecycle transition: ${from} \u2192 ${to}. ` +
      `Legal transitions: PENDING\u2192RUNNING, RUNNING\u2192COMPLETE, ` +
      `RUNNING\u2192FAILED, RUNNING\u2192INCONCLUSIVE.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Verdict & result shapes
// ---------------------------------------------------------------------------

/**
 * Explicit gate verdict for future runtime discrimination.
 *
 * - PASS             — gate allows the action unconditionally
 * - WARN             — gate allows the action but flags a concern
 * - BLOCK            — gate denies the action
 * - CONFIRM_REQUIRED — (reserved) action needs human confirmation before proceeding
 *
 * `verdict` is always derivable from `allowed`, but the explicit enum gives
 * future code a richer signal without breaking the boolean contract.
 */
export type GateVerdict =
  | "PASS"
  | "WARN"
  | "BLOCK"
  | "CONFIRM_REQUIRED";

export interface GateResult {
  allowed: boolean;
  reason: string;
  violations?: string[];
  /**
   * Non-blocking diagnostics — the gate still allowed the action
   * (`allowed: true`) but flags a concern, e.g. an oversized tool catalog.
   * Kept separate from `violations`, which is reserved for block-causing
   * conditions. Never causes `allowed` to become false.
   */
  warnings?: string[];
  /**
   * Explicit verdict enriching the boolean `allowed` field.
   * Present on every result produced by `createMirandaGate`.
   * Callers should continue to use `allowed` for control flow;
   * `verdict` is informational until the runtime is updated.
   */
  verdict?: GateVerdict;
}

/**
 * Derive a GateVerdict from the existing boolean + optional violations/warnings.
 * This is used internally by the gate factory to populate `verdict`
 * on every GateResult without changing any decision logic. A BLOCKing
 * result always wins; otherwise a non-empty warnings list yields WARN.
 */
function deriveVerdict(allowed: boolean, _violations?: string[], warnings?: string[]): GateVerdict {
  if (!allowed) return "BLOCK";
  return warnings && warnings.length > 0 ? "WARN" : "PASS";
}

export interface LLMCallGateContext {
  /** Pipeline stage: "plan" | "answer" | "critique" | "rewrite" */
  stage: string;
  /** Model ID being invoked, e.g. "deepseek/deepseek-chat" */
  model: string;
  /** USD spent across all stages so far in this run */
  budgetUsed: number;
  /** USD budget cap for this run */
  budgetLimit: number;
  /**
   * The following context-size fields are optional and purely diagnostic —
   * populated by callers that have already computed them for telemetry
   * (see apps/runner/src/adapters/maestroAdapter.ts's "context.budget" trace
   * event). Omitting them just skips the size-based WARN checks below;
   * they never affect PASS/BLOCK decisions.
   */
  /** Number of distinct tools mentioned in the formatted tool-catalog prompt. */
  toolsExposedCount?: number;
  /** Character length of the formatted tool-catalog prompt block. */
  toolSchemaChars?: number;
  /** Character length of the role system prompt. */
  systemPromptChars?: number;
  /** Character length of the conversation-history content threaded into this call. */
  historyChars?: number;
}

export interface ToolGateContext {
  /** Registered tool name */
  tool: string;
  /** Arguments the agent is passing to the tool */
  args: Record<string, unknown>;
  /** Optional task text used for policy checks that depend on explicit user intent. */
  taskText?: string;
  /** Absolute workspace boundary for path-bearing tool arguments. */
  workspaceRoot?: string;
  /** Optional JSON schema for validating tool arguments */
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string }>;
  };
}

export interface QCGateContext {
  /** Run ID for correlating gate events with other trace events */
  taskId: string;
  /** Text that Pappy will (or just did) evaluate */
  outputText: string;
  /** QC pass kind. Undefined for older callers. */
  qcStage?: "initial" | "repair";
  /** Runtime attempt number: 0 for initial QC, 1..n for repair QC. */
  attempt?: number;
  /** Pappy's quality verdict for after_qc diagnostics. */
  pappyVerdict?: string;
  /** Stable Pappy issue codes observed for this QC pass. */
  issueCodes?: string[];
  /** Receipt-ledger refs whose required evidence is missing. */
  missingReceiptRefs?: string[];
  /** Pappy issue categories/types observed for this QC pass. */
  issueTypes?: string[];
  /** Pappy confidence score for this QC pass, when available. */
  confidence?: number;
  /** Agent stop reason associated with the output under QC, when available. */
  stoppedBecause?: string;
}

export type GateName =
  | "before_llm_call"
  | "after_llm_call"
  | "before_tool_run"
  | "after_tool_run"
  | "before_qc"
  | "after_qc";

// ---------------------------------------------------------------------------
// MirandaGate interface
// ---------------------------------------------------------------------------

/**
 * Miranda's 6-gate interface.
 * All methods are synchronous — gates run inline in the hot path.
 * Miranda never calls the LLM; she only inspects and validates.
 */
export interface MirandaGate {
  /** Stage: PLAN / ANSWER / CRITIQUE / REWRITE — before LLM call. */
  beforeLLMCall(ctx: LLMCallGateContext): GateResult;

  /** Stage: PLAN / ANSWER / CRITIQUE / REWRITE — after LLM call. */
  afterLLMCall(
    ctx: LLMCallGateContext,
    output: string,
    validation: { valid: boolean; errors?: string[] },
  ): GateResult;

  /** Stage: EXECUTE — before tool execution. */
  beforeToolRun(ctx: ToolGateContext): GateResult;

  /** Stage: EXECUTE — after tool execution. */
  afterToolRun(
    ctx: ToolGateContext,
    result: { ok: boolean; output: string },
  ): GateResult;

  /** Stage: QC — before Pappy evaluates. */
  beforeQC(ctx: QCGateContext): GateResult;

  /** Stage: QC — validate and record Pappy verdict consistency. */
  afterQC(ctx: QCGateContext, verdict: string, issueCount: number): GateResult;
}

// ---------------------------------------------------------------------------
// Factory config
// ---------------------------------------------------------------------------

export interface MirandaGateConfig {
  /**
   * Explicit model allowlist. Any model ID not in this set is blocked at
   * before_llm_call. Omit to allow all models.
   */
  allowedModels?: string[];

  /**
   * Explicit tool allowlist. Any tool name not in this set is blocked at
   * before_tool_run. Omit to allow all registered tools.
   */
  allowedTools?: string[];

  /**
   * Soft, non-blocking thresholds for the context-size fields on
   * LLMCallGateContext. Exceeding a threshold sets verdict "WARN" (allowed
   * stays true) — this never blocks a call. Omit any field to disable that
   * particular check; defaults are conservative starting points, not
   * measured limits — tune them once real telemetry is available.
   */
  contextBudget?: {
    maxToolsExposed?: number;
    maxToolSchemaChars?: number;
    maxHistoryChars?: number;
  };

  /**
   * Protected path policy for verifier/training/eval/control-plane files.
   * Enabled by default. The only bypass is a runtime-provided maintenanceMode
   * value with userApproved=true; tool arguments cannot self-authorize it.
   */
  protectedPathPolicy?: ProtectedPathPolicyConfig;

  /**
   * Emit gate decisions to stderr when true.
   * Useful during development; disable in production to reduce noise.
   */
  verbose?: boolean;

  /**
   * Callback invoked on every gate check.
   * Use this for tracing, audit logs, or UI dashboards — Miranda never
   * writes directly to any output channel other than the optional stderr log.
   */
  onGate?: (
    gate: GateName,
    result: GateResult,
    ctx: LLMCallGateContext | ToolGateContext | QCGateContext,
  ) => void;

  // ── AHP enforcement ──────────────────────────────────────────────────────

  /**
   * When provided, Miranda enforces AHP lifecycle and constraint rules:
   *   - beforeToolRun blocks unless packet.lifecycle === RUNNING
   *   - beforeToolRun evaluates packet.constraints[] via checkConstraint;
   *     any violation blocks execution and triggers onViolation
   */
  ahpPacket?: AHPPacket;

  /**
   * Evaluate a single AHP constraint against the current tool gate context.
   * Return true if the constraint is satisfied, false if it is violated.
   * Called for each entry in ahpPacket.constraints[] at beforeToolRun.
   * Omit to skip per-constraint evaluation (lifecycle check still applies).
   */
  checkConstraint?: (constraint: AHPConstraint, ctx: ToolGateContext) => boolean;

  /**
   * Invoked when a constraint violation is detected.
   * Use this hook to set packet.verdict = AHPVerdict.VIOLATION and update
   * the trace — Miranda is stateless and does not mutate the packet directly.
   */
  onViolation?: (packet: AHPPacket, violatedConstraints: AHPConstraint[]) => void;
}

// ---------------------------------------------------------------------------
// Protected path enforcement
// ---------------------------------------------------------------------------

export interface ProtectedPathMaintenanceMode {
  /** Must be set by the embedding runtime after explicit user approval. */
  userApproved: true;
  /** Human-readable maintenance reason; empty reasons do not enable bypass. */
  reason: string;
  approvedBy?: string;
}

export interface ProtectedPathPolicyConfig {
  /** Defaults to true. */
  enabled?: boolean;
  /**
   * Allows protected-path edits only when the host application has received
   * explicit user approval for maintenance. This is intentionally config-only.
   */
  maintenanceMode?: ProtectedPathMaintenanceMode;
  /** Allows test/spec file edits for tasks that explicitly ask to edit tests. */
  allowTestFileEdits?: boolean;
  /** Optional task text supplied by the runtime if not present on ToolGateContext. */
  taskText?: string;
}

interface ProtectedPathViolation {
  path: string;
  reason: string;
}

function collectExplicitPathArguments(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (/(?:^|_)(?:path|file|filename|target|destination|cwd|dir|directory)(?:$|_)/i.test(key)) {
        paths.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey);
      }
    }
  };

  for (const [key, value] of Object.entries(args)) visit(value, key);
  return [...new Set(paths)];
}

function evaluateWorkspaceBoundary(ctx: ToolGateContext): ProtectedPathViolation[] {
  if (!ctx.workspaceRoot) return [];

  const workspaceRoot = path.resolve(ctx.workspaceRoot);
  return collectExplicitPathArguments(ctx.args).flatMap((requestedPath) => {
    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(workspaceRoot, requestedPath);
    const relative = path.relative(workspaceRoot, candidate);
    const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return outside
      ? [{ path: requestedPath, reason: "path is outside the configured workspace" }]
      : [];
  });
}

const MUTATING_TOOL_RE = /(^|[_-])(write|edit|modify|delete|remove|move|rename|create|patch|apply|replace)([_-]|$)/i;
const TEST_FILE_RE = /(^|[\s/])(?:__tests__|test|tests|spec|specs)(?:\/|$)|\.(?:test|spec)\.[jt]sx?(?:\s|$)/i;
const MUTATING_COMMAND_RE =
  />{1,2}|\b(?:rm|del|erase|move|mv|cp|copy|echo|set-content|add-content|out-file|new-item|remove-item|rename-item|move-item|sed\s+-i|perl\s+-pi|python(?:\.exe)?\s+-c|node(?:\.exe)?\s+-e)\b|\bgit\s+(?:apply|checkout|clean|reset|restore|merge|rebase|am)\b/i;
const PACKAGE_SCRIPT_RE = /"scripts"\s*:|\b(?:pre|post)?(?:test|build|lint|start|prepare|install)\s*["']?\s*:|\bnpm\s+pkg\s+set\s+scripts\.|\bpnpm\s+pkg\s+set\s+scripts\./i;

function normalizePolicyPath(value: string): string {
  return value
    .trim()
    .replace(/^[`"']+|[`"',.;:]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringValues(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStringValues(item));
  }
  return [];
}

function collectPathLikeValues(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (
        /(?:^|_)(?:path|file|filename|target|destination|cwd|dir|directory)(?:$|_)/i.test(key) ||
        /[\\/]/.test(value) ||
        /\b[\w.-]+\.[a-z0-9]{1,8}\b/i.test(value)
      ) {
        paths.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey);
      }
    }
  };

  visit(args);
  return [...new Set(paths)];
}

function isMaintenanceModeEnabled(policy: ProtectedPathPolicyConfig | undefined): boolean {
  const reason = policy?.maintenanceMode?.reason.trim() ?? "";
  return policy?.maintenanceMode?.userApproved === true && reason.length >= 8;
}

function taskExplicitlyAllowsTestEdits(ctx: ToolGateContext, policy: ProtectedPathPolicyConfig | undefined): boolean {
  if (policy?.allowTestFileEdits === true) return true;

  const taskText = [ctx.taskText, policy?.taskText].filter(Boolean).join(" ");
  if (!taskText.trim()) return false;

  return (
    /\b(add|create|write|update|fix|repair|modify|edit|delete|remove|restore)\b.{0,80}\b(tests?|specs?|test files?|spec files?|assertions?|\.test\.|\.spec\.)\b/i.test(taskText) ||
    /\b(tests?|specs?|test files?|spec files?|assertions?|\.test\.|\.spec\.)\b.{0,80}\b(add|create|write|update|fix|repair|modify|edit|delete|remove|restore)\b/i.test(taskText)
  );
}

function isMutatingToolCall(ctx: ToolGateContext): boolean {
  if (ctx.tool === "run_command") {
    const command = typeof ctx.args["command"] === "string" ? ctx.args["command"] : "";
    return MUTATING_COMMAND_RE.test(command) || PACKAGE_SCRIPT_RE.test(command);
  }
  return MUTATING_TOOL_RE.test(ctx.tool);
}

function classifyProtectedPath(
  rawPath: string,
  allArgText: string,
  testEditsAllowed: boolean,
): string | undefined {
  const path = normalizePolicyPath(rawPath);
  if (!path) return undefined;

  if (/(^|[\s/])packages\/pappy-core(?:\/|$)/.test(path)) {
    return "pappy-core verifier files are protected";
  }
  if (/(^|[\s/])packages\/pappy-eval(?:\/|$)/.test(path)) {
    return "pappy-eval harness files are protected";
  }
  if (/(^|[\s/])(?:packages\/)?moonshiner[^/]*(?:\/|$)/.test(path)) {
    return "Moonshiner training-data files are protected";
  }
  if (/(^|[\s/])\.github\/workflows(?:\/|$)/.test(path)) {
    return "CI workflow control-plane files are protected";
  }
  if (/(^|[\s/])package\.json$/.test(path) && PACKAGE_SCRIPT_RE.test(allArgText)) {
    return "package.json scripts are protected";
  }
  if (/(^|[\s/])package\.json$/.test(path) && /\b(delete|remove|rm|del|move|rename)\b/i.test(allArgText)) {
    return "package.json control files are protected";
  }
  if (/(^|[\s/])(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$/.test(path)) {
    return "test runner config files are protected";
  }
  if (/(^|[\s/])(?:verifier|verifiers|eval|evals|evaluation|evaluations|judge|judges|qc[-_]?gate|acceptance[-_]?check)(?:\/|[-_.][^/]*\.(?:ts|tsx|js|jsx|json|ya?ml|toml)$)/.test(path)) {
    return "verifier/eval control-plane files are protected";
  }
  if (TEST_FILE_RE.test(path) && !testEditsAllowed) {
    return "test/spec files are protected unless the task explicitly allows test editing";
  }

  return undefined;
}

function evaluateProtectedPathPolicy(
  ctx: ToolGateContext,
  policy: ProtectedPathPolicyConfig | undefined,
): ProtectedPathViolation[] {
  if (policy?.enabled === false || isMaintenanceModeEnabled(policy)) return [];
  if (!isMutatingToolCall(ctx)) return [];

  const allArgText = collectStringValues(ctx.args).join("\n");
  const testEditsAllowed = taskExplicitlyAllowsTestEdits(ctx, policy);
  if (ctx.tool === "run_command" && PACKAGE_SCRIPT_RE.test(allArgText)) {
    return [{ path: allArgText.slice(0, 200), reason: "package.json scripts are protected" }];
  }
  const candidates =
    ctx.tool === "run_command"
      ? [typeof ctx.args["command"] === "string" ? ctx.args["command"] : "", ...collectPathLikeValues(ctx.args)]
      : collectPathLikeValues(ctx.args);

  const violations: ProtectedPathViolation[] = [];
  for (const candidate of candidates) {
    const reason = classifyProtectedPath(candidate, allArgText, testEditsAllowed);
    if (reason) {
      violations.push({ path: candidate, reason });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createMirandaGate — build a standard Miranda gate.
 *
 * The returned object is stateless and safe to share across concurrent runs.
 */
export function createMirandaGate(config: MirandaGateConfig = {}): MirandaGate {
  const {
    allowedModels,
    allowedTools,
    protectedPathPolicy,
    verbose = false,
    onGate,
    ahpPacket,
    checkConstraint,
    onViolation,
  } = config;

  // Conservative starting defaults — visibility-first, not tuned to a
  // measured limit. WARN-only; never blocks a call.
  const contextBudget = {
    maxToolsExposed: config.contextBudget?.maxToolsExposed ?? 40,
    maxToolSchemaChars: config.contextBudget?.maxToolSchemaChars ?? 20_000,
    maxHistoryChars: config.contextBudget?.maxHistoryChars ?? 40_000,
  };

  function log(msg: string): void {
    if (verbose) console.error(`[Miranda] ${msg}`);
  }

  function report(
    gate: GateName,
    result: GateResult,
    ctx: LLMCallGateContext | ToolGateContext | QCGateContext,
  ): GateResult {
    onGate?.(gate, result, ctx);
    return result;
  }

  return {
    // ── LLM gates ────────────────────────────────────────────────────────

    beforeLLMCall(ctx): GateResult {
      const violations: string[] = [];

      if (ctx.budgetUsed >= ctx.budgetLimit) {
        violations.push(
          `Budget exceeded: $${ctx.budgetUsed.toFixed(6)} used, limit $${ctx.budgetLimit}`,
        );
      }

      if (allowedModels && !allowedModels.includes(ctx.model)) {
        violations.push(`Model "${ctx.model}" not in allowlist`);
      }

      if (violations.length > 0) {
        const result: GateResult = {
          allowed: false,
          reason: violations.join(" | "),
          violations,
          verdict: deriveVerdict(false, violations),
        };
        log(`before_llm_call BLOCKED  stage=${ctx.stage}  ${result.reason}`);
        return report("before_llm_call", result, ctx);
      }

      // Non-blocking context-size checks. Only run for fields the caller
      // actually populated — undefined fields skip their check silently.
      const warnings: string[] = [];
      if (ctx.toolsExposedCount !== undefined && ctx.toolsExposedCount > contextBudget.maxToolsExposed) {
        warnings.push(
          `Specialist received unusually many tools: ${ctx.toolsExposedCount} (budget ${contextBudget.maxToolsExposed})`,
        );
      }
      if (ctx.toolSchemaChars !== undefined && ctx.toolSchemaChars > contextBudget.maxToolSchemaChars) {
        warnings.push(
          `Tool schema unusually large: ${ctx.toolSchemaChars} chars (budget ${contextBudget.maxToolSchemaChars})`,
        );
      }
      if (ctx.historyChars !== undefined && ctx.historyChars > contextBudget.maxHistoryChars) {
        warnings.push(
          `Context exceeds expected role budget: history ${ctx.historyChars} chars (budget ${contextBudget.maxHistoryChars})`,
        );
      }

      const result: GateResult = {
        allowed: true,
        reason: `stage=${ctx.stage}  model=${ctx.model}  budget=$${ctx.budgetUsed.toFixed(4)}/$${ctx.budgetLimit}`,
        ...(warnings.length > 0 && { warnings }),
        verdict: deriveVerdict(true, undefined, warnings),
      };
      if (warnings.length > 0) {
        log(`before_llm_call WARN  stage=${ctx.stage}  ${warnings.join(" | ")}`);
      } else {
        log(`before_llm_call OK  ${result.reason}`);
      }
      return report("before_llm_call", result, ctx);
    },

    afterLLMCall(ctx, _output, validation): GateResult {
      if (!validation.valid) {
        const violations = validation.errors ?? ["Output shape invalid"];
        const result: GateResult = {
          allowed: false,
          reason: `stage=${ctx.stage} output failed validation`,
          violations,
          verdict: deriveVerdict(false, violations),
        };
        log(
          `after_llm_call VIOLATIONS  stage=${ctx.stage}  ${violations.join("; ")}`,
        );
        return report("after_llm_call", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `stage=${ctx.stage} output shape valid`,
        verdict: deriveVerdict(true),
      };
      log(`after_llm_call OK  ${result.reason}`);
      return report("after_llm_call", result, ctx);
    },

    // ── Tool gates ───────────────────────────────────────────────────────

    beforeToolRun(ctx): GateResult {
      const violations: string[] = [];

      const workspaceViolations = evaluateWorkspaceBoundary(ctx);
      if (workspaceViolations.length > 0) {
        const violationDetails = workspaceViolations.map(
          (violation) => `${violation.reason}: ${violation.path}`,
        );
        const result: GateResult = {
          allowed: false,
          reason: `Workspace boundary blocked tool "${ctx.tool}"`,
          violations: violationDetails,
          verdict: deriveVerdict(false, violationDetails),
        };
        log(`before_tool_run BLOCKED (workspace)  tool=${ctx.tool}  ${violationDetails.join("; ")}`);
        return report("before_tool_run", result, ctx);
      }

      const protectedPathViolations = evaluateProtectedPathPolicy(ctx, protectedPathPolicy);
      if (protectedPathViolations.length > 0) {
        const violationDetails = protectedPathViolations.map(
          (violation) => `${violation.reason}: ${violation.path}`,
        );
        const result: GateResult = {
          allowed: false,
          reason: `Protected path policy blocked tool "${ctx.tool}"`,
          violations: violationDetails,
          verdict: deriveVerdict(false, violationDetails),
        };
        log(`before_tool_run BLOCKED (protected path)  tool=${ctx.tool}  ${violationDetails.join("; ")}`);
        return report("before_tool_run", result, ctx);
      }

      // ── AHP: lifecycle guard ────────────────────────────────────────────
      // Tools may only execute when the packet lifecycle is RUNNING.
      if (ahpPacket !== undefined && ahpPacket.lifecycle !== AHPLifecycle.RUNNING) {
        const result: GateResult = {
          allowed: false,
          reason: `AHP lifecycle gate: tool execution requires lifecycle=RUNNING, got ${ahpPacket.lifecycle}`,
          violations: [`AHP lifecycle is ${ahpPacket.lifecycle} — tool execution not permitted`],
          verdict: deriveVerdict(false),
        };
        log(`before_tool_run BLOCKED (AHP lifecycle)  tool=${ctx.tool}  lifecycle=${ahpPacket.lifecycle}`);
        return report("before_tool_run", result, ctx);
      }

      // ── AHP: constraint enforcement ─────────────────────────────────────
      // If a constraint evaluator is provided, test every constraint now.
      // A single violation blocks execution and triggers the onViolation hook.
      if (ahpPacket !== undefined && checkConstraint !== undefined) {
        const violated = ahpPacket.constraints.filter(
          (c) => !checkConstraint(c, ctx),
        );
        if (violated.length > 0) {
          const ruleList = violated.map((c) => `"${c.rule}" (enforcer: ${c.enforcer})`).join(", ");
          onViolation?.(ahpPacket, violated);
          const violationDetails = violated.map((c) =>
            `VIOLATION — rule: ${c.rule}  enforcer: ${c.enforcer} (verdict set to ${AHPVerdict.VIOLATION})`,
          );
          const result: GateResult = {
            allowed: false,
            reason: `AHP constraint violation: ${ruleList}`,
            violations: violationDetails,
            verdict: deriveVerdict(false, violationDetails),
          };
          log(`before_tool_run BLOCKED (AHP constraint)  tool=${ctx.tool}  rules=${ruleList}`);
          return report("before_tool_run", result, ctx);
        }
      }

      if (allowedTools && !allowedTools.includes(ctx.tool)) {
        violations.push(`Tool "${ctx.tool}" not in allowlist`);
      }

      const nullArgs = Object.entries(ctx.args)
        .filter(([, v]) => v === null || v === undefined)
        .map(([k]) => k);
      if (nullArgs.length > 0) {
        violations.push(
          `Tool "${ctx.tool}" received null/undefined args: ${nullArgs.join(", ")}`,
        );
      }

      // Required field validation
      if (ctx.schema?.required) {
        const missing = ctx.schema.required.filter(
          field =>
            !(field in ctx.args) ||
            ctx.args[field] === null ||
            ctx.args[field] === undefined ||
            ctx.args[field] === ""
        );
        if (missing.length > 0) {
          violations.push(
            `Tool "${ctx.tool}" missing required fields: ${missing.join(", ")}`
          );
        }
      }

      // Type validation for fields that are present
      if (ctx.schema?.properties) {
        for (const [field, def] of Object.entries(ctx.schema.properties)) {
          if (
            field in ctx.args &&
            ctx.args[field] !== null &&
            ctx.args[field] !== undefined
          ) {
            const actualType = typeof ctx.args[field];
            if (actualType !== def.type) {
              violations.push(
                `Tool "${ctx.tool}" field "${field}" must be ${def.type}, got ${actualType}`
              );
            }
          }
        }
      }

      if (violations.length > 0) {
        const result: GateResult = {
          allowed: false,
          reason: violations.join(" | "),
          violations,
          verdict: deriveVerdict(false, violations),
        };
        log(`before_tool_run BLOCKED  tool=${ctx.tool}  ${result.reason}`);
        return report("before_tool_run", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `tool="${ctx.tool}" allowed`,
        verdict: deriveVerdict(true),
      };
      log(`before_tool_run OK  ${result.reason}`);
      return report("before_tool_run", result, ctx);
    },

    afterToolRun(ctx, toolResult): GateResult {
      if (!toolResult.ok) {
        const result: GateResult = {
          allowed: false,
          reason: `tool="${ctx.tool}" failed — no valid receipt`,
          violations: [`Tool error: ${toolResult.output.slice(0, 200)}`],
          verdict: deriveVerdict(false),
        };
        log(`after_tool_run BLOCKED  ${result.reason}`);
        return report("after_tool_run", result, ctx);
      }

      if (!toolResult.output || toolResult.output.trim().length === 0) {
        const result: GateResult = {
          allowed: false,
          reason: `tool="${ctx.tool}" returned empty output — receipt missing`,
          violations: ["Empty tool output"],
          verdict: deriveVerdict(false),
        };
        log(`after_tool_run BLOCKED  ${result.reason}`);
        return report("after_tool_run", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `tool="${ctx.tool}" receipt captured (${toolResult.output.length} chars)`,
        verdict: deriveVerdict(true),
      };
      log(`after_tool_run OK  ${result.reason}`);
      return report("after_tool_run", result, ctx);
    },

    // ── QC gates ─────────────────────────────────────────────────────────

    beforeQC(ctx): GateResult {
      if (!ctx.outputText || ctx.outputText.trim().length === 0) {
        const result: GateResult = {
          allowed: false,
          reason: "QC blocked — output text is empty",
          violations: ["No output to evaluate"],
          verdict: deriveVerdict(false),
        };
        log(`before_qc BLOCKED  taskId=${ctx.taskId}`);
        return report("before_qc", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `output ready for QC  taskId=${ctx.taskId}  length=${ctx.outputText.length}`,
        verdict: deriveVerdict(true),
      };
      log(`before_qc OK  ${result.reason}`);
      return report("before_qc", result, ctx);
    },

    afterQC(ctx, verdict, issueCount): GateResult {
      // Accept any value defined in the AHPVerdict protocol vocabulary.
      // Previously this list was hardcoded to {PASS, WARN, FAIL} and rejected
      // INCONCLUSIVE / VIOLATION even though they are legitimate verdicts
      // produced by Pappy's AHP evaluator and Miranda's own violation path.
      const known = new Set<string>(Object.values(AHPVerdict));
      if (!known.has(verdict)) {
        const result: GateResult = {
          allowed: false,
          reason: `QC produced unrecognized verdict: "${verdict}"`,
          violations: [`Unknown verdict: ${verdict}`],
          verdict: deriveVerdict(false),
        };
        log(`after_qc ERROR  ${result.reason}`);
        return report("after_qc", result, ctx);
      }

      const missingReceiptRefs = ctx.missingReceiptRefs ?? [];
      if (missingReceiptRefs.length > 0 && (verdict === "PASS" || verdict === "WARN")) {
        const violations = [`Missing required receipts: ${missingReceiptRefs.join(", ")}`];
        const result: GateResult = {
          allowed: false,
          reason: `QC consistency violation: verdict=${verdict} with ${missingReceiptRefs.length} missing required receipt(s)`,
          violations,
          verdict: deriveVerdict(false, violations),
        };
        log(`after_qc BLOCKED  ${result.reason}`);
        return report("after_qc", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `verdict=${verdict}  issues=${issueCount}  taskId=${ctx.taskId}`,
        verdict: deriveVerdict(true),
      };
      log(`after_qc OK  ${result.reason}`);
      return report("after_qc", result, ctx);
    },
  };
}
