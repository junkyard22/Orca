import { describe, it, expect } from "vitest";
import { runBrainChecks } from "./brain.js";
import type { PappyInput } from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const direct = (role: string, extras?: Record<string, unknown>) =>
  JSON.stringify({ routing: "direct", role, ...extras });

const decompose = (departments: unknown[]) =>
  JSON.stringify({ routing: "decompose", departments });

// ── Activation guard ─────────────────────────────────────────────────────────

describe("runBrainChecks — activation guard", () => {
  it("returns no issues for non-brain prose output", () => {
    const issues = runBrainChecks({ task: "calc", outputText: "2 plus 2 equals 4." });
    expect(issues).toHaveLength(0);
  });

  it("returns no issues when outputText is empty", () => {
    const issues = runBrainChecks({ task: "calc" } as PappyInput);
    expect(issues).toHaveLength(0);
  });

  it("returns no issues for JSON that has no 'routing' key", () => {
    const issues = runBrainChecks({ task: "t", outputText: '{"answer":42}' });
    expect(issues).toHaveLength(0);
  });

  it("returns no issues for JSON that has an unrelated routing value", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: '{"routing":"round-robin","destinations":["a","b"]}',
    });
    expect(issues).toHaveLength(0);
  });
});

// ── BRAIN_NARRATIVE_BLEED ────────────────────────────────────────────────────

describe("runBrainChecks — BRAIN_NARRATIVE_BLEED", () => {
  it("fires when prose precedes the JSON object", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: `Sure! ${direct("strong_model")}`,
    });
    const bleed = issues.filter(i => i.code === "BRAIN_NARRATIVE_BLEED");
    expect(bleed).toHaveLength(1);
    expect(bleed[0]!.severity).toBe("HIGH");
  });

  it("fires when prose follows the JSON object", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: `${direct("strong_model")} Hope that helps!`,
    });
    expect(issues.some(i => i.code === "BRAIN_NARRATIVE_BLEED")).toBe(true);
  });
});

// ── BRAIN_OUTPUT_MALFORMED ───────────────────────────────────────────────────

describe("runBrainChecks — BRAIN_OUTPUT_MALFORMED", () => {
  it("fires when JSON is syntactically invalid", () => {
    const issues = runBrainChecks({ task: "t", outputText: `{"routing": "direct", role: oops}` });
    expect(issues.some(i => i.code === "BRAIN_OUTPUT_MALFORMED")).toBe(true);
  });

  it("fires when routing field value is null (not a valid enum)", () => {
    const issues = runBrainChecks({ task: "t", outputText: `{"routing":null,"role":"strong_model"}` });
    expect(issues.some(i => i.code === "BRAIN_OUTPUT_MALFORMED")).toBe(true);
  });

  it("fires when routing value is not a valid enum member", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: `{"routing":"turbo","role":"strong_model"}`,
    });
    expect(issues.some(i => i.code === "BRAIN_OUTPUT_MALFORMED")).toBe(true);
  });

  it("fires for direct routing when role key is missing", () => {
    const issues = runBrainChecks({ task: "t", outputText: `{"routing":"direct"}` });
    // Missing role for direct routing should produce BRAIN_INVALID_ROLE or BRAIN_OUTPUT_MALFORMED
    expect(
      issues.some(i => i.code === "BRAIN_INVALID_ROLE" || i.code === "BRAIN_OUTPUT_MALFORMED"),
    ).toBe(true);
  });

  it("fires for decompose with an empty departments array", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: `{"routing":"decompose","departments":[]}`,
    });
    expect(issues.some(i => i.code === "BRAIN_OUTPUT_MALFORMED")).toBe(true);
  });
});

// ── BRAIN_INVALID_ROLE ───────────────────────────────────────────────────────

describe("runBrainChecks — BRAIN_INVALID_ROLE", () => {
  it("fires when role is not a recognised head name", () => {
    const issues = runBrainChecks({ task: "t", outputText: direct("wizard") });
    const inv = issues.filter(i => i.code === "BRAIN_INVALID_ROLE");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.severity).toBe("HIGH");
  });

  it("fires when a department head is not a recognised name", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: decompose([{ head: "wizard", task: "do x" }]),
    });
    expect(issues.some(i => i.code === "BRAIN_INVALID_ROLE")).toBe(true);
  });
});

// ── BRAIN_HALLUCINATED_FIELD ─────────────────────────────────────────────────

describe("runBrainChecks — BRAIN_HALLUCINATED_FIELD", () => {
  it("fires when an extra top-level key is present", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: direct("strong_model", { confidence: 0.9 }),
    });
    expect(issues.some(i => i.code === "BRAIN_HALLUCINATED_FIELD")).toBe(true);
  });
});

// ── Valid inputs — no issues ─────────────────────────────────────────────────

describe("runBrainChecks — valid inputs (expect no issues)", () => {
  it("passes a clean direct routing response", () => {
    expect(runBrainChecks({ task: "t", outputText: direct("strong_model") })).toHaveLength(0);
  });

  it("passes a pretty-printed direct routing response", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: `{
  "routing":
    "direct",
  "role": "strong_model"
}`,
    });
    expect(issues).toHaveLength(0);
  });

  it("passes all recognised roles for direct routing", () => {
    const roles = [
      "brain", "strong_model", "cheap_model", "utility",
      "reviewer", "narrator", "planner_deep", "debugger", "reader",
    ];
    for (const role of roles) {
      const issues = runBrainChecks({ task: "t", outputText: direct(role) });
      expect(issues, `role "${role}" should pass`).toHaveLength(0);
    }
  });

  it("passes a clean multi-department decompose response", () => {
    const issues = runBrainChecks({
      task: "t",
      outputText: decompose([
        { head: "strong_model", task: "implement the feature" },
        { head: "reviewer", task: "review the implementation" },
      ]),
    });
    expect(issues).toHaveLength(0);
  });
});
