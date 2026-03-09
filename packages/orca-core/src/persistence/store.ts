/**
 * Persistence store interface — defines the contract for persisting orca-core runs.
 *
 * The concrete implementation (SQLite, Postgres, JSONL, …) lives in the
 * app shell and is injected via OrcaRuntimeDeps.store.
 * orca-core stays storage-agnostic.
 */

export type {
  RunRecord,
  ThoughtRecord,
  ToolEvent,
  FileChange,
  OrcaStore,
} from "./types.js";
