// ---------------------------------------------------------------------------
// Core enumerations
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "WARN" | "FAIL";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/**
 * Whether a run may be reused as training data.
 *
 * Deliberately a separate axis from `Verdict`, because the two answer different
 * questions and conflating them was expensive in both directions:
 *
 *   - Code can be *correct* and still unfit to learn from — it works, but it
 *     builds a query by string concatenation or embeds a credential. Folding
 *     that into the verdict turned it into a repair pass, and a repair pass is a
 *     full LLM round-trip spent on code that was already right.
 *   - A run can *fail* and still be excellent training data. An agent that tried,
 *     could not finish, and said so plainly is exactly the behaviour worth
 *     teaching. Keying eligibility off the verdict would have thrown it away.
 *
 * Eligibility therefore keys off integrity — did the run represent itself
 * honestly — not off whether it succeeded.
 */
export type TrainingEligibility =
  /** Safe to export into the training corpus. */
  | "eligible"
  /** Correct and acceptable, but contains a pattern that must not be taught. */
  | "accepted_but_not_trainable"
  /** Ambiguous — a human decides before this is accepted or exported. */
  | "needs_human_review"
  /** The run misrepresented itself. Never train on it. */
  | "rejected";

/** Maps to Pappy's receipt categories. */
export type IssueCategory =
  | "Completeness"
  | "Proof"
  | "Tooling"
  | "Safety"
  | "Consistency";

/** The kind of artifact that constitutes valid proof. */
export type ReceiptType =
  | "diff"
  | "file_exists"
  | "file_contains"
  | "command_exit_0"
  | "tool_event"
  | "citations"
  | "criterion_specific"
  | "other";

/**
 * PROVED     — criterion-specific evidence found
 * PARTIAL    — the named code was touched, behaviour unverified
 * MISSING    — no criterion-specific evidence
 * UNVERIFIED — evidence exists but only from the worker's own account, while
 *              the runtime supplied workspace evidence that could have
 *              confirmed it and did not (mandatory evidence not met)
 */
export type ReceiptStatus = "PROVED" | "MISSING" | "PARTIAL" | "UNVERIFIED";

/**
 * Where a receipt's evidence comes from, strongest first:
 *   direct        — the deliverable itself (the response text Pappy is reading)
 *   independent   — the runtime's own record: files that really changed on disk,
 *                   a host-recorded test run on the final source
 *   corroborated  — host-recorded tool output that names the criterion's terms
 *   self_reported — only the worker's own text or reported diff
 *   none          — no evidence
 */
export type EvidenceStrength = "direct" | "independent" | "corroborated" | "self_reported" | "none";

// ---------------------------------------------------------------------------
// Receipt ledger structures
// ---------------------------------------------------------------------------

/** One row in the acceptance-criteria table derived from the task spec. */
export interface AcceptanceCriterion {
  id: string;  // "AC1", "AC2", …
  text: string;
  required: boolean;
}

/** A claim extracted from the assistant's output text. */
export interface Claim {
  id: string;  // "C1", "C2", …
  text: string;
  /** Whether this claim must be backed by an objective proof. */
  requires_proof: boolean;
}

/**
 * Pappy's reading of one required criterion against the runtime evidence:
 * what it requires, what would satisfy it, what supports it, whether that is
 * enough, what contradicts it, and what is still needed.
 */
export interface CriterionAssessment {
  /** What the criterion requires, as Pappy read it. */
  requires: string;
  /** What observable evidence would satisfy it. */
  satisfiedBy: string;
  /** Runtime evidence that supports the claim (empty when none). */
  supportedBy: string[];
  /** Whether the supporting evidence is relevant to this criterion and sufficient. */
  sufficient: boolean;
  /** Evidence that contradicts the claim, when any. */
  contradictedBy?: string;
  /** What additional evidence is needed, when not sufficient. */
  needed?: string;
}

/** One row in the proof ledger — maps a criterion/claim to evidence. */
export interface ReceiptEntry {
  /** ID of the AcceptanceCriterion or Claim this entry covers. */
  ref: string;
  required_receipt: {
    type: ReceiptType;
    details: string;
  };
  status: ReceiptStatus;
  /** Short pointers to the evidence (event id, diff excerpt, filename, exit code). */
  evidence: string[];
  /** Provenance of the evidence behind `status`. */
  strength?: EvidenceStrength;
  /** Structured reading of a criterion against runtime evidence (criteria rows only, when workspace evidence was supplied). */
  assessment?: CriterionAssessment;
  /**
   * The evidence is a candidate, not proof: the named file's final content uses
   * the requirement's words, which cannot show it says what was asked. Such a
   * criterion is PARTIAL, raises a MEDIUM review issue rather than a HIGH
   * failure, and never makes the run verified or trainable.
   */
  candidate?: "lexical";
}

/**
 * A specific, actionable statement of evidence Pappy still needs for one
 * requirement. Produced alongside the verdict so a caller can collect the
 * missing evidence instead of repeating the whole task. Pappy never acts on
 * these itself: it does not run commands, fabricate receipts or start repairs.
 */
export interface EvidenceRequest {
  /** Criterion id (AC…) or check code the request belongs to. */
  ref: string;
  /** The requirement in question. */
  requirement: string;
  /** What the evidence already establishes. */
  confirmed: string[];
  /** What is missing. */
  missing: string;
  /** The action that would supply it. */
  action: string;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface Issue {
  /**
   * Stable identifier: `${code}:${fnv1a32(evidence ?? description)}`.
   * Deterministic for the same defect — lets Maestro and Doctor track
   * which specific issues were fixed across repair passes.
   */
  issueId: string;
  severity: Severity;
  code: string;
  category: IssueCategory;
  description: string;
  expected_receipt: string;
  evidence: string;
  fix_hint: string;

  // ── backward-compat aliases (kept so existing consumers don't break) ──
  /** @deprecated Use `description` */
  message: string;
  /** @deprecated Use `fix_hint` */
  suggestedFix?: string;
}

// ---------------------------------------------------------------------------
// Repair task
// ---------------------------------------------------------------------------

export interface RepairTask {
  title: string;
  steps: string[];
  required_proofs: string[];
}

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  changeType: "A" | "M" | "D";
  diff?: string;
}

export interface ToolEvent {
  tool: string;
  ok: boolean;
  summary: string;
  raw?: unknown;
}

export interface Constraints {
  forbidDeletes?: boolean;
  requireFiles?: string[];
  requireSections?: string[];
}

/**
 * The actual model identity used for one side of a model-based review.
 * `model` must describe the model that really ran after any fallback, not the
 * model that was merely configured before execution.
 */
export interface ModelIdentity {
  role?: string;
  provider?: string;
  model: string;
  /**
   * Optional provider-independent identifier when an adapter can resolve one.
   * Prefer this for detecting the same underlying model across aliases/providers.
   */
  canonicalModelId?: string;
}

/**
 * Provenance for an upstream LLM critic/reviewer, when one was used.
 * Pappy itself is deterministic and is not represented as `reviewer` here.
 */
export interface ModelReviewProvenance {
  producer?: ModelIdentity;
  reviewer?: ModelIdentity;
  /** True when the review path fell back from its originally configured model. */
  fallbackUsed?: boolean;
  /** True when the caller's contract requires the reviewer to be independent. */
  independentRequired?: boolean;
}

export type ReviewIndependenceStatus =
  | "not_applicable"
  | "independent"
  | "self_review"
  | "unknown";

/** Pappy's classification of any upstream model-review provenance. */
export interface ReviewIndependence {
  status: ReviewIndependenceStatus;
  producer?: ModelIdentity;
  reviewer?: ModelIdentity;
  fallbackUsed: boolean;
  independentRequired: boolean;
  reason: string;
}

export interface PappyInput {
  task: string;
  goals?: string[];
  planText?: string;
  outputText?: string;
  filesChanged?: FileChange[];
  toolEvents?: ToolEvent[];
  metadata?: {
    stoppedBecause?: "done" | "max_iterations" | "loop_detected" | "parse_failure_loop" | "no_final_output" | "error" | string;
    loopEvidence?: { repeatedCall?: string; occurrences?: number };
    audit?: unknown;
    ahpNonCompleteChildren?: Array<{
      id?: string;
      role?: string;
      lifecycle?: string;
      verdict?: string;
      objective?: string;
    }>;
    /**
     * Present only when an LLM critic/reviewer evaluated another model's work.
     * Must contain the identities that actually executed after fallback resolution.
     */
    modelReview?: ModelReviewProvenance;
  };
  constraints?: Constraints;
  /**
   * What actually changed on disk and which test commands really ran, as
   * recorded by Orca's runtime (never by the worker). Absent for callers that
   * have no workspace; `available: false` when the runtime could not read it.
   */
  workspace?: WorkspaceEvidence;
  /**
   * Genuine tool receipts from earlier passes of the same task (oldest first),
   * so a repair pass is judged with the reproduction evidence gathered before it.
   */
  priorToolEvents?: ToolEvent[];
}

// ---------------------------------------------------------------------------
// Workspace evidence — captured by the runtime from disk and from the host's
// own trace of tool execution. A worker cannot author any of it.
// ---------------------------------------------------------------------------

export type WorkspaceFileKind = "test" | "source" | "docs" | "config" | "lock" | "other";

export interface WorkspaceFileChange {
  /** Workspace-relative path with forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted";
  kind: WorkspaceFileKind;
  /** Content before the task (test/config files only, bounded). */
  before?: string;
  /** Content after the last change (bounded; text files only). */
  after?: string;
  /** Workers (roles) the host saw write this path during the task, in order of first write. */
  writers?: string[];
}

export interface WorkspaceTestRun {
  tool: string;
  command: string;
  cwd?: string;
  ok: boolean;
  exitCode?: number;
  output: string;
  /** True when the command ran the whole suite (no file/name filters). */
  fullSuite: boolean;
  /**
   * Non-test source state when the run finished, compared by content hash:
   * identical to the task-start baseline, identical to the final state at
   * verification, or an intermediate state. "unknown" when the runtime could
   * not fingerprint the workspace around the run.
   */
  sourceState: "baseline" | "final" | "intermediate" | "unknown";
}

export interface WorkspaceEvidence {
  available: boolean;
  /** Set when a limit stopped the inventory: `changes` may be incomplete. */
  partial?: boolean;
  reason?: string;
  provenance: "runtime-snapshot";
  /** Files in the task-start inventory. */
  baselineFiles?: number;
  /** Files whose content hash differs from the task-start baseline. */
  changes: WorkspaceFileChange[];
  /** Test command declared by the project at task start (package.json scripts.test). */
  testCommand?: string;
  /** Test commands the host observed running, in execution order. */
  testRuns?: WorkspaceTestRun[];
  /** Milliseconds spent capturing the baseline and this comparison. */
  captureMs?: number;
  /**
   * Paths written by more than one worker within the same Maestro pass: the
   * final content cannot be attributed to one worker and a write may have been
   * lost. Verification of such a change is not independent evidence.
   */
  contested?: Array<{ path: string; writers: string[] }>;
}

export type TaskKind = "bugfix" | "refactor" | "feature" | "docs" | "inspect" | "other";

/**
 * How well the evidence supports the user's objective — kept apart from the
 * verdict so an uncertain run is never promoted to "verified" silently.
 *   verified       — independent evidence shows the requested change and its tests
 *   unverified     — work looks correct but the evidence is insufficient
 *   uninterpretable— evidence exists but could not be read reliably
 *   contradicted   — evidence shows the work is incorrect
 *   unavailable    — the runtime could not capture evidence
 *   not_applicable — no workspace evidence was supplied (legacy callers)
 */
export type EvidenceStatus = "verified" | "unverified" | "uninterpretable" | "contradicted" | "unavailable" | "not_applicable";

export interface VerificationStatus {
  status: EvidenceStatus;
  taskKind: TaskKind;
  reasons: string[];
  /** True when a host-recorded full test run on the final source was found and passed. */
  testEvidence: boolean;
  /**
   * Behavioural receipts the host recorded on the final source, one line each
   * (a reproduced-then-passing failure, a regression test, a full suite, a
   * documented validation command, a build/type check). Empty when the
   * evidence shows the change only, not its behaviour.
   */
  behaviouralEvidence?: string[];
  /**
   * True when a path relevant to the objective was written by more than one
   * worker in one pass. The final state may still be verified by a host run
   * on it, but which worker's change produced it is unknown, so the run is
   * never a training candidate.
   */
  attributionUnresolved?: boolean;
}

export interface PappyResult {
  verdict: Verdict;
  /** Evidence-based verification status, independent of the verdict and of training eligibility. */
  verification?: VerificationStatus;
  /**
   * Whether this run may be reused as training data. Independent of `verdict` —
   * see the TrainingEligibility docs for why.
   */
  trainingEligibility: TrainingEligibility;
  /**
   * Classification of an upstream model critic, when one existed. Pappy's own
   * deterministic receipt verification remains separate from model independence.
   */
  reviewIndependence?: ReviewIndependence;
  /**
   * Heuristic score in [0, 1]: 1.0 minus fixed deductions per issue severity.
   * It is derived from the issues after the verdict is decided, feeds no
   * verdict, eligibility, repair or export decision, and has not been
   * calibrated against correctness. Kept for display and compatibility only;
   * see `confidenceBasis`.
   */
  confidence: number;
  /** Set by evaluateWithPappy; always "heuristic" until a calibration is demonstrated and recorded. */
  confidenceBasis?: "heuristic";
  summary: string;
  acceptance_criteria: AcceptanceCriterion[];
  claims: Claim[];
  receipt_ledger: ReceiptEntry[];
  issues: Issue[];
  /**
   * Evidence Pappy still needs, one entry per unmet requirement, when runtime
   * workspace evidence was supplied. Descriptive only — see EvidenceRequest.
   */
  evidenceRequests?: EvidenceRequest[];
  repair_task: RepairTask | null;
  /** Terse machine-readable summary for logging/Doctor. */
  internalSummary: string;
  /** @deprecated Use `repair_task`. String form kept for backward compat. */
  repairTask?: string;
}
