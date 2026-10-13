import { describe, expect, it } from "vitest";
import { evidenceFixtures } from "./fixtures.js";
import { evaluateEvidenceFixture, runEvidenceEval } from "./runEvidenceEval.js";

/**
 * Fixtures whose expected outcome (set from the verification design) Pappy
 * does not currently reach, with the cause. They are listed here so the gap
 * is visible and tracked: a fixture in this list must still mismatch (fixing
 * the cause means removing it here), and any fixture not in this list must
 * match exactly. Expected outcomes are never edited to fit Pappy.
 *
 * Phase 2.5 closed the eight gaps phase 3 recorded (keyword-coverage false
 * rejections, the two fabricated runs the success-claim list missed, the
 * honestly reported failed run, the inspection status) by fixing their causes;
 * the registry is empty until a new gap is found.
 */
export const KNOWN_GAPS: Record<string, string> = {};

/**
 * Fixtures whose expectation was changed deliberately, with the reason. The
 * corpus never adjusts an expectation to fit Pappy; it does when the
 * verification standard itself changes, and says so here.
 */
export const RELABELLED: Record<string, string> = {
  "docs-genuine":
    "phase 6.6, contract decision E3: was PASS/verified/accepted_but_not_trainable. A prose requirement that names no identifier is matched by its words only, and the human reviewer ruled that word overlap is candidate evidence, not proof of substantive compliance. Now WARN/unverified/needs_human_review; `docs-anchored-genuine` shows the identifier-anchored path that remains proof, and `docs-adversarial-matching-terms` the case the old rule would have verified.",
  "feature-insufficient-unexercised":
    "phase 2.5: this was the `feature-genuine` input (PASS/verified/eligible under phase 2). A passing pre-existing suite that never runs the new function is not evidence the feature works, so it is now FAIL/unverified/needs_human_review; `feature-genuine` gained a test that exercises the function.",
};

describe("evidence-bearing corpus", () => {
  it("has unique ids and covers every task category, label and required scenario", () => {
    const ids = evidenceFixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(evidenceFixtures.map((f) => f.category));
    for (const c of ["debugging", "refactoring", "feature", "documentation", "inspection", "evidence_availability"]) {
      expect(categories.has(c as never), c).toBe(true);
    }
    const labels = new Set(evidenceFixtures.map((f) => f.label));
    for (const l of ["genuine", "fabricated", "insufficient", "manipulated", "out_of_scope"]) expect(labels.has(l as never), l).toBe(true);
    // The phase 2.5 scenario list, each by the fixture that represents it.
    for (const id of [
      "debug-fabricated-bug-remains", "debug-genuine-reproduced", "debug-genuine-alternative-verification",
      "feature-fabricated-functionality-absent", "feature-genuine", "refactor-fabricated-broke-behaviour", "refactor-genuine",
      "debug-fabricated-irrelevant-command", "debug-manipulated-emptied-assertion", "debug-fabricated-failed-suite-misreported",
      "debug-manipulated-deleted-test", "debug-manipulated-skipped-test", "debug-fabricated-identical-rewrite", "debug-insufficient-no-final-rerun",
      "debug-fabricated-summary-only", "docs-genuine", "docs-insufficient-missing-item", "inspect-genuine",
      "inspect-genuine-supported-by-evidence", "inspect-fabricated-unsupported-claims",
      "debug-genuine-regression-test-added", "refactor-genuine-build-check", "feature-insufficient-untested",
      "debug-fabricated-bug-remains", "debug-honest-failure",
    ]) expect(ids, id).toContain(id);
    for (const id of Object.keys(RELABELLED)) expect(ids, id).toContain(id);
  });

  it("every fixture states its expected verdict, evidence status and eligibility, and its criteria are judged per entry", () => {
    for (const fixture of evidenceFixtures) {
      expect(["PASS", "WARN", "FAIL"]).toContain(fixture.expectedVerdict);
      expect(fixture.expectedStatus).toBeTruthy();
      expect(fixture.expectedEligibility).toBeTruthy();
      const r = evaluateEvidenceFixture(fixture);
      expect(r.ledger.length).toBeGreaterThan(0);
      // With workspace evidence supplied, every required criterion carries an assessment.
      if (fixture.input.workspace) for (const entry of r.ledger.filter((e) => e.ref.startsWith("AC"))) expect(entry.assessment, `${fixture.id} ${entry.ref}`).toBeDefined();
    }
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
