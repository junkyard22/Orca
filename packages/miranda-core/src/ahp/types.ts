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
  schema:             Record<string, unknown>;
  acceptanceCriteria: string[];
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
}

// ---------------------------------------------------------------------------
// Top-level packet
// ---------------------------------------------------------------------------

export interface AHPPacket {
  id:             string;
  objective:      string;
  lifecycle:      AHPLifecycle;
  inputs:         AHPInput[];
  constraints:    AHPConstraint[];
  expectedOutput: AHPExpectedOutput;
  /** Append-only trace of lifecycle state transitions. */
  trace:          AHPTraceEntry[];
  meta:           AHPMeta;
  verdict?:       AHPVerdict;
}
