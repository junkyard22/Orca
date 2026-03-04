/**
 * Workbench Core - Runtime Foundation
 * 
 * Core responsibilities:
 * - Tool contract enforcement
 * - Execution orchestration via Runners
 * - Verification
 * - Policy enforcement (future)
 * - Event emission (future)
 * - Doctor diagnostics (future)
 * 
 * Core does NOT:
 * - Implement specific tools
 * - Contain UI logic
 * - Depend on application features
 * - Hardcode language implementations
 */

export {
  // Core runtime exports
  ShellRunner,
  RunnerRegistry,
  runnerRegistry,
} from './runner.js';

export type {
  ToolSpec,
  ExecutionPlan,
  ExecutionResult,
  VerificationOutcome,
  Runner,
} from './runner.js';

export type {
  VerificationStatus,
  VerifiedToolResult,
} from './verification.js';

export {
  // Verification system
  createVerification,
  wrapToolResult,
  isVerifiedResult,
} from './verification.js';

export type {
  DiagnosticResult,
  DoctorReport,
} from './doctor.js';

// ---------------------------------------------------------------------------
// Tool system — Phase 3
// ---------------------------------------------------------------------------
export type {
  Tool,
  ToolResult,
  ToolRunCtx,
  ToolSchema,
  ToolParameterSchema,
} from './tools/index.js';

export {
  ToolRegistry,
  readFileTool,
  writeFileTool,
  runCommandTool,
  listDirectoryTool,
  searchFilesTool,
  createCoreToolRegistry,
} from './tools/index.js';

export {
  // Doctor diagnostics (foundation layer)
  runDiagnostics,
} from './doctor.js';

export type {
  RuntimeEvent,
} from './events.js';

export {
  // Event system (runtime observability)
  EventBus,
  eventBus,
  createTimestamp,
} from './events.js';
