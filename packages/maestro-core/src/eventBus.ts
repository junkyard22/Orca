/**
 * EventBus — Lightweight typed event emitter for orchestration lifecycle events.
 *
 * No external dependencies. Logger is optional and injected at construction time.
 * Extracted from maestro-vscode/src/eventBus.ts.
 */

import { OrchestrationEvent, OrchestrationEventPayload } from './types/orchestration';
import { Logger } from './interfaces';

type EventHandler = (payload: OrchestrationEventPayload) => void;

export class EventBus {
  private handlers: Map<OrchestrationEvent, Set<EventHandler>> = new Map();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Subscribe to an orchestration event.
   */
  on(event: OrchestrationEvent, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from an orchestration event.
   */
  off(event: OrchestrationEvent, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /**
   * Emit an orchestration event. All registered handlers for the event
   * are called synchronously in registration order.
   */
  emit(event: OrchestrationEvent, payload: OrchestrationEventPayload): void {
    this.logger?.info(`[EventBus] ${event} | run_id=${payload.run_id}`);
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(payload);
        } catch (err) {
          this.logger?.error(`[EventBus] Handler error for ${event}`, err as Error);
        }
      }
    }
  }

  /**
   * Remove all handlers (useful for tests and disposal).
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton instance
let _instance: EventBus | null = null;

/**
 * Get the singleton EventBus instance.
 * For DI-based usage, construct EventBus directly instead.
 */
export function getEventBus(logger?: Logger): EventBus {
  if (!_instance) {
    _instance = new EventBus(logger);
  }
  return _instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetEventBus(): void {
  if (_instance) {
    _instance.clear();
  }
  _instance = null;
}
