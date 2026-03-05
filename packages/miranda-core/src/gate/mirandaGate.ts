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
 *   after_qc         → verdict well-formed and logged?
 */

// ---------------------------------------------------------------------------
// Result & context shapes
// ---------------------------------------------------------------------------

export interface GateResult {
  allowed: boolean;
  reason: string;
  violations?: string[];
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
}

export interface ToolGateContext {
  /** Registered tool name */
  tool: string;
  /** Arguments the agent is passing to the tool */
  args: Record<string, unknown>;
}

export interface QCGateContext {
  /** Run ID for correlating gate events with other trace events */
  taskId: string;
  /** Text that Pappy will (or just did) evaluate */
  outputText: string;
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

  /** Stage: QC — after Pappy verdict. */
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
  const { allowedModels, allowedTools, verbose = false, onGate } = config;

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
        };
        log(`before_llm_call BLOCKED  stage=${ctx.stage}  ${result.reason}`);
        return report("before_llm_call", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `stage=${ctx.stage}  model=${ctx.model}  budget=$${ctx.budgetUsed.toFixed(4)}/$${ctx.budgetLimit}`,
      };
      log(`before_llm_call OK  ${result.reason}`);
      return report("before_llm_call", result, ctx);
    },

    afterLLMCall(ctx, _output, validation): GateResult {
      if (!validation.valid) {
        const violations = validation.errors ?? ["Output shape invalid"];
        const result: GateResult = {
          allowed: false,
          reason: `stage=${ctx.stage} output failed validation`,
          violations,
        };
        log(
          `after_llm_call VIOLATIONS  stage=${ctx.stage}  ${violations.join("; ")}`,
        );
        return report("after_llm_call", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `stage=${ctx.stage} output shape valid`,
      };
      log(`after_llm_call OK  ${result.reason}`);
      return report("after_llm_call", result, ctx);
    },

    // ── Tool gates ───────────────────────────────────────────────────────

    beforeToolRun(ctx): GateResult {
      const violations: string[] = [];

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

      if (violations.length > 0) {
        const result: GateResult = {
          allowed: false,
          reason: violations.join(" | "),
          violations,
        };
        log(`before_tool_run BLOCKED  tool=${ctx.tool}  ${result.reason}`);
        return report("before_tool_run", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `tool="${ctx.tool}" allowed`,
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
        };
        log(`after_tool_run WARN  ${result.reason}`);
        return report("after_tool_run", result, ctx);
      }

      if (!toolResult.output || toolResult.output.trim().length === 0) {
        const result: GateResult = {
          allowed: false,
          reason: `tool="${ctx.tool}" returned empty output — receipt missing`,
          violations: ["Empty tool output"],
        };
        log(`after_tool_run WARN  ${result.reason}`);
        return report("after_tool_run", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `tool="${ctx.tool}" receipt captured (${toolResult.output.length} chars)`,
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
        };
        log(`before_qc BLOCKED  taskId=${ctx.taskId}`);
        return report("before_qc", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `output ready for QC  taskId=${ctx.taskId}  length=${ctx.outputText.length}`,
      };
      log(`before_qc OK  ${result.reason}`);
      return report("before_qc", result, ctx);
    },

    afterQC(ctx, verdict, issueCount): GateResult {
      const known = new Set(["PASS", "WARN", "FAIL"]);
      if (!known.has(verdict)) {
        const result: GateResult = {
          allowed: false,
          reason: `QC produced unrecognized verdict: "${verdict}"`,
          violations: [`Unknown verdict: ${verdict}`],
        };
        log(`after_qc ERROR  ${result.reason}`);
        return report("after_qc", result, ctx);
      }

      const result: GateResult = {
        allowed: true,
        reason: `verdict=${verdict}  issues=${issueCount}  taskId=${ctx.taskId}`,
      };
      log(`after_qc OK  ${result.reason}`);
      return report("after_qc", result, ctx);
    },
  };
}
