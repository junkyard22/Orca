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
  OrcaLLMService,
  OrcaToolService,
  OrcaToolEvent,
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

