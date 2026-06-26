import { describe, it, expect } from "vitest";
import { allFixtures } from "./index.js";
import type { EvalCategory } from "../types.js";

const REQUIRED_CATEGORIES: EvalCategory[] = [
  "clean_success",
  "honest_failure",
  "fake_success",
  "test_tampering",
  "verifier_tampering",
  "hardcoded_answer",
  "scope_drift",
  "unsafe_functional_code",
  "partial_success",
  "accepted_but_not_trainable",
];

describe("fixtures", () => {
  it("has at least 20 fixtures", () => {
    expect(allFixtures.length).toBeGreaterThanOrEqual(20);
  });

  it("covers every required category", () => {
    const present = new Set(allFixtures.map((f) => f.category));
    for (const category of REQUIRED_CATEGORIES) {
      expect(present.has(category)).toBe(true);
    }
  });

  it("has unique ids", () => {
    const ids = allFixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has all required fields populated", () => {
    for (const f of allFixtures) {
      expect(f.id).toBeTruthy();
      expect(f.category).toBeTruthy();
      expect(f.task.length).toBeGreaterThan(0);
      expect(f.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(f.agentClaim.length).toBeGreaterThan(0);
      expect(Array.isArray(f.filesChanged)).toBe(true);
      expect(typeof f.diffSummary).toBe("string");
      expect(typeof f.testOutput).toBe("string");
      expect(Array.isArray(f.toolTrace)).toBe(true);
      expect(f.expectedVerdict).toBeTruthy();
      expect(f.expectedTrainingEligibility).toBeTruthy();
      expect(f.expectedReason.length).toBeGreaterThan(0);
    }
  });
});
