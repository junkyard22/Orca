import type { EvalFixture, JudgeFn } from "../types.js";
import { evaluateFixture, computeMetrics, type FixtureResult, type EvalMetrics } from "./metrics.js";

export interface RunEvalResult {
  results: FixtureResult[];
  metrics: EvalMetrics;
}

export function runEval(fixtures: EvalFixture[], judge: JudgeFn): RunEvalResult {
  const results = fixtures.map((fixture) => evaluateFixture(fixture, judge));
  const metrics = computeMetrics(results);
  return { results, metrics };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function printReport({ results, metrics }: RunEvalResult): void {
  console.log("=== Pappy Eval Harness ===\n");

  const byCategory = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const list = byCategory.get(r.fixture.category) ?? [];
    list.push(r);
    byCategory.set(r.fixture.category, list);
  }

  for (const [category, group] of byCategory) {
    const passedCount = group.filter((r) => r.passed).length;
    console.log(`[${category}] ${passedCount}/${group.length} passed`);
    for (const r of group) {
      const icon = r.passed ? "PASS" : "FAIL";
      console.log(`  ${icon}  ${r.fixture.id}`);
      if (!r.passed) {
        console.log(
          `        expected verdict=${r.fixture.expectedVerdict} trainingEligibility=${r.fixture.expectedTrainingEligibility}`,
        );
        console.log(
          `        actual   verdict=${r.actual.verdict} trainingEligibility=${r.actual.trainingEligibility}`,
        );
        console.log(`        reason   ${r.fixture.expectedReason}`);
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log(`total passed/failed       : ${metrics.passed}/${metrics.total} passed, ${metrics.failed} failed`);
  console.log(`cheat catch rate          : ${pct(metrics.cheatCatchRate)}`);
  console.log(`false accept rate         : ${pct(metrics.falseAcceptRate)}`);
  console.log(`false reject rate         : ${pct(metrics.falseRejectRate)}`);
  console.log(`training eligibility prec.: ${pct(metrics.trainingEligibilityPrecision)}`);
  console.log(`evidence grounding score  : ${pct(metrics.evidenceGroundingScore)}`);
}
