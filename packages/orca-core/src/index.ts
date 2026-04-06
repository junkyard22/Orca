// Runtime factory
export { createOrcaRuntime } from "./runtime.js";
export { buildPappyInput, deriveFilesChangedFromToolEvents, normalizeMaestroResult } from "./helpers.js";

// Concrete adapter factories (convenience — can be swapped for custom impls)
export { createMirandaLLMService } from "./adapters/mirandaLLM.js";
export { createDirectLLMService } from "./adapters/directLLM.js";
export { createPappyPort, createDebugPappyPort, createLoggingPappyPort } from "./adapters/pappyPort.js";

// Workspace context — capture git + file state for prompt grounding
export { getWorkspaceContext } from "./workspaceContext.js";

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
  MaestroPort,
  PappyPort,
  OrcaEvent,
  OrcaEventType,
} from "./types.js";

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

