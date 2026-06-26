/**
 * Miranda Gate — GateVerdict enrichment tests.
 *
 * Proves:
 *   1. Old callers using `allowed` still pass (backward compat)
 *   2. Successful gate results include `verdict: "PASS"`
 *   3. Blocked gate results include `verdict: "BLOCK"`
 *   4. WARN is not emitted yet — reserved for future non-blocking advisory gates
 *   5. CONFIRM_REQUIRED is not emitted yet
 *   6. verdict contract: PASS/WARN ↔ allowed:true, BLOCK/CONFIRM_REQUIRED ↔ allowed:false
 *   7. No runtime behavior changes — `allowed` remains authoritative
 *   8. No deprecated Miranda pipeline behavior is reactivated
 */

import { describe, it, expect } from "vitest";
import {
  createMirandaGate,
  transitionAHPLifecycle,
  type GateResult,
  type GateVerdict,
  type LLMCallGateContext,
  type ToolGateContext,
  type QCGateContext,
} from "./mirandaGate.js";
import { AHPLifecycle } from "../ahp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLLMCtx(overrides?: Partial<LLMCallGateContext>): LLMCallGateContext {
  return {
    stage: "answer",
    model: "deepseek/deepseek-chat",
    budgetUsed: 0.001,
    budgetLimit: 1.0,
    ...overrides,
  };
}

function makeToolCtx(overrides?: Partial<ToolGateContext>): ToolGateContext {
  return {
    tool: "write_file",
    args: { path: "/tmp/test.txt", content: "hello" },
    ...overrides,
  };
}

function makeQCCtx(overrides?: Partial<QCGateContext>): QCGateContext {
  return {
    taskId: "test-task-1",
    outputText: "Some meaningful output text for QC evaluation.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Backward compatibility — `allowed` still works exactly as before
// ---------------------------------------------------------------------------

describe("GateResult backward compatibility", () => {
  const gate = createMirandaGate();

  it("beforeLLMCall returns allowed:true for valid context", () => {
    const r = gate.beforeLLMCall(makeLLMCtx());
    expect(r.allowed).toBe(true);
    expect(typeof r.reason).toBe("string");
  });

  it("beforeLLMCall returns allowed:false when budget exceeded", () => {
    const r = gate.beforeLLMCall(makeLLMCtx({ budgetUsed: 5.0, budgetLimit: 1.0 }));
    expect(r.allowed).toBe(false);
  });

  it("afterLLMCall returns allowed:true for valid output", () => {
    const r = gate.afterLLMCall(makeLLMCtx(), "output", { valid: true });
    expect(r.allowed).toBe(true);
  });

  it("afterLLMCall returns allowed:false for invalid output", () => {
    const r = gate.afterLLMCall(makeLLMCtx(), "bad", { valid: false, errors: ["bad format"] });
    expect(r.allowed).toBe(false);
  });

  it("beforeToolRun returns allowed:true for valid tool", () => {
    const r = gate.beforeToolRun(makeToolCtx());
    expect(r.allowed).toBe(true);
  });

  it("beforeToolRun returns allowed:false for disallowed tool", () => {
    const restrictedGate = createMirandaGate({ allowedTools: ["read_file"] });
    const r = restrictedGate.beforeToolRun(makeToolCtx({ tool: "delete_file" }));
    expect(r.allowed).toBe(false);
  });

  it("afterToolRun returns allowed:true for successful tool result", () => {
    const r = gate.afterToolRun(makeToolCtx(), { ok: true, output: "done" });
    expect(r.allowed).toBe(true);
  });

  it("beforeQC returns allowed:true for non-empty output", () => {
    const r = gate.beforeQC(makeQCCtx());
    expect(r.allowed).toBe(true);
  });

  it("beforeQC returns allowed:false for empty output", () => {
    const r = gate.beforeQC(makeQCCtx({ outputText: "" }));
    expect(r.allowed).toBe(false);
  });

  it("afterQC returns allowed:true for recognized verdict", () => {
    const r = gate.afterQC(makeQCCtx(), "PASS", 0);
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GateVerdict enrichment — PASS
// ---------------------------------------------------------------------------

describe("GateVerdict: PASS on allowed results", () => {
  const gate = createMirandaGate();

  it("beforeLLMCall — verdict is PASS", () => {
    const r = gate.beforeLLMCall(makeLLMCtx());
    expect(r.verdict).toBe("PASS");
  });

  it("afterLLMCall — verdict is PASS", () => {
    const r = gate.afterLLMCall(makeLLMCtx(), "output", { valid: true });
    expect(r.verdict).toBe("PASS");
  });

  it("beforeToolRun — verdict is PASS", () => {
    const r = gate.beforeToolRun(makeToolCtx());
    expect(r.verdict).toBe("PASS");
  });

  it("afterToolRun — verdict is PASS", () => {
    const r = gate.afterToolRun(makeToolCtx(), { ok: true, output: "done" });
    expect(r.verdict).toBe("PASS");
  });

  it("beforeQC — verdict is PASS", () => {
    const r = gate.beforeQC(makeQCCtx());
    expect(r.verdict).toBe("PASS");
  });

  it("afterQC — verdict is PASS", () => {
    const r = gate.afterQC(makeQCCtx(), "PASS", 0);
    expect(r.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// GateVerdict enrichment — BLOCK
// ---------------------------------------------------------------------------

describe("GateVerdict: BLOCK on denied results", () => {
  const gate = createMirandaGate();

  it("beforeLLMCall — verdict is BLOCK on budget exceeded", () => {
    const r = gate.beforeLLMCall(makeLLMCtx({ budgetUsed: 5.0, budgetLimit: 1.0 }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });

  it("beforeLLMCall — verdict is BLOCK on model not in allowlist", () => {
    const restrictedGate = createMirandaGate({ allowedModels: ["gpt-4"] });
    const r = restrictedGate.beforeLLMCall(makeLLMCtx({ model: "unknown-model" }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });

  it("afterLLMCall — verdict is BLOCK on validation failure", () => {
    const r = gate.afterLLMCall(makeLLMCtx(), "bad", { valid: false, errors: ["err"] });
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });

  it("beforeToolRun — verdict is BLOCK on disallowed tool", () => {
    const restrictedGate = createMirandaGate({ allowedTools: ["read_file"] });
    const r = restrictedGate.beforeToolRun(makeToolCtx({ tool: "rm_rf" }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });

  it("beforeQC — verdict is BLOCK on empty output", () => {
    const r = gate.beforeQC(makeQCCtx({ outputText: "" }));
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });

  it("afterQC — verdict is BLOCK on unrecognized verdict", () => {
    const r = gate.afterQC(makeQCCtx(), "BOGUS_VERDICT", 0);
    expect(r.verdict).toBe("BLOCK");
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GateVerdict: afterToolRun failure cases are BLOCK (not WARN)
// ---------------------------------------------------------------------------

describe("GateVerdict: afterToolRun failures are BLOCK", () => {
  const gate = createMirandaGate();

  it("afterToolRun — verdict is BLOCK when tool failed (no receipt)", () => {
    const r = gate.afterToolRun(makeToolCtx(), { ok: false, output: "error: something broke" });
    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("BLOCK");
  });

  it("afterToolRun — verdict is BLOCK when tool returned empty output", () => {
    const r = gate.afterToolRun(makeToolCtx(), { ok: true, output: "" });
    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("BLOCK");
  });
});

// ---------------------------------------------------------------------------
// Protected path policy
// ---------------------------------------------------------------------------

describe("Protected path policy", () => {
  it("blocks mutating tools from editing pappy-core verifier files", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "edit_file",
      args: {
        path: "packages/pappy-core/src/checks/completeness.ts",
        content: "weaken verifier",
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.verdict).toBe("BLOCK");
    expect(r.violations?.join(" ")).toContain("pappy-core");
  });

  it("does not let tool arguments self-authorize maintenance mode", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "edit_file",
      args: {
        path: "packages/pappy-eval/src/fixtures/fakeSuccess.ts",
        maintenanceMode: { userApproved: true, reason: "agent requested bypass" },
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.violations?.join(" ")).toContain("pappy-eval");
  });

  it("allows protected edits only when runtime config carries user-approved maintenance mode", () => {
    const gate = createMirandaGate({
      protectedPathPolicy: {
        maintenanceMode: {
          userApproved: true,
          reason: "User approved verifier maintenance",
        },
      },
    });

    const r = gate.beforeToolRun(makeToolCtx({
      tool: "edit_file",
      args: {
        path: "packages/pappy-core/src/checks/completeness.ts",
        content: "legitimate maintenance",
      },
    }));

    expect(r.allowed).toBe(true);
    expect(r.verdict).toBe("PASS");
  });

  it("blocks package.json script edits", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "write_file",
      args: {
        path: "package.json",
        content: '{ "scripts": { "test": "true" } }',
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.violations?.join(" ")).toContain("package.json scripts");
  });

  it("blocks test file edits unless the task explicitly allows editing tests", () => {
    const gate = createMirandaGate();
    const blocked = gate.beforeToolRun(makeToolCtx({
      tool: "write_file",
      taskText: "Fix the date formatter implementation.",
      args: {
        path: "packages/utils-core/src/date.test.ts",
        content: "expect(formatDate()).toBe('today')",
      },
    }));
    expect(blocked.allowed).toBe(false);

    const allowed = gate.beforeToolRun(makeToolCtx({
      tool: "write_file",
      taskText: "Add unit tests for the date formatter.",
      args: {
        path: "packages/utils-core/src/date.test.ts",
        content: "expect(formatDate()).toBe('today')",
      },
    }));
    expect(allowed.allowed).toBe(true);
  });

  it("allows read-only access to protected files", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "read_file",
      args: { path: "packages/pappy-core/src/checks/completeness.ts" },
    }));

    expect(r.allowed).toBe(true);
  });

  it("blocks mutating shell commands that target protected files", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "run_command",
      args: {
        command: "Set-Content packages/pappy-core/src/checks/completeness.ts 'pass everything'",
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.violations?.join(" ")).toContain("pappy-core");
  });

  it("blocks shell commands that mutate package scripts without naming package.json", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "run_command",
      args: {
        command: "npm pkg set scripts.test=true",
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.violations?.join(" ")).toContain("package.json scripts");
  });

  it("blocks mutating shell commands that target test files without explicit test-edit intent", () => {
    const gate = createMirandaGate();
    const r = gate.beforeToolRun(makeToolCtx({
      tool: "run_command",
      taskText: "Fix the date formatter implementation.",
      args: {
        command: "Set-Content src/date.test.ts 'weakened test'",
      },
    }));

    expect(r.allowed).toBe(false);
    expect(r.violations?.join(" ")).toContain("test/spec files");
  });
});

// ---------------------------------------------------------------------------
// WARN and CONFIRM_REQUIRED are not emitted yet
// ---------------------------------------------------------------------------

describe("GateVerdict: WARN and CONFIRM_REQUIRED not emitted", () => {
  const gate = createMirandaGate();

  it("no gate checkpoint currently emits WARN", () => {
    // Exhaustive check: every result produced by the gate factory should
    // be either PASS or BLOCK. WARN is reserved for future non-blocking
    // advisory gates where allowed:true but a concern is flagged.
    const restrictedGate = createMirandaGate({
      allowedModels: ["gpt-4"],
      allowedTools: ["read_file"],
    });

    const allResults: GateResult[] = [
      // PASS cases
      gate.beforeLLMCall(makeLLMCtx()),
      gate.afterLLMCall(makeLLMCtx(), "out", { valid: true }),
      gate.beforeToolRun(makeToolCtx()),
      gate.afterToolRun(makeToolCtx(), { ok: true, output: "ok" }),
      gate.beforeQC(makeQCCtx()),
      gate.afterQC(makeQCCtx(), "PASS", 0),
      // BLOCK cases
      gate.beforeLLMCall(makeLLMCtx({ budgetUsed: 5.0, budgetLimit: 1.0 })),
      gate.afterLLMCall(makeLLMCtx(), "bad", { valid: false }),
      restrictedGate.beforeToolRun(makeToolCtx({ tool: "bad-tool" })),
      gate.afterToolRun(makeToolCtx(), { ok: false, output: "err" }),
      gate.afterToolRun(makeToolCtx(), { ok: true, output: "" }),
      gate.beforeQC(makeQCCtx({ outputText: "" })),
      gate.afterQC(makeQCCtx(), "BOGUS", 0),
    ];

    for (const r of allResults) {
      expect(r.verdict).not.toBe("WARN");
    }
  });

  it("no gate checkpoint currently emits CONFIRM_REQUIRED", () => {
    const allResults: GateResult[] = [
      gate.beforeLLMCall(makeLLMCtx()),
      gate.afterLLMCall(makeLLMCtx(), "out", { valid: true }),
      gate.beforeToolRun(makeToolCtx()),
      gate.afterToolRun(makeToolCtx(), { ok: true, output: "ok" }),
      gate.beforeQC(makeQCCtx()),
      gate.afterQC(makeQCCtx(), "PASS", 0),
    ];

    for (const r of allResults) {
      expect(r.verdict).not.toBe("CONFIRM_REQUIRED");
    }
  });

  it("WARN would mean allowed:true (contract check)", () => {
    // Type-level assertion: a GateResult with WARN should have allowed:true.
    // This is not emitted yet, but the contract is defined for future use.
    const hypotheticalWarn: GateResult = {
      allowed: true,
      reason: "advisory: high token count",
      verdict: "WARN",
    };
    expect(hypotheticalWarn.allowed).toBe(true);
    expect(hypotheticalWarn.verdict).toBe("WARN");
  });
});

// ---------------------------------------------------------------------------
// GateVerdict type shape
// ---------------------------------------------------------------------------

describe("GateVerdict type shape", () => {
  it("GateVerdict includes all four values", () => {
    // Type-level check — if this compiles, the type is correct
    const verdicts: GateVerdict[] = ["PASS", "WARN", "BLOCK", "CONFIRM_REQUIRED"];
    expect(verdicts).toHaveLength(4);
  });

  it("verdict field is optional on GateResult (backward compat)", () => {
    // A GateResult without verdict should still satisfy the interface
    const minimal: GateResult = { allowed: true, reason: "test" };
    expect(minimal.verdict).toBeUndefined();
  });

  it("verdict field can be set on GateResult", () => {
    const enriched: GateResult = { allowed: true, reason: "test", verdict: "PASS" };
    expect(enriched.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// No runtime behavior changes — verdict does not affect allowed
// ---------------------------------------------------------------------------

describe("No runtime behavior change", () => {
  const gate = createMirandaGate();

  it("verdict PASS always accompanies allowed:true", () => {
    const results: GateResult[] = [
      gate.beforeLLMCall(makeLLMCtx()),
      gate.afterLLMCall(makeLLMCtx(), "out", { valid: true }),
      gate.beforeToolRun(makeToolCtx()),
      gate.afterToolRun(makeToolCtx(), { ok: true, output: "ok" }),
      gate.beforeQC(makeQCCtx()),
      gate.afterQC(makeQCCtx(), "PASS", 0),
    ];
    for (const r of results) {
      expect(r.allowed).toBe(true);
      expect(r.verdict).toBe("PASS");
    }
  });

  it("verdict BLOCK always accompanies allowed:false", () => {
    const restrictedGate = createMirandaGate({ allowedModels: ["gpt-4"], allowedTools: ["read_file"] });
    const results: GateResult[] = [
      restrictedGate.beforeLLMCall(makeLLMCtx({ model: "bad-model" })),
      gate.afterLLMCall(makeLLMCtx(), "bad", { valid: false }),
      restrictedGate.beforeToolRun(makeToolCtx({ tool: "bad-tool" })),
      gate.afterToolRun(makeToolCtx(), { ok: false, output: "err" }),
      gate.afterToolRun(makeToolCtx(), { ok: true, output: "" }),
      gate.beforeQC(makeQCCtx({ outputText: "" })),
      gate.afterQC(makeQCCtx(), "INVALID", 0),
    ];
    for (const r of results) {
      expect(r.allowed).toBe(false);
      expect(r.verdict).toBe("BLOCK");
    }
  });

  it("onGate callback still fires with enriched result", () => {
    const events: Array<{ gate: string; allowed: boolean; verdict?: string }> = [];
    const tracedGate = createMirandaGate({
      onGate: (gate, result) => {
        events.push({ gate, allowed: result.allowed, verdict: result.verdict });
      },
    });

    tracedGate.beforeLLMCall(makeLLMCtx());
    tracedGate.afterLLMCall(makeLLMCtx(), "out", { valid: true });

    expect(events).toHaveLength(2);
    expect(events[0]!.gate).toBe("before_llm_call");
    expect(events[0]!.allowed).toBe(true);
    expect(events[0]!.verdict).toBe("PASS");
    expect(events[1]!.gate).toBe("after_llm_call");
    expect(events[1]!.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Deprecated pipeline not reactivated
// ---------------------------------------------------------------------------

describe("No deprecated pipeline reactivation", () => {
  it("mirandaGate.ts does not import from pipeline modules", async () => {
    // Read the module source to verify no pipeline imports crept in
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./mirandaGate.ts", import.meta.url), "utf-8");
    expect(src).not.toContain("from \"../pipeline/mirandaPipeline");
    expect(src).not.toContain("from '../pipeline/mirandaPipeline");
    expect(src).not.toContain("runPipeline");
  });
});

// ---------------------------------------------------------------------------
// AHP lifecycle transition (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("AHP lifecycle transitions (unchanged)", () => {
  it("allows PENDING → RUNNING", () => {
    expect(() => transitionAHPLifecycle(AHPLifecycle.PENDING, AHPLifecycle.RUNNING)).not.toThrow();
  });

  it("blocks PENDING → COMPLETE", () => {
    expect(() => transitionAHPLifecycle(AHPLifecycle.PENDING, AHPLifecycle.COMPLETE)).toThrow(/Illegal/);
  });

  it("allows RUNNING → COMPLETE", () => {
    expect(() => transitionAHPLifecycle(AHPLifecycle.RUNNING, AHPLifecycle.COMPLETE)).not.toThrow();
  });
});
