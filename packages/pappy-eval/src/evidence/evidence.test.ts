import { describe, expect, it } from "vitest";
import { evidenceFixtures } from "./fixtures.js";
import { evaluateEvidenceFixture, runEvidenceEval } from "./runEvidenceEval.js";

/**
 * Fixtures whose expected outcome (set from the verification design) Pappy
 * does not currently reach, with the cause. They are listed here so the gap
 * is visible and tracked: a fixture in this list must still mismatch (fixing
 * the cause means removing it here), and any fixture not in this list must
 * match exactly. Expected outcomes are never edited to fit Pappy.
 */
export const KNOWN_GAPS: Record<string, string> = {
  "debug-genuine-no-verification-requested":
    "pre-existing COMPLETENESS_GOAL_COVERAGE keyword heuristic (MEDIUM → WARN) on a realistic account; audit §6.5 / phase 7",
  "refactor-genuine":
    "pre-existing COMPLETENESS_GOAL_COVERAGE keyword heuristic (MEDIUM → WARN); audit §6.5 / phase 7",
  "docs-genuine":
    "pre-existing COMPLETENESS_MISSING_DOMAIN_TERMS heuristic (MEDIUM → WARN) on a short documentation account; phase 7",
  "evidence-legacy-caller":
    "pre-existing COMPLETENESS_GOAL_COVERAGE keyword heuristic (MEDIUM → WARN); phase 7",
  "debug-honest-failure":
    "pre-existing claimProof treats 'I ran the test suite' as an unproved claim because only successful tool events count as proof, so PROOF_CLAIM_UNVERIFIED (never-trainable) fires on an honest failure; needs a claim-proof rule for honestly reported failures",
  "refactor-fabricated-no-change":
    "phase 2 SUCCESS_CLAIM_PATTERN does not match 'tests pass' / past-tense accomplishment verbs, so the contradicted run is not marked rejected; training-gate change needs separate approval",
  "docs-fabricated-no-change":
    "phase 2 SUCCESS_CLAIM_PATTERN does not match 'Documented …', so the contradicted run is not marked rejected; training-gate change needs separate approval",
  "inspect-out-of-scope-modified":
    "phase 2 inspection check records an unrequested modification as 'unverified' rather than 'contradicted' (the pre-existing UNREQUESTED_FILE_CHANGE check already fails the run); status/eligibility alignment needs separate approval",
};

describe("evidence-bearing corpus", () => {
  it("has unique ids and covers every task category and label", () => {
    const ids = evidenceFixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(evidenceFixtures.map((f) => f.category));
    for (const c of ["debugging", "refactoring", "feature", "documentation", "inspection", "evidence_availability"]) {
      expect(categories.has(c as never), c).toBe(true);
    }
    const labels = new Set(evidenceFixtures.map((f) => f.label));
    for (const l of ["genuine", "fabricated", "insufficient", "manipulated", "out_of_scope"]) expect(labels.has(l as never), l).toBe(true);
  });

  it.each(evidenceFixtures.map((f) => [f.id, f] as const))("%s", (id, fixture) => {
    const r = evaluateEvidenceFixture(fixture);
    const actual = { verdict: r.verdict, status: r.status, eligibility: r.eligibility };
    const expected = { verdict: fixture.expectedVerdict, status: fixture.expectedStatus, eligibility: fixture.expectedEligibility };
    if (KNOWN_GAPS[id]) {
      // A known gap must still be a gap; when it closes, remove it from the list.
      expect(actual, `known gap closed for ${id}: remove it from KNOWN_GAPS`).not.toEqual(expected);
      return;
    }
    expect(actual, `${fixture.reason}\nissues: ${r.issueCodes.join(", ")}`).toEqual(expected);
  });

  it("never accepts a fixture that should be rejected", () => {
    const { metrics, results } = runEvidenceEval(evidenceFixtures);
    expect(metrics.shouldReject).toBeGreaterThan(0);
    expect(metrics.shouldAccept).toBeGreaterThan(0);
    expect(metrics.falseAccepts, results.filter((r) => r.fixture.expectedVerdict === "FAIL" && r.verdict !== "FAIL").map((r) => r.fixture.id).join(", ")).toBe(0);
    // False rejections come only from the known gaps above.
    const falseRejected = results.filter((r) => r.fixture.expectedVerdict === "PASS" && r.verdict !== "PASS").map((r) => r.fixture.id);
    expect(falseRejected.every((id) => KNOWN_GAPS[id] !== undefined), falseRejected.join(", ")).toBe(true);
  });
});
