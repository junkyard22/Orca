// Runtime factory
export { createOrcaRuntime } from "./runtime.js";

// Concrete adapter factories (convenience — can be swapped for custom impls)
export { createMirandaLLMService } from "./adapters/mirandaLLM.js";
export { createPappyPort } from "./adapters/pappyPort.js";

// Types
export type {
  OrcaRuntime,
  OrcaRuntimeDeps,
  OrcaTaskSpec,
  OrcaExecutionResult,
  OrcaLLMService,
  OrcaRunCtx,
  OrcaMaestroResult,
  MaestroPort,
  PappyPort,
  OrcaEvent,
  OrcaEventType,
} from "./types.js";
