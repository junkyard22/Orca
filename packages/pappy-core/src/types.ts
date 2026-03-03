// ---------------------------------------------------------------------------
// Core enumerations
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "WARN" | "FAIL";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

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
  | "other";

export type ReceiptStatus = "PROVED" | "MISSING" | "PARTIAL";

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

export interface PappyInput {
  task: string;
  goals?: string[];
  planText?: string;
  outputText?: string;
  filesChanged?: FileChange[];
  toolEvents?: ToolEvent[];
  constraints?: Constraints;
}

export interface PappyResult {
  verdict: Verdict;
  confidence: number;
  summary: string;
  acceptance_criteria: AcceptanceCriterion[];
  claims: Claim[];
  receipt_ledger: ReceiptEntry[];
  issues: Issue[];
  repair_task: RepairTask | null;
  /** Terse machine-readable summary for logging/Doctor. */
  internalSummary: string;
  /** @deprecated Use `repair_task`. String form kept for backward compat. */
  repairTask?: string;
}
