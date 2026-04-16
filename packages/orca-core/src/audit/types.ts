import type { OrcaTaskSpec } from "../types.js";

export type ProjectAuditMode = "project_audit";

export type AuditFailureCategory =
  | "missing_path"
  | "unreadable_path"
  | "unsupported_stack"
  | "missing_binary"
  | "bad_workdir"
  | "timeout"
  | "permission_denied"
  | "command_exit_nonzero"
  | "no_relevant_files"
  | "insufficient_evidence";

export interface AuditFailure {
  category: AuditFailureCategory;
  retryable: boolean;
  summary: string;
  suggestedNextAction: string;
  detail?: string;
}

export type AuditPathKind = "missing" | "file" | "directory" | "other";

export interface AuditMarker {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface AuditPreflight {
  targetPath: string;
  exists: boolean;
  readable: boolean;
  kind: AuditPathKind;
  isRepo: boolean;
  markers: AuditMarker[];
  failures: AuditFailure[];
}

export type ProjectCategory =
  | "node_app"
  | "electron_app"
  | "react_app"
  | "vite_app"
  | "monorepo"
  | "python_app"
  | "rust_app"
  | "go_app"
  | "static_site"
  | "unknown";

export interface ProjectClassification {
  primary: ProjectCategory;
  categories: ProjectCategory[];
  confidence: number;
  evidence: string[];
}

export type AuditProbeName =
  | "inspect_directory_tree"
  | "read_key_files"
  | "detect_package_manager"
  | "detect_scripts"
  | "detect_test_setup"
  | "detect_build_setup"
  | "detect_release_setup"
  | "detect_ci_setup"
  | "detect_env_hygiene"
  | "detect_docs_presence"
  | "detect_packaging_signals"
  | "inspect_source_sample"
  | "detect_logging_or_error_handling_signals";

export type AuditProbeStatus = "pass" | "partial" | "missing" | "not_applicable" | "error";

export interface AuditProbeResult {
  name: AuditProbeName;
  status: AuditProbeStatus;
  evidence: string[];
  missing: string[];
  data?: Record<string, unknown>;
  failure?: AuditFailure;
}

export type AuditCommandStatus = "allowed_not_run" | "blocked" | "not_applicable";

export interface AuditCommandDecision {
  command: string;
  status: AuditCommandStatus;
  reason: string;
  failure?: AuditFailure;
}

export interface AuditCommandPolicy {
  shellAllowed: boolean;
  approvedRecipes: string[];
  decisions: AuditCommandDecision[];
}

export type ProductionReadiness =
  | "ready"
  | "mostly_ready"
  | "prototype"
  | "not_production_ready"
  | "insufficient_evidence";

export interface ReadinessScore {
  readiness: ProductionReadiness;
  confidence: number;
  totalScore: number;
  categories: Record<string, number>;
  supportingEvidence: string[];
  missingEvidence: string[];
  riskFlags: string[];
}

export interface ProjectAuditResult {
  mode: ProjectAuditMode;
  task: string;
  preflight: AuditPreflight;
  classification: ProjectClassification;
  probes: AuditProbeResult[];
  commandPolicy: AuditCommandPolicy;
  readiness: ReadinessScore;
  failures: AuditFailure[];
}

export interface ProjectAuditInput {
  taskSpec: OrcaTaskSpec;
  workspaceRoot?: string;
}
