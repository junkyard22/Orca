import { describe, it, expect } from "vitest";
import { allFixtures } from "../fixtures/index.js";
import { judgeRun } from "./judgeRun.js";
import { runEval } from "../runner/runEval.js";

describe("judgeRun against eval fixtures", () => {
  for (const fixture of allFixtures) {
    it(`${fixture.id}: verdict=${fixture.expectedVerdict} eligibility=${fixture.expectedTrainingEligibility}`, () => {
      const actual = judgeRun(fixture);
      expect(actual.verdict).toBe(fixture.expectedVerdict);
      expect(actual.trainingEligibility).toBe(fixture.expectedTrainingEligibility);
      expect(actual.confidence).toBeGreaterThanOrEqual(0);
      expect(actual.confidence).toBeLessThanOrEqual(1);
    });
  }

  it("produces well-formed output for every fixture", () => {
    for (const fixture of allFixtures) {
      const actual = judgeRun(fixture);
      expect(["accept", "repair", "reject", "needs_human_review"]).toContain(actual.verdict);
      expect(["eligible", "accepted_but_not_trainable", "needs_human_review", "rejected"]).toContain(
        actual.trainingEligibility,
      );
      expect(Array.isArray(actual.deterministicFindings)).toBe(true);
      expect(Array.isArray(actual.evidenceUsed)).toBe(true);
      expect(Array.isArray(actual.failureReasons)).toBe(true);
      expect(typeof actual.recommendedRepair).toBe("string");
      if (actual.verdict === "accept" && actual.trainingEligibility === "eligible") {
        expect(actual.failureReasons).toEqual([]);
        expect(actual.recommendedRepair).toBe("");
      }
    }
  });
});

describe("eval harness aggregate metrics", () => {
  const { metrics } = runEval(allFixtures, judgeRun);

  it("catches every cheat-category fixture (no false accepts)", () => {
    expect(metrics.cheatCatchRate).toBe(1);
    expect(metrics.falseAcceptRate).toBe(0);
  });

  it("never rejects a clean-success run", () => {
    expect(metrics.falseRejectRate).toBe(0);
  });

  it("only marks trainingEligibility eligible when the fixture is actually eligible", () => {
    expect(metrics.trainingEligibilityPrecision).toBe(1);
  });

  it("grounds all cited evidence in the source packet", () => {
    expect(metrics.evidenceGroundingScore).toBe(1);
  });

  it("passes every fixture end to end", () => {
    expect(metrics.passed).toBe(metrics.total);
    expect(metrics.failed).toBe(0);
  });
});
