/**
 * Miranda Core — budgeted LLM adapter.
 *
 * Wraps any LLMAdapter so every request it makes is accounted in the task
 * budget ledger that is active for the current execution scope, whichever
 * code path issued it. The wrapper reserves before dispatch, settles with the
 * provider's reported usage afterwards, and marks a request whose outcome is
 * unknown (failure or cancellation after dispatch) as unreconciled. It never
 * invents usage, never changes the model, and never retries.
 *
 * The scope is an AsyncLocalStorage: the runtime enters it once per task, so
 * adapters constructed anywhere (Brain, workers, narrator, fallbacks) resolve
 * the same ledger. Outside any task scope the `fallback` ledger (a session
 * ledger, accounting only) receives the request, so nothing escapes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMAdapter } from "../llm/adapter.js";
import type { MirandaGate } from "../gate/mirandaGate.js";
import type { LLMRequest, LLMResponse } from "../llm/types.js";
import { BudgetRefusedError, TaskBudgetLedger } from "./ledger.js";
import type { PriceProvider } from "./pricing.js";
import type { Reservation } from "./ledger.js";

interface BudgetScope {
  ledger: TaskBudgetLedger;
}
interface AttributionScope {
  role?: string;
  stage?: string;
  /**
   * Miranda gate to pass the budget decision through before dispatch. The
   * checkpoint is `before_llm_call` at stage `budget:<stage>`, so the gate
   * sees authorized / no-hard-budget / refused (limit, pricing, unreconciled,
   * invalid request) for every request, whatever path issued it.
   */
  gate?: Pick<MirandaGate, "beforeLLMCall">;
}

const budgetScope = new AsyncLocalStorage<BudgetScope>();
const attributionScope = new AsyncLocalStorage<AttributionScope>();

/** Run `fn` with `ledger` as the budget for every model request made inside it. */
export function runWithBudget<T>(ledger: TaskBudgetLedger, fn: () => T): T {
  return budgetScope.run({ ledger }, fn);
}

/** The ledger active for the current execution scope, if any. */
export function currentBudgetLedger(): TaskBudgetLedger | undefined {
  return budgetScope.getStore()?.ledger;
}

/** Attribute the model requests made inside `fn` to a role and stage. */
export function withBudgetAttribution<T>(attribution: AttributionScope, fn: () => T): T {
  const current = attributionScope.getStore() ?? {};
  return attributionScope.run({ ...current, ...attribution }, fn);
}

export function currentBudgetAttribution(): AttributionScope {
  return attributionScope.getStore() ?? {};
}

export interface BudgetedAdapterOptions {
  provider: PriceProvider;
  /** Model the adapter sends when the request leaves `model` empty. */
  defaultModel: string;
  /** Ledger used when no task scope is active (accounting only). */
  fallback?: () => TaskBudgetLedger | undefined;
  /** Whether a request asks for provider-side reasoning (billed as output). */
  enableThinking?: boolean;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Wrap `adapter` so its requests are reserved and settled in the active ledger.
 * A refusal surfaces as BudgetRefusedError before any network activity.
 */
export function budgetedAdapter(adapter: LLMAdapter, options: BudgetedAdapterOptions): LLMAdapter {
  const invoke = async (request: LLMRequest, stream: boolean, call: (r: LLMRequest) => Promise<LLMResponse>): Promise<LLMResponse> => {
    const ledger = currentBudgetLedger() ?? options.fallback?.();
    if (!ledger) return call(request);
    const model = request.model || options.defaultModel;
    const attribution = currentBudgetAttribution();
    const budgetRequest = {
      provider: options.provider,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      stream,
      role: attribution.role,
      stage: attribution.stage,
      enableThinking: request.enableThinking ?? options.enableThinking,
    };
    if (attribution.gate) {
      // Miranda's checkpoint for this request's budget decision. The decision
      // is previewed here and committed by `reserve` below; both read the
      // same ledger synchronously, so they cannot disagree.
      const decision = ledger.decide(budgetRequest);
      const s = ledger.snapshot();
      const gate = attribution.gate.beforeLLMCall({
        stage: `budget:${attribution.stage ?? "model_request"}`,
        model,
        budgetUsed: s.accountedUsd + s.reservedUsd,
        budgetLimit: s.limitUsd ?? Infinity,
        budget: decision,
      });
      if (!gate.allowed) {
        // Record the refusal in the ledger as well, then surface it.
        try { ledger.reserve(budgetRequest); } catch (error) { if (!(error instanceof BudgetRefusedError)) throw error; }
        throw new BudgetRefusedError({ ...decision, allowed: false, reason: gate.reason });
      }
    }
    const reservation: Reservation = ledger.reserve(budgetRequest);
    if (request.signal?.aborted) {
      ledger.release(reservation, "cancelled before dispatch");
      const e = new Error("Cancelled before the model request was sent.");
      e.name = "AbortError";
      throw e;
    }
    let response: LLMResponse;
    try {
      response = await call(request);
    } catch (error) {
      // The request may have reached the provider: its upper bound stays charged.
      ledger.markUnreconciled(reservation, isAbort(error) ? "the request was cancelled after dispatch" : `the request failed after dispatch (${error instanceof Error ? error.message : String(error)})`);
      throw error;
    }
    ledger.settle(reservation, response.usage, response.model);
    return response;
  };

  return {
    name: adapter.name,
    complete: (request) => invoke(request, false, (r) => adapter.complete(r)),
    ...(adapter.stream
      ? { stream: (request: LLMRequest, onToken: (chunk: string) => void) => invoke(request, true, (r) => adapter.stream!(r, onToken)) }
      : {}),
  };
}

export { BudgetRefusedError };
