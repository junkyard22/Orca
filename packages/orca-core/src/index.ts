// Runtime factory
export { createOrcaRuntime } from "./runtime.js";
export {
  buildPappyInput,
  deriveFilesChangedFromToolEvents,
  extractFilesChangedFromCommandOutput,
  normalizeMaestroResult,
} from "./helpers.js";
export { extractAuditTargetPath, formatProjectAuditResult, isProjectAuditTask, runProjectAudit } from "./audit/index.js";
export { createFilteredToolService, extractToolNamesFromPrompt } from "./toolFilter.js";

// Concrete adapter factories (convenience — can be swapped for custom impls)
export { createMirandaLLMService } from "./adapters/mirandaLLM.js";
export { createDirectLLMService } from "./adapters/directLLM.js";
export { createPappyPort, createDebugPappyPort, createLoggingPappyPort } from "./adapters/pappyPort.js";
// Pappy's task classification, so app shells can tell a worker what evidence the check will require.
export { classifyTaskKind, isDefectFixTask, prohibitsTestEdits } from "@clawde/pappy-core";

// Workspace context — capture git + file state for prompt grounding
export { getWorkspaceContext } from "./workspaceContext.js";

// Workspace evidence — the runtime's own record of what a task changed and
// which test commands ran, handed to Pappy as evidence the worker cannot author
export {
  captureWorkspaceInventory,
  createWorkspaceEvidenceCollector,
  diffWorkspaceInventories,
  DEFAULT_EVIDENCE_LIMITS,
} from "./workspaceEvidence.js";
export type { EvidenceLimits, WorkspaceEvidenceCollector, WorkspaceInventory } from "./workspaceEvidence.js";

// Extension / adapter system (Phase 7)
export {
  ExtensionRegistry,
  createExtensionRegistry,
} from "./extension.js";
export type {
  OrcaExtension,
  ExtTool,
  ExtToolRunCtx,
  ExtToolResult,
  ExtToolParamSchema,
} from "./extension.js";

// Types
export type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaFileChange,
  LLMOptions,
  OrcaLLMService,
  OrcaToolService,
  OrcaToolEvent,
  OrcaPipelineTrace,
  OrcaPipelineTraceEntry,
  OrcaRunCtx,
  OrcaMaestroResult,
  TaskMode,
  MaestroPort,
  PappyPort,
  OrcaEvent,
  OrcaEventType,
} from "./types.js";
export type {
  AuditCommandDecision,
  AuditCommandPolicy,
  AuditFailure,
  AuditFailureCategory,
  AuditMarker,
  AuditPathKind,
  AuditPreflight,
  AuditProbeName,
  AuditProbeResult,
  AuditProbeStatus,
  ProductionReadiness,
  ProjectAuditInput,
  ProjectAuditMode,
  ProjectAuditResult,
  ProjectCategory,
  ProjectClassification,
  ReadinessScore,
} from "./audit/index.js";

export type { WorkspaceContext } from "./workspaceContext.js";

// Persistence types and implementation
export type { RunRecord, ThoughtRecord, ToolEvent, FileChange, OrcaStore } from "./persistence/types.js";
export { SqliteStore } from "./persistence/sqliteStore.js";

// Training data export
export { exportTrainingData } from "./export/exportTrainingData.js";
export type { ExportOptions, TrainingRecord, ExportSummary } from "./export/exportTrainingData.js";

// Run analysis artifacts (run-analysis.md + run-events.json)
export { createRunAnalysisWriter } from "./analysis/runAnalysis.js";
export type { RunAnalysisWriter } from "./analysis/runAnalysis.js";

// Agent Handoff Protocol (re-exported from miranda-core — canonical home)
export type {
  AHPInput, AHPConstraint, AHPExpectedOutput, AHPTraceEntry, AHPMeta, AHPEvalMeta, AHPPacket,
  CreatePacketOptions,
} from "./ahp/types.js";
export {
  AHPLifecycle, AHPVerdict, AHPPacketRole,
  createRootPacket, createChildPacket, registerChildOnRoot, deriveRootLifecycleFromChildren,
  appendAHPTrace, isTerminalAHPLifecycle,
} from "./ahp/types.js";

// AHP Packet Graph — serialization and inspection helpers
export type { AHPPacketGraph, AHPPacketGraphNode, AHPGraphSummaryMode } from "./ahp/graph.js";
export {
  serializeAHPPacketGraph,
  formatAHPPacketGraphSummary,
  formatAHPPacketGraphIssuesSummary,
  isNodeInteresting,
  parseAHPPacketGraph,
} from "./ahp/graph.js";

export { createBudgetJournal } from "./budget/journal.js";
export type { BudgetJournal, UnresolvedBudgetTask } from "./budget/journal.js";
export { accountPass, budgetGateContext, budgetStopReason, formatBudgetStop, withPassAccounting } from "./budget/passAccounting.js";
export type { PassAccounting } from "./budget/passAccounting.js";
export { TaskLifecycle, TERMINAL_TASK_STATES } from "./lifecycle.js";
export { unsettledResourceOf } from "./lifecycle.js";
export type { ActiveOperation, OperationHandle, OperationKind, PendingResourceScan, TaskLifecycleSnapshot, TaskState, TaskTransition, UnsettledResource, ResourceLiveness, ResourceProbe } from "./lifecycle.js";
export { createWorkspaceGuard, describeProtections, existenceProbe, WorkspaceProtectedError } from "./workspaceGuard.js";
export type { ProcessLiveness, ProcessProbe, ProtectRecord, ProtectedOperation, WorkspaceGuard, WorkspaceGuardEvent, WorkspaceOverride, WorkspaceProtection, WorkspaceRelease } from "./workspaceGuard.js";
export { createAbortError, isAbortError, throwIfAborted, untilAborted } from "./abort.js";

export { buildHostRecord, checkProvenance, correctProvenance, parseTestCounts } from "./hostRecord.js";
export type { HostRecord, HostRecordChange, HostRecordTestRun, PassLogEntry, ProvenanceCheck } from "./hostRecord.js";
