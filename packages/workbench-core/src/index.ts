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
} from './runner';

export type {
  ToolSpec,
  ExecutionPlan,
  ExecutionResult,
  VerificationOutcome,
  Runner,
} from './runner';

export type {
  VerificationStatus,
  VerifiedToolResult,
} from './verification';

export {
  // Verification system
  createVerification,
  wrapToolResult,
  isVerifiedResult,
} from './verification';

export type {
  DiagnosticResult,
  DoctorReport,
} from './doctor';
 
export {
  // Doctor diagnostics (foundation layer)
  runDiagnostics,
} from './doctor';

export type {
  RuntimeEvent,
} from './events';

export {
  // Event system (runtime observability)
  EventBus,
  eventBus,
  createTimestamp,
} from './events';
