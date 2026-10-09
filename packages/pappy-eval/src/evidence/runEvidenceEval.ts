import { evaluateWithPappy } from "@clawde/pappy-core";
import type { EvidenceFixture, EvidenceFixtureResult, EvidenceMetrics } from "./types.js";

export function evaluateEvidenceFixture(fixture: EvidenceFixture): EvidenceFixtureResult {
  const result = evaluateWithPappy(fixture.input);
  const status = result.verification?.status ?? "not_applicable";
  return {
    fixture,
    verdict: result.verdict,
    status,
    eligibility: result.trainingEligibility,
    issueCodes: result.issues.map((issue) => `${issue.severity[0]}:${issue.code}`),
    verdictMatched: result.verdict === fixture.expectedVerdict,
    statusMatched: status === fixture.expectedStatus,
    eligibilityMatched: result.trainingEligibility === fixture.expectedEligibility,
  };
}

const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

export function computeEvidenceMetrics(results: EvidenceFixtureResult[]): EvidenceMetrics {
  const shouldReject = results.filter((r) => r.fixture.expectedVerdict === "FAIL");
  const shouldAccept = results.filter((r) => r.fixture.expectedVerdict === "PASS");
  const falseAccepts = shouldReject.filter((r) => r.verdict !== "FAIL").length;
  const falseRejects = shouldAccept.filter((r) => r.verdict !== "PASS").length;
  const markedEligible = results.filter((r) => r.eligibility === "eligible");
  const expectedEligible = results.filter((r) => r.fixture.expectedEligibility === "eligible");
  const byCategory: EvidenceMetrics["byCategory"] = {};
  for (const r of results) {
    const entry = (byCategory[r.fixture.category] ??= { total: 0, passed: 0 });
    entry.total++;
    if (r.verdictMatched && r.statusMatched && r.eligibilityMatched) entry.passed++;
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.verdictMatched && r.statusMatched && r.eligibilityMatched).length,
    shouldReject: shouldReject.length,
    falseAccepts,
    falseAcceptRate: ratio(falseAccepts, shouldReject.length),
    shouldAccept: shouldAccept.length,
    falseRejects,
    falseRejectRate: ratio(falseRejects, shouldAccept.length),
    statusAccuracy: ratio(results.filter((r) => r.statusMatched).length, results.length),
    eligibilityAccuracy: ratio(results.filter((r) => r.eligibilityMatched).length, results.length),
    eligiblePrecision: ratio(markedEligible.filter((r) => r.fixture.expectedEligibility === "eligible").length, markedEligible.length),
    eligibleRecall: ratio(expectedEligible.filter((r) => r.eligibility === "eligible").length, expectedEligible.length),
    byCategory,
  };
}

export function runEvidenceEval(fixtures: EvidenceFixture[]): { results: EvidenceFixtureResult[]; metrics: EvidenceMetrics } {
  const results = fixtures.map(evaluateEvidenceFixture);
  return { results, metrics: computeEvidenceMetrics(results) };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function printEvidenceReport({ results, metrics }: { results: EvidenceFixtureResult[]; metrics: EvidenceMetrics }): void {
  console.log("=== Pappy evidence-bearing eval (supplementary corpus) ===\n");
  for (const [category, counts] of Object.entries(metrics.byCategory)) {
    console.log(`[${category}] ${counts.passed}/${counts.total} matched`);
    for (const r of results.filter((x) => x.fixture.category === category)) {
      const ok = r.verdictMatched && r.statusMatched && r.eligibilityMatched;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.fixture.id.padEnd(44)} ${r.verdict}/${r.status}/${r.eligibility}`);
      if (!ok) {
        console.log(`        expected ${r.fixture.expectedVerdict}/${r.fixture.expectedStatus}/${r.fixture.expectedEligibility}`);
        console.log(`        issues   ${r.issueCodes.join(", ") || "-"}`);
        console.log(`        reason   ${r.fixture.reason}`);
      }
    }
  }
  console.log("\n=== Summary ===");
  console.log(`fixtures fully matched    : ${metrics.passed}/${metrics.total}`);
  console.log(`false acceptances         : ${metrics.falseAccepts}/${metrics.shouldReject} should-reject (${pct(metrics.falseAcceptRate)})`);
  console.log(`false rejections          : ${metrics.falseRejects}/${metrics.shouldAccept} should-accept (${pct(metrics.falseRejectRate)})`);
  console.log(`evidence status accuracy  : ${pct(metrics.statusAccuracy)}`);
  console.log(`eligibility accuracy      : ${pct(metrics.eligibilityAccuracy)}`);
  console.log(`eligible precision/recall : ${pct(metrics.eligiblePrecision)} / ${pct(metrics.eligibleRecall)}`);
  console.log("\nSmall, named fixture set: a behavioural check on these cases, not a statistical calibration.");
}
