export type Verdict = "PASS" | "WARN" | "FAIL";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface Issue {
  /**
   * Stable identifier: `${code}:${fnv1a32(evidence ?? message)}`.
   * Deterministic for the same defect — lets Maestro and Doctor track
   * which specific issues were fixed across repair passes.
   */
  issueId: string;
  severity: Severity;
  code: string;
  message: string;
  evidence?: string;
  suggestedFix?: string;
}

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
  planText?: string;
  outputText?: string;
  filesChanged?: FileChange[];
  toolEvents?: ToolEvent[];
  constraints?: Constraints;
}

export interface PappyResult {
  verdict: Verdict;
  confidence: number;
  issues: Issue[];
  repairTask?: string;
  internalSummary: string;
}
