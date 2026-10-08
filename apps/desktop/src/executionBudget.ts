import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMAdapter, LLMRequest, LLMResponse } from '@clawde/miranda-core';
import type { ProviderEntry } from './settings';

// Reviewed 2026-10-08 against https://platform.claude.com/docs/en/about-claude/pricing.
// Direct, standard inference only; no discounts or undocumented model aliases.
// Reserve the documented maximum input context, NOT a heuristic token estimate.
// In particular, the $3 demo cap cannot safely admit an Opus 5.5 request with
// this bound ($4 input + output). A tighter certified bound requires native API
// support; the compatibility API's token-count estimates are not a hard ceiling.
const PRICING: Record<string, { input: number; output: number; maxInput: number; maxOutput: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, maxInput: 1_000_000, maxOutput: 128_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, maxInput: 1_000_000, maxOutput: 128_000 },
  // Use the higher long-prompt tariff for every reservation and settlement.
  'claude-haiku-5-5': { input: 0.5, output: 2.5, maxInput: 1_000_000, maxOutput: 128_000 },
};
const PRICING_EXPIRES = Date.parse('2026-11-07T00:00:00Z');

export class BudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'BudgetError'; }
}
export interface BudgetSnapshot {
  limitUsd: number | null;
  spentUsd: number;
  reservedUsd: number;
  uncertainUsd: number;
  inputTokens: number;
  outputTokens: number;
  blockedReason?: string;
}
export class ExecutionBudget {
  readonly events: Array<{ at: string; stage: string; detail: unknown }> = [];
  private spent = 0;
  private uncertain = 0;
  private reservations = new Map<number, number>();
  private nextId = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private blockedReason?: string;
  private trace?: (stage: string, detail?: unknown) => void;
  readonly limit: number | null;
  constructor(limitUsd: number, readonly signal?: AbortSignal) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new BudgetError('Invalid budget configuration; execution refused.');
    this.limit = limitUsd === 0 ? null : limitUsd;
    this.record('budget.configured', this.snapshot());
  }
  snapshot(): BudgetSnapshot {
    return { limitUsd: this.limit, spentUsd: this.spent, reservedUsd: [...this.reservations.values()].reduce((a,b)=>a+b,0), uncertainUsd: this.uncertain, inputTokens: this.inputTokens, outputTokens: this.outputTokens, ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}) };
  }
  attachTrace(trace?: (stage: string, detail?: unknown) => void): void {
    if (!trace || this.trace === trace) return;
    if (!this.trace) for (const e of this.events) trace(e.stage, e.detail);
    this.trace = trace;
  }
  private record(stage: string, detail: unknown): void {
    this.events.push({ at: new Date().toISOString(), stage, detail });
    this.trace?.(stage, detail);
  }
  assertActive(): void {
    if (this.signal?.aborted) { const e = new Error(String(this.signal.reason?.message ?? this.signal.reason ?? 'Cancelled.')); e.name = 'AbortError'; throw e; }
    if (this.blockedReason) throw new BudgetError(this.blockedReason);
  }
  private block(reason: string): never {
    this.blockedReason = reason;
    this.record('budget.blocked', { reason, ...this.snapshot() });
    throw new BudgetError(reason);
  }
  async invoke(provider: ProviderEntry, model: string, request: LLMRequest, call: (request: LLMRequest) => Promise<LLMResponse>): Promise<LLMResponse> {
    this.assertActive();
    const signal = this.signal && request.signal ? AbortSignal.any([this.signal, request.signal]) : this.signal ?? request.signal;
    if (signal?.aborted) { const e=new Error('Cancelled before model request.');e.name='AbortError';throw e; }
    if (this.limit === null) return call({ ...request, signal });
    let url: URL;
    try { url = new URL(provider.baseUrl); } catch { return this.block('Budget-constrained execution requires a verified provider endpoint.'); }
    // A provider label or loopback endpoint does not certify unmetered inference.
    if (provider.type === 'ollama') return this.block('Ollama metering is not verified; budget-constrained request refused.');
    const tariff = url.origin === 'https://api.anthropic.com' && /^\/v1\/?$/.test(url.pathname) ? PRICING[model] : undefined;
    if (!tariff || Date.now() >= PRICING_EXPIRES) return this.block(`No current verified price and token bound for ${model}; request refused.`);
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens! <= 0 || request.maxTokens! > tariff.maxOutput) return this.block('Invalid or unbounded output token limit; request refused.');
    const maximum = (tariff.maxInput * tariff.input + request.maxTokens! * tariff.output) / 1_000_000;
    const snapshot = this.snapshot();
    if (this.spent + snapshot.reservedUsd + maximum > this.limit + 1e-12) return this.block(`Budget cannot reserve $${maximum.toFixed(6)} for ${model} within the $${this.limit.toFixed(2)} cap.`);
    const id = ++this.nextId;
    this.reservations.set(id, maximum); // synchronous: concurrent requests cannot oversubscribe.
    this.record('budget.reserved', { id, model, maximumUsd: maximum, inputBound: tariff.maxInput, maxOutputTokens: request.maxTokens, ...this.snapshot() });
    let settled = false;
    try {
      this.assertActive();
      const response = await call({ ...request, signal, requireUsage: true });
      const usage = response.usage;
      if (!usage || ![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0) || usage.totalTokens!==usage.promptTokens+usage.completionTokens || usage.promptTokens>tariff.maxInput || usage.completionTokens>request.maxTokens! || (response.model && response.model!==model)) {
        return this.block(`Missing, inconsistent or out-of-bound usage for ${model}; reservation retained and further calls blocked.`);
      }
      const cost = (usage.promptTokens * tariff.input + usage.completionTokens * tariff.output) / 1_000_000;
      this.reservations.delete(id);
      this.spent += cost;
      this.inputTokens += usage.promptTokens;
      this.outputTokens += usage.completionTokens;
      settled = true;
      this.record('budget.settled', { id, model, usage, estimatedUpperCostUsd: cost, ...this.snapshot() });
      this.assertActive();
      return response;
    } catch (error) {
      // An aborted/network-failed request may already be charged. Never refund
      // an uncertain in-flight request or admit a fallback on presumed zero cost.
      if (!settled) {
        this.reservations.delete(id);
        this.spent += maximum;
        this.uncertain += maximum;
        this.blockedReason ??= `Usage unavailable for ${model}; further requests refused.`;
        this.record('budget.uncertain', { id, model, chargedUpperBoundUsd: maximum, error: error instanceof Error ? error.message : String(error), ...this.snapshot() });
      }
      throw error;
    }
  }
}
const scope = new AsyncLocalStorage<ExecutionBudget>();
export const currentExecutionBudget = (): ExecutionBudget | undefined => scope.getStore();
export function withExecutionBudget<T>(budget: ExecutionBudget, invoke: () => T): T { return scope.run(budget, invoke); }
export function budgetedAdapter(adapter: LLMAdapter, provider: ProviderEntry, model: string): LLMAdapter {
  const invoke = (request: LLMRequest, call: (r: LLMRequest)=>Promise<LLMResponse>) => {
    const budget = currentExecutionBudget();
    if (!budget) throw new BudgetError('No execution budget context; model request refused.');
    return budget.invoke(provider, request.model || model, request, call);
  };
  return { name: adapter.name, complete: request=>invoke(request,r=>adapter.complete(r)), ...(adapter.stream ? { stream: (request: LLMRequest, onToken: (chunk:string)=>void)=>invoke(request,r=>adapter.stream!(r,onToken)) } : {}) };
}
