/**
 * AHP packet helpers — small utilities for safe, consistent packet manipulation.
 *
 * Using these helpers instead of direct property mutation:
 *   1. Provides a single call-site for future branch-safe merge logic
 *      (e.g. parallel decompose support — trace entries from child branches
 *      can be merged cleanly through one function rather than scattered pushes).
 *   2. Makes append/mutation patterns explicit and auditable in diffs.
 *   3. Keeps the packet type definitions clean (logic lives here, not there).
 *
 * Lifecycle ownership reminder (enforce by convention, not runtime checks):
 *   Lifecycle transitions are owned by Miranda (PENDING→RUNNING) and the
 *   orchestrator (RUNNING→COMPLETE/FAILED/INCONCLUSIVE).  Pappy writes only
 *   verdict/evalMeta/repairPrompt/trace entries — it does not own lifecycle.
 */

import type { AHPPacket, AHPTraceEntry, AHPExpectedOutput, AHPInput, AHPConstraint } from "./types.js";
import { AHPLifecycle, AHPPacketRole } from "./types.js";

// ---------------------------------------------------------------------------
// Profiling emitter (inert unless ORCA_PROFILE=1 installed a hook)
//
// scripts/profiling/emit.ts documents an `ahp_packet_create` phase that nothing
// ever emitted, so packet creation was invisible to the profiler. Creation is a
// plain object construction and should measure at ~0ms — emitting it anyway is
// the point: it lets a profile report say so rather than leaving the cost
// unattributed in the "other" bucket, and it makes packet *counts* visible,
// which is the number that actually varies between runs.
// ---------------------------------------------------------------------------

type OrcaProfileEvent = Record<string, unknown>;
type OrcaProfileEmitter = (event: OrcaProfileEvent) => void;

function emitOrcaProfileEvent(event: OrcaProfileEvent): void {
  const emitter = (globalThis as typeof globalThis & {
    __orcaProfileEmit?: OrcaProfileEmitter;
  }).__orcaProfileEmit;
  emitter?.(event);
}

// ---------------------------------------------------------------------------
// Trace append
// ---------------------------------------------------------------------------

/**
 * Append a trace entry to a packet's append-only trace log.
 *
 * Always use this function instead of calling `packet.trace.push()` directly.
 * Rationale: single call-site makes future branch-safe merge trivial — a
 * parallel decompose implementation can intercept here to buffer/merge entries
 * from concurrent child branches without touching every push() call-site.
 */
export function appendAHPTrace(packet: AHPPacket, entry: AHPTraceEntry): void {
  packet.trace.push(entry);
}

// ---------------------------------------------------------------------------
// Terminal lifecycle check
// ---------------------------------------------------------------------------

/** States from which no further lifecycle transitions are expected. */
const TERMINAL_LIFECYCLE_STATES = new Set<AHPLifecycle>([
  AHPLifecycle.COMPLETE,
  AHPLifecycle.FAILED,
  AHPLifecycle.INCONCLUSIVE,
]);

/**
 * Returns `true` if `state` is a terminal AHP lifecycle state.
 *
 * Terminal states: COMPLETE, FAILED, INCONCLUSIVE.
 * Non-terminal: PENDING, RUNNING.
 *
 * Post-run evaluation metadata (verdict, evalMeta, repairPrompt, trace entries)
 * may still be written to packets in terminal states, but the lifecycle field
 * itself should not change after reaching a terminal state.
 */
export function isTerminalAHPLifecycle(state: AHPLifecycle): boolean {
  return TERMINAL_LIFECYCLE_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Packet factories
// ---------------------------------------------------------------------------

/** Minimal options shared by both root and child packet factories. */
export interface CreatePacketOptions {
  id:             string;
  objective:      string;
  expectedOutput: AHPExpectedOutput;
  constraints?:   ReadonlyArray<AHPConstraint>;
  inputs?:        ReadonlyArray<AHPInput>;
}

/**
 * Create a new root (orchestration-level) AHPPacket.
 *
 * Root packets represent the overall run contract: objective, constraints,
 * and aggregate acceptance criteria for the whole task.  They start in
 * PENDING lifecycle and hold an empty childPacketIds list ready to accept
 * registered children.
 *
 * Ownership: created once per run by the runtime (orca-core) at orchestration
 * boundaries.  Miranda transitions PENDING→RUNNING when work begins.
 * The orchestrator transitions to COMPLETE/FAILED/INCONCLUSIVE at the end.
 */
export function createRootPacket(opts: CreatePacketOptions): AHPPacket {
  const profStart = Date.now();
  const now = new Date().toISOString();
  const packet: AHPPacket = {
    id:             opts.id,
    objective:      opts.objective,
    role:           AHPPacketRole.Root,
    lifecycle:      AHPLifecycle.PENDING,
    inputs:         opts.inputs         ?? [],
    constraints:    opts.constraints    ?? [],
    expectedOutput: opts.expectedOutput,
    trace:          [],
    childPacketIds: [],
    meta: {
      ackRequired: false,
      createdAt:   now,
      updatedAt:   now,
    },
  };

  emitOrcaProfileEvent({
    phase: "ahp_packet_create",
    durationMs: Date.now() - profStart,
    role: "root",
    packetId: packet.id,
    constraintCount: packet.constraints.length,
    inputCount: packet.inputs.length,
  });

  return packet;
}

/**
 * Create a new child (execution-level) AHPPacket for a worker branch.
 *
 * Child packets represent individual worker branch contracts within a run.
 * They carry branch-specific objectives, inputs, expected outputs, and AC
 * evaluation (evalMeta, verdict).  Worker execution traces live here, not
 * on the root packet.
 *
 * @param parentPacketId  — ID of the root packet this child belongs to.
 * @param opts            — packet content; child.objective may differ from root.
 */
export function createChildPacket(
  parentPacketId: string,
  opts: CreatePacketOptions,
): AHPPacket {
  const profStart = Date.now();
  const now = new Date().toISOString();
  const packet: AHPPacket = {
    id:             opts.id,
    objective:      opts.objective,
    role:           AHPPacketRole.Child,
    parentPacketId,
    lifecycle:      AHPLifecycle.PENDING,
    inputs:         opts.inputs         ?? [],
    constraints:    opts.constraints    ?? [],
    expectedOutput: opts.expectedOutput,
    trace:          [],
    meta: {
      ackRequired: false,
      createdAt:   now,
      updatedAt:   now,
    },
  };

  emitOrcaProfileEvent({
    phase: "ahp_packet_create",
    durationMs: Date.now() - profStart,
    role: "child",
    packetId: packet.id,
    constraintCount: packet.constraints.length,
    inputCount: packet.inputs.length,
  });

  return packet;
}

/**
 * Register a child packet under a root packet.
 *
 * Links child → root by recording child.id in root.childPacketIds.
 * Also ensures `child.parentPacketId` is consistent with the root's id.
 *
 * Call this once after creating the child and before dispatching work.
 * The root packet's childPacketIds list is the canonical enumeration of
 * all branches launched for this run.
 */
export function registerChildOnRoot(root: AHPPacket, child: AHPPacket): void {
  if (!root.childPacketIds) {
    root.childPacketIds = [];
  }
  // Idempotent — skip if already registered (handles retry/repair scenarios)
  if (!root.childPacketIds.includes(child.id)) {
    root.childPacketIds.push(child.id);
  }
}

// ---------------------------------------------------------------------------
// Aggregate lifecycle derivation
// ---------------------------------------------------------------------------

/**
 * Derive the appropriate lifecycle for a root packet after all child packets
 * have reached terminal (or final) states.
 *
 * Precedence rules (highest to lowest):
 *   1. INCONCLUSIVE — any child is INCONCLUSIVE (execution was blocked /
 *      incomplete; no safe outcome can be determined).
 *   2. FAILED       — any remaining child is FAILED (work completed but
 *      the branch outcome was definitively wrong or errored).
 *   3. COMPLETE     — all children are COMPLETE.
 *   4. INCONCLUSIVE — fallback when some children are still non-terminal
 *      (PENDING/RUNNING) which should not occur after full dispatch.
 *
 * Calling this with zero children returns INCONCLUSIVE because no work was
 * evidenced — callers that skip child creation should finalize the root
 * directly instead of calling this function.
 */
export function deriveRootLifecycleFromChildren(
  children: ReadonlyArray<AHPPacket>,
): AHPLifecycle {
  if (children.length === 0) {
    // No child work recorded — we cannot declare success.
    return AHPLifecycle.INCONCLUSIVE;
  }

  // Rule 1: Blocked / ambiguous state takes highest precedence.
  if (children.some((c) => c.lifecycle === AHPLifecycle.INCONCLUSIVE)) {
    return AHPLifecycle.INCONCLUSIVE;
  }

  // Rule 2: Any failure prevents overall success.
  if (children.some((c) => c.lifecycle === AHPLifecycle.FAILED)) {
    return AHPLifecycle.FAILED;
  }

  // Rule 3: All branches successfully completed.
  if (children.every((c) => c.lifecycle === AHPLifecycle.COMPLETE)) {
    return AHPLifecycle.COMPLETE;
  }

  // Rule 4: Unexpected/mixed state (some children non-terminal) → inconclusive.
  return AHPLifecycle.INCONCLUSIVE;
}
