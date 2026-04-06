/**
 * Agent Handoff Protocol — type re-exports.
 *
 * The canonical definitions live in miranda-core (the AHP enforcer).
 * orca-core depends on miranda-core, so we simply re-export from there
 * to avoid a circular dependency while keeping this path available.
 */
export type {
  AHPInput,
  AHPConstraint,
  AHPExpectedOutput,
  AHPTraceEntry,
  AHPMeta,
  AHPPacket,
} from "@clawde/miranda-core";

export { AHPLifecycle, AHPVerdict } from "@clawde/miranda-core";
