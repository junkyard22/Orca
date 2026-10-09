/**
 * Evidence-bearing evaluation corpus — types.
 *
 * The original 23-case corpus feeds Pappy only what a worker reports (claim,
 * reported diff, tool trace summaries). This supplementary corpus feeds Pappy
 * what the runtime now records as well: workspace changes with real before/
 * after contents, host-observed test runs with the source state they ran on,
 * host-recorded command output and exit codes. It exists to evaluate the
 * evidence-based verification path; it does not replace the original corpus
 * and its expected outcomes are set from the verification design, never from
 * Pappy's current answers.
 *
 * Small fixture sets measure behaviour on named cases. They are not a
 * statistical calibration.
 */
import type { EvidenceStatus, PappyInput, TrainingEligibility, Verdict } from "@clawde/pappy-core";

export type EvidenceCategory =
  | "coding"
  | "debugging"
  | "refactoring"
  | "feature"
  | "documentation"
  | "inspection"
  | "evidence_availability";

/** What the fixture represents, independent of what Pappy says. */
export type EvidenceLabel =
  | "genuine"        // the work was done and the evidence shows it
  | "fabricated"     // the account claims work the evidence contradicts
  | "insufficient"   // plausible work, evidence does not establish it
  | "manipulated"    // tests or controls were altered to pass
  | "out_of_scope";  // did more (or other) than asked

export interface EvidenceFixture {
  id: string;
  category: EvidenceCategory;
  label: EvidenceLabel;
  input: PappyInput;
  expectedVerdict: Verdict;
  expectedStatus: EvidenceStatus;
  expectedEligibility: TrainingEligibility;
  reason: string;
}

export interface EvidenceFixtureResult {
  fixture: EvidenceFixture;
  verdict: Verdict;
  status: EvidenceStatus;
  eligibility: TrainingEligibility;
  issueCodes: string[];
  verdictMatched: boolean;
  statusMatched: boolean;
  eligibilityMatched: boolean;
}

export interface EvidenceMetrics {
  total: number;
  /** Fixtures where verdict, status and eligibility all matched. */
  passed: number;
  /** Fixtures expected to FAIL (should be rejected). */
  shouldReject: number;
  /** Of those, how many Pappy did not FAIL (PASS or WARN): the false acceptances. */
  falseAccepts: number;
  falseAcceptRate: number;
  /** Fixtures expected to PASS (should be accepted). */
  shouldAccept: number;
  /** Of those, how many Pappy did not PASS: the false rejections. */
  falseRejects: number;
  falseRejectRate: number;
  statusAccuracy: number;
  eligibilityAccuracy: number;
  /** Of fixtures Pappy marked eligible, the fraction that were expected eligible. */
  eligiblePrecision: number;
  /** Of fixtures expected eligible, the fraction Pappy marked eligible. */
  eligibleRecall: number;
  byCategory: Record<string, { total: number; passed: number }>;
}
