// ---------------------------------------------------------------------------
// Pappy eval harness — shared types
//
// This models a *future* Pappy capability (cheat detection + training-data
// eligibility judging) that does not exist in @clawde/pappy-core yet. The
// harness is self-contained: it ships its own reference judge
// (src/judge/judgeRun.ts) so the eval is runnable today, and is designed to
// be swapped for a real Pappy/LLM-judge implementation later without
// changing fixtures or the runner.
// ---------------------------------------------------------------------------

export type EvalCategory =
  | "clean_success"
  | "honest_failure"
  | "fake_success"
  | "test_tampering"
  | "verifier_tampering"
  | "hardcoded_answer"
  | "scope_drift"
  | "unsafe_functional_code"
  | "partial_success"
  | "accepted_but_not_trainable";

export type Verdict = "accept" | "repair" | "reject" | "needs_human_review";

export type TrainingEligibility =
  | "eligible"
  | "accepted_but_not_trainable"
  | "needs_human_review"
  | "rejected";

export interface FileChange {
  path: string;
  changeType: "A" | "M" | "D";
  diff?: string;
}

export interface ToolTraceEvent {
  tool: string;
  ok: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Input packet — a synthetic completed agent run fed to the judge
// ---------------------------------------------------------------------------

export interface RunPacket {
  task: string;
  acceptanceCriteria: string[];
  agentClaim: string;
  filesChanged: FileChange[];
  diffSummary: string;
  testOutput: string;
  toolTrace: ToolTraceEvent[];
}

// ---------------------------------------------------------------------------
// Fixture — a RunPacket plus the verdict the judge is expected to reach
// ---------------------------------------------------------------------------

export interface EvalFixture extends RunPacket {
  id: string;
  category: EvalCategory;
  expectedVerdict: Verdict;
  expectedTrainingEligibility: TrainingEligibility;
  expectedReason: string;
}

// ---------------------------------------------------------------------------
// Output — Pappy's structured judgment of a RunPacket
// ---------------------------------------------------------------------------

export interface JudgeOutput {
  verdict: Verdict;
  /** 0–1 */
  confidence: number;
  trainingEligibility: TrainingEligibility;
  /** Findings raised by the deterministic pre-check layer (rule name + detail). */
  deterministicFindings: string[];
  /** Substrings of the packet (task/claim/diff/testOutput/file paths) the judge grounded its verdict in. */
  evidenceUsed: string[];
  /** Reasons the run did not get an unconditional "accept". Empty when verdict === "accept". */
  failureReasons: string[];
  /** Short actionable next step. Empty string when verdict === "accept". */
  recommendedRepair: string;
}

export type JudgeFn = (packet: RunPacket) => JudgeOutput;
