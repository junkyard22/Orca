import type { OrcaEvent, OrcaEventType } from "./types.js";

type Handler = (e: OrcaEvent) => void;

/**
 * Tiny typed event emitter — no external dependencies.
 * Used internally by createOrcaRuntime; exposed via runtime.on().
 */
export class OrcaEmitter {
  private readonly buckets = new Map<OrcaEventType, Set<Handler>>();

  emit(event: OrcaEvent): void {
    this.buckets.get(event.type)?.forEach((h) => h(event));
  }

  on(type: OrcaEventType, handler: Handler): () => void {
    let bucket = this.buckets.get(type);
    if (!bucket) {
      bucket = new Set();
      this.buckets.set(type, bucket);
    }
    bucket.add(handler);
    return () => this.buckets.get(type)?.delete(handler);
  }

  clear(): void {
    this.buckets.clear();
  }
}
