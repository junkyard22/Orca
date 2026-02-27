/**
 * Core Event Bus - Runtime observability layer
 * 
 * Phase 1: Minimal typed events for core runtime operations
 * No dependencies. No heavy framework. Just event emission.
 * 
 * Consumers optional - events emitted whether subscribed or not.
 * Future: Sessions, audit logs, monitoring can subscribe.
 */

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * Runtime events emitted by core execution
 * 
 * Phase 1: Key lifecycle events only
 * - Tool execution: requested → started → verified → failed
 * - Doctor: diagnostics run
 * 
 * NO payloads with stdout/stderr (keep events lightweight)
 * Detailed data available via other channels (run manager, logs)
 */
export type RuntimeEvent =
  // Tool lifecycle
  | {
      type: 'tool:requested';
      toolName: string;
      timestamp: number;
      sessionId?: string;
    }
  | {
      type: 'tool:started';
      toolName: string;
      runId: string;
      timestamp: number;
    }
  | {
      type: 'tool:verified';
      toolName: string;
      runId: string;
      status: 'PASS' | 'FAIL';  // Verification outcome
      timestamp: number;
    }
  | {
      type: 'tool:failed';
      toolName: string;
      runId: string;
      reason: string;  // Error message only (not full stderr)
      timestamp: number;
    }
  // Doctor diagnostics
  | {
      type: 'doctor:run';
      trigger: 'manual' | 'auto';
      timestamp: number;
      summary: {
        pass: number;
        warn: number;
        fail: number;
      };
    };

// ============================================================================
// EVENT BUS
// ============================================================================

type EventHandler = (event: RuntimeEvent) => void;

/**
 * Minimal event bus - pub/sub for runtime events
 * 
 * Phase 1: Simple in-memory event bus
 * - Type-safe event emission
 * - Subscription management
 * - No persistence (events are ephemeral)
 * - No queuing (fire and forget)
 */
export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();
  private allHandlers: EventHandler[] = [];

  /**
   * Emit an event to all subscribers
   * 
   * Phase 1: Fire and forget - no error handling for handlers
   * Handlers should not throw (best effort)
   */
  emit(event: RuntimeEvent): void {
    // Emit to type-specific handlers
    const typeHandlers = this.handlers.get(event.type) || [];
    for (const handler of typeHandlers) {
      try {
        handler(event);
      } catch (error) {
        // Silent failure - event handlers should not break core flow
        console.error(`[EventBus] Handler error for ${event.type}:`, error);
      }
    }

    // Emit to wildcard handlers (subscribed to all events)
    for (const handler of this.allHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error(`[EventBus] Wildcard handler error:`, error);
      }
    }
  }

  /**
   * Subscribe to specific event type
   * Returns unsubscribe function
   */
  on(type: RuntimeEvent['type'], handler: EventHandler): () => void {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);

    // Return unsubscribe function
    return () => {
      const current = this.handlers.get(type) || [];
      const index = current.indexOf(handler);
      if (index > -1) {
        current.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to all events (wildcard)
   * Returns unsubscribe function
   */
  onAll(handler: EventHandler): () => void {
    this.allHandlers.push(handler);

    // Return unsubscribe function
    return () => {
      const index = this.allHandlers.indexOf(handler);
      if (index > -1) {
        this.allHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Remove all handlers for a specific type
   */
  off(type: RuntimeEvent['type']): void {
    this.handlers.delete(type);
  }

  /**
   * Remove all handlers (reset)
   */
  clear(): void {
    this.handlers.clear();
    this.allHandlers = [];
  }

  /**
   * Get subscriber count (for debugging)
   */
  getSubscriberCount(type?: RuntimeEvent['type']): number {
    if (type) {
      return (this.handlers.get(type) || []).length;
    }
    // Total subscribers across all types + wildcard
    let total = this.allHandlers.length;
    const handlerArrays = Array.from(this.handlers.values());
    for (let i = 0; i < handlerArrays.length; i++) {
      total += handlerArrays[i].length;
    }
    return total;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/**
 * Global event bus instance
 * 
 * Phase 1: Single shared bus
 * Future: Could support multiple buses for isolation
 */
export const eventBus = new EventBus();

// ============================================================================
// HELPER: Event creation
// ============================================================================

/**
 * Create timestamp for events (milliseconds since epoch)
 */
export function createTimestamp(): number {
  return Date.now();
}
