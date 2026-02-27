/**
 * Miranda Core — JSON Validation Tests
 */

import { describe, it, expect } from "vitest";
import { validateJson } from "./validateJson.js";
import { PlanSchema } from "../contracts/plan.js";
import { CritiqueSchema } from "../contracts/critique.js";

describe("validateJson", () => {
  it("passes valid PLAN JSON", () => {
    const validPlan = JSON.stringify({
      restatement: "User wants to understand binary search",
      assumptions: ["User knows arrays"],
      constraints: ["Use Python"],
      approach_steps: ["Explain concept", "Show code"],
      risks: ["Complexity may be unclear"],
      questions: [],
    });

    const result = validateJson(validPlan, PlanSchema);
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it("fails on invalid JSON syntax", () => {
    const result = validateJson("{ this is not json }", PlanSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain("Invalid JSON");
  });

  it("fails on schema mismatch (missing required field)", () => {
    const incomplete = JSON.stringify({
      restatement: "Something",
      // missing: assumptions, constraints, approach_steps, risks, questions
    });

    const result = validateJson(incomplete, PlanSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("fails on empty input", () => {
    const result = validateJson("", PlanSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output is empty or whitespace-only");
  });

  it("fails on whitespace-only input", () => {
    const result = validateJson("   \n\t  ", PlanSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output is empty or whitespace-only");
  });

  it("strips markdown code fences and validates", () => {
    const fenced =
      '```json\n' +
      JSON.stringify({
        restatement: "Test restatement",
        assumptions: [],
        constraints: [],
        approach_steps: ["Step 1"],
        risks: [],
        questions: [],
      }) +
      "\n```";

    const result = validateJson(fenced, PlanSchema);
    expect(result.valid).toBe(true);
  });

  it("validates CRITIQUE schema correctly", () => {
    const validCritique = JSON.stringify({
      issues: [
        { severity: "low", issue: "Minor issue", impact: "Low impact" },
      ],
      fixes: [{ fix: "Add detail", reason: "Clarity" }],
      missing: ["Edge case discussion"],
      confidence: "high",
    });

    const result = validateJson(validCritique, CritiqueSchema);
    expect(result.valid).toBe(true);
  });

  it("fails CRITIQUE with invalid severity", () => {
    const invalid = JSON.stringify({
      issues: [
        { severity: "critical", issue: "Bad thing", impact: "Bad impact" },
      ],
      fixes: [],
      missing: [],
      confidence: "high",
    });

    const result = validateJson(invalid, CritiqueSchema);
    expect(result.valid).toBe(false);
  });

  it("returns parsed data even on schema failure", () => {
    const validJsonButBadSchema = JSON.stringify({
      restatement: "Something",
      extra: "field",
    });

    const result = validateJson(validJsonButBadSchema, PlanSchema);
    expect(result.valid).toBe(false);
    expect(result.data).toBeDefined(); // JSON parsed, just failed schema
  });
});
