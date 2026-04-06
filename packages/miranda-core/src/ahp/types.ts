/**
 * Agent Handoff Protocol — type definitions.
 *
 * Lives in miranda-core because Miranda is the AHP enforcer.
 * orca-core/src/ahp/types.ts re-exports from here so consumers that
 * reach through orca-core continue to work without a circular dependency.
 *
 * This file contains ONLY type/interface/enum declarations.
 * No runtime logic lives here.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum AHPLifecycle {
  PENDING      = "PENDING",
  RUNNING      = "RUNNING",
  COMPLETE     = "COMPLETE",
  FAILED       = "FAILED",
  INCONCLUSIVE = "INCONCLUSIVE",
}

export enum AHPVerdict {
  PASS         = "PASS",
  WARN         = "WARN",
  FAIL         = "FAIL",
  INCONCLUSIVE = "INCONCLUSIVE",
  VIOLATION    = "VIOLATION",
}

/**
 * Role of a packet in the orchestration hierarchy.
 *
 *   Root  — the top-level orchestration contract for an entire run.
 *           Summarises overall objective, constraints, and aggregate outcome.
 *           Created by the runtime before invoking any workers.
 *
 *   Child — an execution-level contract scoped to one worker branch or subtask.
 *           References its parent via parentPacketId.
 *           Worker traces, AC evaluation, and evalMeta live here.
 */
export enum AHPPacketRole {
  Root  = "Root",
  Child = "Child",
}

// ---------------------------------------------------------------------------
// Component types
// ---------------------------------------------------------------------------

export interface AHPInput {
  id:    string;
  type:  string;
  value: unknown;
}

export interface AHPConstraint {
  rule:     string;
  enforcer: string;
}

export interface AHPExpectedOutput {
  /** Schema keys the output must reference. */
  readonly schema:             Readonly<Record<string, unknown>>;
  /**
   * Acceptance criteria authored by Brain/orchestrator.
   * Treated as immutable after packet creation — do not push/splice.
   * Use mergeAcceptanceCriteria() to compute an evaluation list that
   * includes derived defaults without mutating this field.
   */
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

/** Single entry in the append-only trace log. */
export interface AHPTraceEntry {
  timestamp: string;
  state:     AHPLifecycle;
  actor:     string;
  note?:     string;
}

export interface AHPMeta {
  ackRequired: boolean;
  createdAt:   string;
  updatedAt:   string;
  /** ISO timestamp recorded when the packet's lifecycle transitions to RUNNING. */
  startedAt?:   string;
  /** ISO timestamp recorded when the packet reaches a terminal lifecycle state. */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Evaluation metadata
// ---------------------------------------------------------------------------

/**
 * Structured evaluation/classification metadata attached to a packet by Pappy
 * after quality verification.
 *
 * These fields expose classification decisions as typed values so consumers can
 * inspect what was inferred and what was evaluated without parsing trace strings.
 *
 * Lives in miranda-core (not pappy-core) so it can be part of the packet type
 * without circular dependencies.  The `taskType` field uses `string` to stay
 * compatible with the TaskType string-enum defined in pappy-core.
 */
export interface AHPEvalMeta {
  /**
   * Inferred task category from the objective (mirrors TaskType enum values:
   * code_generation | code_edit | file_write | research | explanation | other).
   */
  taskType: string;

  /**
   * Baseline acceptance criteria derived from taskType — the defaults that
   * Pappy adds before evaluation.  Original packet-authored ACs are NOT here.
   * Preserving this separately lets callers distinguish what the author specified
   * from what the system inferred.
   */
  derivedAcceptanceCriteria: ReadonlyArray<string>;

  /**
   * The merged AC list actually used for evaluation: packet ACs first, then
   * any derived ACs not already covered (case-insensitive dedup).
   * This is the authoritative list of what was checked.
   */
  mergedAcceptanceCriteria: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Top-level packet
// ---------------------------------------------------------------------------

/**
 * Lifecycle ownership contract (informational — not enforced by the type system):
 *   Brain       → creates packet, sets id/objective/expectedOutput/constraints
 *   Miranda     → authorises PENDING→RUNNING transition; enforces constraints
 *   Workers     → report execution facts via trace entries
 *   Orchestrator → finalises aggregate lifecycle (RUNNING→COMPLETE/FAILED)
 *   Pappy       → evaluates quality; writes verdict/evalMeta/repairPrompt;
 *                  does NOT casually rewrite lifecycle state
 *
 * Packet hierarchy (roles):
 *   Root packet  — created at orchestration boundary by the runtime.
 *                  Has no parent. Enumerates child packet ids.
 *                  Lifecycle is derived from children (or direct execution
 *                  for single-run non-decomposed tasks).
 *   Child packet — one per worker branch / subtask.
 *                  References parent via parentPacketId.
 *                  Accumulates worker traces, verdict, and evalMeta.
 *
 * Immutability conventions:
 *   readonly fields — must not change after packet creation
 *   mutable fields  — lifecycle (Miranda/workers), trace (append-only),
 *                     meta.updatedAt, verdict, repairPrompt, evalMeta (Pappy)
 */
export interface AHPPacket {
  readonly id:             string;
  readonly objective:      string;
           lifecycle:      AHPLifecycle;
  readonly inputs:         ReadonlyArray<AHPInput>;
  readonly constraints:    ReadonlyArray<AHPConstraint>;
  readonly expectedOutput: AHPExpectedOutput;
  /** Append-only trace of lifecycle state transitions. Use appendAHPTrace(). */
           trace:          AHPTraceEntry[];
           meta:           AHPMeta;
           verdict?:       AHPVerdict;
  /**
   * Targeted repair prompt generated by Pappy when verdict is WARN or FAIL.
   * Identifies each failed AC with its failure evidence and provides an
   * actionable correction directive.  Used by the Maestro repair loop as the
   * `originalUserMessage` of the repair task instead of a generic retry prompt.
   */
           repairPrompt?:  string;
  /**
   * Structured evaluation metadata populated by Pappy after quality verification.
   * Inspect these fields for inferred taskType, derived ACs, and merged ACs
   * without parsing trace note strings.
   */
           evalMeta?:      AHPEvalMeta;

  // ── Hierarchy fields ───────────────────────────────────────────────────────
  /**
   * Role of this packet in the orchestration hierarchy.
   * Optional for legacy/backward-compat packets that pre-date hierarchy support.
   * All new packets created via the factory helpers carry an explicit role.
   */
           role?:           AHPPacketRole;
  /**
   * ID of the parent (root) packet for child packets.
   * undefined for root packets and legacy pre-hierarchy packets.
   */
  readonly parentPacketId?: string;
  /**
   * IDs of child packets registered under this root packet.
   * Populated by registerChildOnRoot().  Not present on child packets.
   * Mutable (append-only) — use registerChildOnRoot() for mutations.
   */
           childPacketIds?: string[];
}
