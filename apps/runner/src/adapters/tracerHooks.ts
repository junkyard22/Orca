/**
 * tracerHooks.ts — lightweight hook registry for tracer instrumentation.
 *
 * Allows the tracer to observe internal adapter events (Dewey brief, plan
 * review, role selection) without coupling core packages to tracing concerns.
 *
 * Usage:
 *   // In tracer.ts:
 *   setTracerHook((event, data) => { ... });
 *
 *   // In maestroAdapter.ts:
 *   traceEvent("dewey:brief", brief);
 */

export type TracerEvent =
  | { type: "dewey:brief";   data: { userName: string; relevantPreferences: string[]; relevantContext: string[]; availableApps: string[]; suggestedTone: string } }
  | { type: "dewey:review";  data: { approved: boolean; concerns: string[]; suggestions: string[] } }
  | { type: "brain:route";   data: { role: string; isFallback: boolean; warning?: string; coreRole: string } }
  | { type: "tool:call";     data: { tool: string; input: Record<string, unknown> } }
  | { type: "tool:result";   data: { tool: string; ok: boolean; outputLength: number; error?: string } };

type HookFn = (event: TracerEvent) => void;

let _hook: HookFn | null = null;

export function setTracerHook(fn: HookFn): void {
  _hook = fn;
}

export function traceEvent(event: TracerEvent): void {
  _hook?.(event);
}
