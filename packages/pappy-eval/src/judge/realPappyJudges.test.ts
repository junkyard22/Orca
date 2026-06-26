import { describe, it, expect } from "vitest";
import { allFixtures } from "../fixtures/index.js";
import { rawRealPappyJudge } from "./rawRealPappyJudge.js";
import { pappyPlusHardeningJudge } from "./pappyPlusHardeningJudge.js";
import { runEval } from "../runner/runEval.js";

// These judges call the real packages/pappy-core implementation. Unlike the
// reference judge's test suite, we do NOT assert verdict/trainingEligibility
// correctness here — these are shape/no-crash tests. See GAPS.md for the
// actual measured accuracy, and `pnpm eval:raw-real-pappy` /
// `pnpm eval:pappy-plus-hardening` for the live numbers. Asserting "must
// match expectedVerdict" here would either be a perpetually-red test (for
// raw-real-pappy, which is known to miss most cheat categories today) or
// would silently start failing the moment pappy-core's heuristics change —
// neither is useful as a CI gate.
const REAL_JUDGES = [
  ["raw-real-pappy", rawRealPappyJudge] as const,
  ["pappy-plus-hardening", pappyPlusHardeningJudge] as const,
];

describe.each(REAL_JUDGES)("%s produces well-formed JudgeOutput", (_name, judge) => {
  for (const fixture of allFixtures) {
    it(`${fixture.id} does not throw and returns a valid shape`, () => {
      const actual = judge(fixture);
      expect(["accept", "repair", "reject", "needs_human_review"]).toContain(actual.verdict);
      expect(["eligible", "accepted_but_not_trainable", "needs_human_review", "rejected"]).toContain(
        actual.trainingEligibility,
      );
      expect(actual.confidence).toBeGreaterThanOrEqual(0);
      expect(actual.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(actual.deterministicFindings)).toBe(true);
      expect(Array.isArray(actual.evidenceUsed)).toBe(true);
      expect(Array.isArray(actual.failureReasons)).toBe(true);
      expect(typeof actual.recommendedRepair).toBe("string");
    });
  }
});

describe("pappy-plus-hardening still catches every cheat-category fixture", () => {
  // The hardening layer is the harness's own deterministic checks (same as
  // the reference judge), so this much SHOULD hold regardless of what real
  // Pappy's semantic verdict does — if this regresses, the hardening layer
  // itself broke, not pappy-core.
  const { metrics } = runEval(allFixtures, pappyPlusHardeningJudge);

  it("has a 100% cheat catch rate", () => {
    expect(metrics.cheatCatchRate).toBe(1);
    expect(metrics.falseAcceptRate).toBe(0);
  });
});
