export { evaluateWithPappy } from "./pappy.js";
export {
  classifyPath,
  classifyTaskKind,
  isDefectFixTask,
  isFullSuiteCommand,
  isTestPath,
  parseFailingTests,
  parseTestCounts,
  prohibitsTestEdits,
  runWorkspaceVerificationChecks,
  testSegment,
  testShape,
} from "./checks/workspaceVerification.js";
export type { WorkspaceVerificationResult } from "./checks/workspaceVerification.js";
export { buildRepairTask } from "./repair.js";
export { traceEvaluation } from "./pappy-trace.js";
export { verifyAHPPacket } from "./ahp/evaluator.js";
export type { AHPVerificationInput } from "./ahp/evaluator.js";
export { TaskType, classifyTaskType, deriveDefaultACs, mergeAcceptanceCriteria, getACPriority } from "./ahp/taskClassifier.js";
export type { ACPriority } from "./ahp/taskClassifier.js";
export { verifyFileChanges, extractExpectedPaths } from "./ahp/fileVerifier.js";
export type { FileCheckResult, FileVerificationOverrides } from "./ahp/fileVerifier.js";
export { buildAHPRepairPrompt } from "./ahp/repairPrompt.js";
export type { ACFailure, SchemaInfo } from "./ahp/repairPrompt.js";
export type {
  PappyInput,
  PappyResult,
  Issue,
  Verdict,
  TrainingEligibility,
  Severity,
  IssueCategory,
  ReceiptType,
  ReceiptStatus,
  AcceptanceCriterion,
  Claim,
  ReceiptEntry,
  RepairTask,
  FileChange,
  ToolEvent,
  Constraints,
  ModelIdentity,
  ModelReviewProvenance,
  ReviewIndependenceStatus,
  ReviewIndependence,
  EvidenceStrength,
  EvidenceStatus,
  TaskKind,
  VerificationStatus,
  WorkspaceEvidence,
  WorkspaceFileChange,
  WorkspaceFileKind,
  WorkspaceTestRun,
} from "./types.js";
