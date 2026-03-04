// Runtime factory
export { createOrcaRuntime } from "./runtime.js";

// Concrete adapter factories (convenience — can be swapped for custom impls)
export { createMirandaLLMService } from "./adapters/mirandaLLM.js";
export { createPappyPort } from "./adapters/pappyPort.js";

// Workspace context — capture git + file state for prompt grounding
export { getWorkspaceContext } from "./workspaceContext.js";

// Types
export type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaLLMService,
  OrcaToolService,
  OrcaRunCtx,
  OrcaMaestroResult,
  MaestroPort,
  PappyPort,
  OrcaEvent,
  OrcaEventType,
} from "./types.js";

export type { WorkspaceContext } from "./workspaceContext.js";
export type { RunStore, PersistedRun } from "./persistence/types.js";
