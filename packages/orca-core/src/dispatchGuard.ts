/**
 * Dispatch guard — the runtime's last word on whether a task may still ask a
 * model anything.
 *
 * This module makes no model call of its own. It forwards to a service the
 * shell already built behind Miranda's `beforeLLMCall` gate (the desktop's
 * llmGate, the budgeted adapters) and adds one check in front of it: once the
 * task has been cancelled or has ended, a late worker callback that still
 * holds `ctx.llm` is refused with an AbortError, exactly as a late tool call
 * is refused. Budget, policy and provider decisions stay where they are.
 */
import { createAbortError } from "./abort.js";
import type { TaskLifecycle } from "./lifecycle.js";
import type { OrcaLLMService } from "./types.js";

export function guardDispatch(gated: OrcaLLMService, lifecycle: TaskLifecycle): OrcaLLMService {
  const refused = () => Promise.reject(createAbortError(`model call not made: the task is ${lifecycle.current.toLowerCase()}.`));
  return {
    ...gated,
    complete: (prompt, opts) => (lifecycle.mayDispatch ? gated.complete(prompt, opts) : refused()),
    stream: (prompt, opts, onChunk) => (lifecycle.mayDispatch ? gated.stream(prompt, opts, onChunk) : refused()),
  };
}
