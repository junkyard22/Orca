/**
 * Miranda Core — task budget ledger.
 *
 * One ledger per task, shared by every model request the task makes (Brain,
 * workers, fallbacks, repairs, narrator, utility roles) whatever path they
 * come from. It keeps six numbers apart:
 *
 *   estimated   — what a request is expected to cost before it is sent
 *   reserved    — capacity committed to requests in flight (upper bounds)
 *   usage       — token counts the provider actually reported
 *   spent       — reconciled monetary cost of settled requests
 *   unreconciled— upper bounds of requests that reached the provider but whose
 *                 billing outcome is unknown (no usage, network failure, cancel)
 *   remaining   — limit − spent − unreconciled − reserved
 *
 * Reservations are committed synchronously, so concurrent requests cannot
 * oversubscribe the limit: the first `reserve()` to run sees the second's
 * reservation already counted, or vice versa. Nothing here talks to a
 * provider; the budgeted adapter does, and reports back through `settle`,
 * `release` and `markUnreconciled`.
 *
 * A hard budget fails closed: no price, a stale price, an unbounded request,
 * an unreconciled charge, or a response that exceeded its reservation all
 * stop further paid requests, each with a reason a user can act on. Without a
 * hard budget the ledger only accounts.
 */
import type { LLMMessage, TokenUsage } from "../llm/types.js";
import { resolvePrice, tariffForPrompt } from "./pricing.js";
import type { CustomModelPrice, PriceProvider, PriceResolution } from "./pricing.js";
import { inputTokenBound } from "./tokenBound.js";

export type BudgetDecisionKind =
  | "authorized"
  | "no_hard_budget"
  | "refused_limit"
  | "refused_pricing_unknown"
  | "refused_unreconciled"
  | "refused_invalid_request";

export interface BudgetDecision {
  kind: BudgetDecisionKind;
  allowed: boolean;
  reason: string;
  /** USD the request would reserve (upper bound); undefined when it cannot be priced. */
  reservationUsd?: number;
  inputTokenBound?: number;
  maxOutputTokens?: number;
  price: PriceResolution;
  remainingUsd?: number | null;
}

export interface BudgetRequest {
  provider: PriceProvider;
  model: string;
  messages: readonly LLMMessage[];
  maxTokens: number;
  stream?: boolean;
  role?: string;
  stage?: string;
  /** Request asked the provider for reasoning/thinking; those tokens are billed as output within maxTokens. */
  enableThinking?: boolean;
}

export type LedgerEntryStatus = "reserved" | "settled" | "released" | "unreconciled" | "refused";
export type CostBasis = "measured" | "upper_bound" | "estimate" | "none";

export interface LedgerEntry {
  id: number;
  at: string;
  taskId: string;
  role?: string;
  stage?: string;
  provider: string;
  model: string;
  status: LedgerEntryStatus;
  decision: BudgetDecisionKind;
  priceStatus: PriceResolution["status"];
  /** Reservation (upper bound) in USD, 0 for local inference, undefined when unpriced. */
  reservationUsd?: number;
  inputTokenBound?: number;
  maxOutputTokens?: number;
  usage?: TokenUsage;
  /** Model the provider says answered, when it differs from the one requested. */
  responseModel?: string;
  costUsd?: number;
  costBasis: CostBasis;
  notes: string[];
}

export interface Reservation {
  id: number;
  reservationUsd: number;
  decision: BudgetDecision;
}

export interface BudgetBlock {
  kind: Exclude<BudgetDecisionKind, "authorized" | "no_hard_budget">;
  reason: string;
}

export interface BudgetAggregate {
  requests: number;
  spentUsd: number;
  unreconciledUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetSnapshot {
  taskId: string;
  /** Hard limit in USD, or null when no hard budget applies. */
  limitUsd: number | null;
  limitSource?: string;
  /** Reconciled cost of settled requests (measured usage × reviewed or custom price). */
  spentUsd: number;
  /** Upper bounds charged for requests whose billing outcome is unknown. */
  unreconciledUsd: number;
  /** Outstanding reservations for requests in flight. */
  reservedUsd: number;
  /** limit − spent − unreconciled − reserved; null without a hard limit. */
  remainingUsd: number | null;
  /** Spending accounted so far: spent + unreconciled. */
  accountedUsd: number;
  /** Whether every settled request was priced from measured usage. */
  costBasis: CostBasis;
  inputTokens: number;
  outputTokens: number;
  cachedPromptTokens: number;
  /** Requests whose usage or price was unavailable, so their tokens or cost are not in the totals. */
  unpricedRequests: number;
  requests: { total: number; settled: number; unreconciled: number; released: number; refused: number; inFlight: number };
  byRole: Record<string, BudgetAggregate>;
  byProvider: Record<string, BudgetAggregate>;
  blocked?: BudgetBlock;
  /** Pricing notes worth showing (unknown/stale/local prices seen). */
  notes: string[];
}

export class BudgetRefusedError extends Error {
  constructor(readonly decision: BudgetDecision) {
    super(decision.reason);
    this.name = "BudgetRefusedError";
  }
}

export interface TaskBudgetLedgerOptions {
  taskId: string;
  /** Hard limit in USD; 0, null or undefined means no hard budget (accounting only). */
  limitUsd?: number | null;
  limitSource?: string;
  customPrices?: readonly CustomModelPrice[];
  /** Receives every ledger event (for the pipeline trace). */
  trace?: (stage: string, detail: unknown) => void;
  /** Called after any change, with the new snapshot (for UI updates). */
  onChange?: (snapshot: BudgetSnapshot) => void;
  /** Informational parent (a session ledger) that mirrors settled and unreconciled costs. */
  parent?: TaskBudgetLedger;
  now?: () => Date;
}

const EPSILON = 1e-9;

function usd(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

export class TaskBudgetLedger {
  readonly taskId: string;
  readonly limitUsd: number | null;
  readonly limitSource?: string;
  private readonly customPrices: readonly CustomModelPrice[];
  private readonly listeners: Array<{ trace?: (stage: string, detail: unknown) => void; onChange?: (snapshot: BudgetSnapshot) => void }> = [];
  private readonly parent?: TaskBudgetLedger;
  private readonly now: () => Date;
  private readonly entries: LedgerEntry[] = [];
  private readonly open = new Map<number, Reservation>();
  private nextId = 0;
  private spent = 0;
  private unreconciled = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedPromptTokens = 0;
  private unpriced = 0;
  private blocked?: BudgetBlock;
  private readonly pricingNotes = new Set<string>();

  constructor(options: TaskBudgetLedgerOptions) {
    const limit = options.limitUsd;
    if (limit !== undefined && limit !== null && (!Number.isFinite(limit) || limit < 0)) {
      throw new Error(`Invalid budget limit ${String(limit)}: it must be a non-negative number of US dollars.`);
    }
    this.taskId = options.taskId;
    this.limitUsd = limit === undefined || limit === null || limit === 0 ? null : limit;
    this.limitSource = options.limitSource;
    this.customPrices = options.customPrices ?? [];
    if (options.trace || options.onChange) this.listeners.push({ trace: options.trace, onChange: options.onChange });
    this.parent = options.parent;
    this.now = options.now ?? (() => new Date());
    this.record("budget.configured", { limitUsd: this.limitUsd, limitSource: this.limitSource });
  }

  get hardBudget(): boolean {
    return this.limitUsd !== null;
  }

  private record(stage: string, detail: unknown): void {
    for (const l of this.listeners) l.trace?.(stage, detail);
  }

  private changed(): void {
    if (this.listeners.some((l) => l.onChange)) { const s = this.snapshot(); for (const l of this.listeners) l.onChange?.(s); }
  }

  private reservedTotal(): number {
    let total = 0;
    for (const r of this.open.values()) total += r.reservationUsd;
    return total;
  }

  private block(kind: BudgetBlock["kind"], reason: string): void {
    if (!this.blocked) {
      this.blocked = { kind, reason };
      this.record("budget.blocked", { kind, reason, ...this.snapshot() });
    }
  }

  /** Decide, without committing, whether a request may be sent. */
  decide(request: BudgetRequest): BudgetDecision {
    const price = resolvePrice({ provider: request.provider, model: request.model, customPrices: this.customPrices, now: this.now() });
    if (price.status === "unknown" || price.status === "stale" || price.status === "local") this.pricingNotes.add(price.note);
    const bound = inputTokenBound(request.messages);
    const maxTokens = request.maxTokens;
    const remaining = this.remaining();
    const base = { price, remainingUsd: remaining, maxOutputTokens: maxTokens, ...(bound !== null ? { inputTokenBound: bound } : {}) };

    const priced = price.tariff !== undefined && price.status !== "stale";
    let reservationUsd: number | undefined;
    if (priced && bound !== null && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      const inputBound = price.maxInputTokens ? Math.min(bound, price.maxInputTokens) : bound;
      const tariff = tariffForPrompt(price, inputBound)!;
      reservationUsd = usd((inputBound * tariff.inputPer1M + maxTokens * tariff.outputPer1M) / 1_000_000);
    }

    if (!this.hardBudget) {
      return {
        ...base, kind: "no_hard_budget", allowed: true,
        reason: reservationUsd !== undefined ? `no hard budget; estimated upper cost $${reservationUsd.toFixed(4)} (${price.status} price)` : `no hard budget; cost estimate unavailable (${price.note})`,
        ...(reservationUsd !== undefined ? { reservationUsd } : {}),
      };
    }

    if (this.blocked) {
      return { ...base, kind: this.blocked.kind === "refused_unreconciled" ? "refused_unreconciled" : this.blocked.kind, allowed: false, reason: `budget is blocked: ${this.blocked.reason}` };
    }
    if (price.status === "unknown" || price.status === "stale") {
      return { ...base, kind: "refused_pricing_unknown", allowed: false, reason: `pricing ${price.status} for ${request.model} on ${price.providerLabel} under a hard budget of $${this.limitUsd!.toFixed(2)}: ${price.note}` };
    }
    if (bound === null) {
      return { ...base, kind: "refused_invalid_request", allowed: false, reason: "the request contains content whose input tokens cannot be bounded, so its cost cannot be reserved" };
    }
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      return { ...base, kind: "refused_invalid_request", allowed: false, reason: `the request has no valid output token limit (maxTokens=${String(maxTokens)}), so its cost is unbounded` };
    }
    if (price.maxOutputTokens !== undefined && maxTokens > price.maxOutputTokens) {
      return { ...base, kind: "refused_invalid_request", allowed: false, reason: `maxTokens ${maxTokens} exceeds the documented output limit of ${price.maxOutputTokens} for ${request.model}; lower the role's max tokens` };
    }
    const reservation = reservationUsd!;
    if (remaining !== null && reservation > remaining + EPSILON) {
      const snapshot = this.snapshot();
      return {
        ...base, kind: "refused_limit", allowed: false, reservationUsd: reservation,
        reason: `reserving $${reservation.toFixed(4)} for ${request.model} (${bound.toLocaleString()} input-token bound × $${tariffForPrompt(price, bound)!.inputPer1M}/M + ${maxTokens.toLocaleString()} max output × $${tariffForPrompt(price, bound)!.outputPer1M}/M) would exceed the remaining task budget of $${Math.max(0, remaining).toFixed(4)} (limit $${this.limitUsd!.toFixed(2)}, spent $${snapshot.spentUsd.toFixed(4)}, unreconciled $${snapshot.unreconciledUsd.toFixed(4)}, reserved $${snapshot.reservedUsd.toFixed(4)}); ${this.limitSource === "legacy_default" ? "this is Orca's historical default budget, never explicitly chosen — set the budget you intend in Settings → General (0 disables the hard limit)" : "raise the task budget in Settings or use a cheaper model/shorter prompt"}`,
      };
    }
    return { ...base, kind: "authorized", allowed: true, reservationUsd: reservation, reason: `reserved $${reservation.toFixed(4)} of $${(remaining ?? 0).toFixed(4)} remaining for ${request.model}` };
  }

  /**
   * Commit a reservation for a request about to be sent. Synchronous and
   * atomic within the process: concurrent callers see each other's
   * reservations. Throws BudgetRefusedError when the request may not be sent.
   */
  reserve(request: BudgetRequest): Reservation {
    const decision = this.decide(request);
    const id = ++this.nextId;
    const providerLabel = request.provider.name || request.provider.type;
    const entry: LedgerEntry = {
      id, at: this.now().toISOString(), taskId: this.taskId, role: request.role, stage: request.stage,
      provider: providerLabel, model: request.model, status: decision.allowed ? "reserved" : "refused", decision: decision.kind,
      priceStatus: decision.price.status, costBasis: "none", notes: [],
      ...(decision.reservationUsd !== undefined ? { reservationUsd: decision.reservationUsd } : {}),
      ...(decision.inputTokenBound !== undefined ? { inputTokenBound: decision.inputTokenBound } : {}),
      maxOutputTokens: request.maxTokens,
    };
    if (decision.price.status !== "known" && decision.price.status !== "custom") entry.notes.push(decision.price.note);
    this.entries.push(entry);
    if (!decision.allowed) {
      entry.notes.push(decision.reason);
      this.record("budget.refused", { id, kind: decision.kind, reason: decision.reason, model: request.model, role: request.role, stage: request.stage });
      this.changed();
      throw new BudgetRefusedError(decision);
    }
    const reservation: Reservation = { id, reservationUsd: decision.reservationUsd ?? 0, decision };
    this.open.set(id, reservation);
    this.record("budget.reserved", { id, model: request.model, role: request.role, stage: request.stage, kind: decision.kind, reservationUsd: reservation.reservationUsd, inputTokenBound: decision.inputTokenBound, maxOutputTokens: request.maxTokens, priceStatus: decision.price.status, ...this.totals() });
    this.changed();
    return reservation;
  }

  private entryOf(id: number): LedgerEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Unknown budget reservation ${id}`);
    return entry;
  }

  private aggregate(entry: LedgerEntry, cost: number, unreconciled: number, usage?: TokenUsage): void {
    this.parent?.mirror(entry, cost, unreconciled, usage);
  }

  /** Mirror a child ledger's outcome into this (informational) ledger. */
  private mirror(child: LedgerEntry, cost: number, unreconciled: number, usage?: TokenUsage): void {
    const entry: LedgerEntry = { ...child, id: ++this.nextId, notes: [...child.notes] };
    this.entries.push(entry);
    this.spent = usd(this.spent + cost);
    this.unreconciled = usd(this.unreconciled + unreconciled);
    if (usage) { this.inputTokens += usage.promptTokens; this.outputTokens += usage.completionTokens; this.cachedPromptTokens += usage.cachedPromptTokens ?? 0; }
    else if (entry.status === "settled" || entry.status === "unreconciled") this.unpriced++;
    this.changed();
  }

  /**
   * The provider answered with usage. Settles the reservation at the measured
   * cost; records an overrun honestly and, under a hard budget, blocks further
   * spending when the reservation's bound proved wrong.
   */
  settle(reservation: Reservation, usage: TokenUsage | null | undefined, responseModel?: string): LedgerEntry {
    const entry = this.entryOf(reservation.id);
    if (!this.open.delete(reservation.id)) return entry;
    const price = reservation.decision.price;
    const valid = !!usage && [usage.promptTokens, usage.completionTokens, usage.totalTokens].every((n) => Number.isSafeInteger(n) && n >= 0) && usage.totalTokens === usage.promptTokens + usage.completionTokens;
    if (!valid) {
      return this.finishUnreconciled(entry, reservation, usage ? "the provider reported inconsistent usage" : "the provider reported no usage for a request that was sent");
    }
    const u = usage!;
    if (responseModel && responseModel !== entry.model) {
      entry.responseModel = responseModel;
      entry.notes.push(`the provider answered with ${responseModel}, not the requested ${entry.model}; priced at the requested model's rate`);
    }
    entry.usage = u;
    entry.status = "settled";
    this.inputTokens += u.promptTokens;
    this.outputTokens += u.completionTokens;
    this.cachedPromptTokens += u.cachedPromptTokens ?? 0;

    const tariff = price.status !== "stale" ? tariffForPrompt(price, u.promptTokens) : undefined;
    let cost = 0;
    let cacheWriteUnpriced = false;
    if (tariff) {
      // Cache writes are billed above the base input rate. Anthropic reports
      // them as part of the prompt; they are priced at the write rate when it
      // is known. Without a known write rate the base rate would under-charge,
      // so the write is priced at the base rate *and* flagged: a hard budget
      // then stops rather than trust a figure known to be low.
      const written = Math.min(u.cacheCreationTokens ?? 0, u.promptTokens);
      const cached = Math.min(u.cachedPromptTokens ?? 0, u.promptTokens - written);
      const cachedRate = tariff.cacheReadPer1M ?? tariff.inputPer1M;
      const writeRate = tariff.cacheWritePer1M ?? tariff.inputPer1M;
      cacheWriteUnpriced = written > 0 && tariff.cacheWritePer1M === undefined && price.status !== "local";
      cost = usd(((u.promptTokens - cached - written) * tariff.inputPer1M + cached * cachedRate + written * writeRate + u.completionTokens * tariff.outputPer1M) / 1_000_000);
      entry.costUsd = cost;
      entry.costBasis = cacheWriteUnpriced ? "estimate" : "measured";
      if (cacheWriteUnpriced) entry.notes.push(`${written} cache-creation tokens priced at the base input rate because no cache-write rate is known for ${entry.model}; the true charge is higher`);
      this.spent = usd(this.spent + cost);
    } else {
      entry.costBasis = "none";
      this.unpriced++;
      entry.notes.push(`usage measured but not priced: ${price.note}`);
    }
    this.record("budget.settled", { id: entry.id, model: entry.model, role: entry.role, stage: entry.stage, usage: u, costUsd: entry.costUsd, costBasis: entry.costBasis, reservationUsd: reservation.reservationUsd, ...this.totals() });
    this.aggregate(entry, cost, 0, u);

    if (this.hardBudget && cacheWriteUnpriced) {
      this.block("refused_pricing_unknown", `a response from ${entry.model} wrote ${u.cacheCreationTokens} tokens to the provider's cache and no cache-write rate is known for it; the charge cannot be bounded, so no further paid requests are made in this task (set a custom price with cacheWritePer1M in Settings)`);
    } else if (this.hardBudget && tariff && cost > reservation.reservationUsd + EPSILON) {
      entry.notes.push(`actual cost $${cost.toFixed(6)} exceeded the reservation $${reservation.reservationUsd.toFixed(6)}`);
      this.block("refused_unreconciled", `a response from ${entry.model} cost $${cost.toFixed(4)}, more than its $${reservation.reservationUsd.toFixed(4)} reservation; the reservation bound cannot be trusted, so no further paid requests are made in this task`);
    } else if (this.hardBudget && this.remaining() !== null && this.remaining()! < -EPSILON) {
      this.block("refused_limit", `spending reached $${this.accounted().toFixed(4)} against the $${this.limitUsd!.toFixed(2)} limit`);
    }
    this.changed();
    return entry;
  }

  private finishUnreconciled(entry: LedgerEntry, reservation: Reservation, why: string): LedgerEntry {
    entry.status = "unreconciled";
    entry.costBasis = reservation.reservationUsd > 0 ? "upper_bound" : "none";
    if (reservation.reservationUsd > 0) entry.costUsd = reservation.reservationUsd;
    entry.notes.push(`${why}; the reservation's upper bound is charged as unreconciled`);
    this.unreconciled = usd(this.unreconciled + reservation.reservationUsd);
    if (reservation.reservationUsd === 0) this.unpriced++;
    this.record("budget.unreconciled", { id: entry.id, model: entry.model, role: entry.role, stage: entry.stage, chargedUpperBoundUsd: reservation.reservationUsd, why, ...this.totals() });
    this.aggregate(entry, 0, reservation.reservationUsd);
    if (this.hardBudget) this.block("refused_unreconciled", `${why} (${entry.model}); $${reservation.reservationUsd.toFixed(4)} is charged as an unreconciled upper bound and no further paid requests are made in this task`);
    this.changed();
    return entry;
  }

  /**
   * The request reached the provider (or may have) but its outcome is unknown:
   * a network failure, a cancelled stream, an error after partial output. The
   * upper bound stays charged as unreconciled; a hard budget stops here.
   */
  markUnreconciled(reservation: Reservation, why: string): LedgerEntry {
    const entry = this.entryOf(reservation.id);
    if (!this.open.delete(reservation.id)) return entry;
    return this.finishUnreconciled(entry, reservation, why);
  }

  /** The request never reached the provider (refused locally, cancelled before dispatch): nothing is charged. */
  release(reservation: Reservation, why: string): LedgerEntry {
    const entry = this.entryOf(reservation.id);
    if (!this.open.delete(reservation.id)) return entry;
    entry.status = "released";
    entry.notes.push(`released: ${why}`);
    this.record("budget.released", { id: entry.id, model: entry.model, why, ...this.totals() });
    this.changed();
    return entry;
  }

  private accounted(): number {
    return usd(this.spent + this.unreconciled);
  }

  private remaining(): number | null {
    return this.limitUsd === null ? null : usd(this.limitUsd - this.spent - this.unreconciled - this.reservedTotal());
  }

  private totals(): Pick<BudgetSnapshot, "spentUsd" | "unreconciledUsd" | "reservedUsd" | "remainingUsd" | "limitUsd"> {
    return { limitUsd: this.limitUsd, spentUsd: this.spent, unreconciledUsd: this.unreconciled, reservedUsd: usd(this.reservedTotal()), remainingUsd: this.remaining() };
  }

  snapshot(): BudgetSnapshot {
    const byRole: Record<string, BudgetAggregate> = {};
    const byProvider: Record<string, BudgetAggregate> = {};
    const add = (table: Record<string, BudgetAggregate>, key: string, e: LedgerEntry) => {
      const agg = (table[key] ??= { requests: 0, spentUsd: 0, unreconciledUsd: 0, inputTokens: 0, outputTokens: 0 });
      agg.requests++;
      if (e.status === "settled") agg.spentUsd = usd(agg.spentUsd + (e.costUsd ?? 0));
      if (e.status === "unreconciled") agg.unreconciledUsd = usd(agg.unreconciledUsd + (e.costUsd ?? 0));
      if (e.usage) { agg.inputTokens += e.usage.promptTokens; agg.outputTokens += e.usage.completionTokens; }
    };
    const counts = { total: this.entries.length, settled: 0, unreconciled: 0, released: 0, refused: 0, inFlight: this.open.size };
    let anyMeasured = false;
    let anyBound = false;
    let anyNone = false;
    for (const e of this.entries) {
      if (e.status === "settled") { counts.settled++; if (e.costBasis === "measured") anyMeasured = true; else anyNone = true; }
      if (e.status === "unreconciled") { counts.unreconciled++; if (e.costBasis === "upper_bound") anyBound = true; else anyNone = true; }
      if (e.status === "released") counts.released++;
      if (e.status === "refused") counts.refused++;
      if (e.status === "settled" || e.status === "unreconciled") { add(byRole, e.role ?? "unattributed", e); add(byProvider, e.provider, e); }
    }
    const costBasis: CostBasis = anyNone ? "none" : anyBound ? "upper_bound" : anyMeasured ? "measured" : "none";
    return {
      taskId: this.taskId,
      ...this.totals(),
      ...(this.limitSource ? { limitSource: this.limitSource } : {}),
      accountedUsd: this.accounted(),
      costBasis: counts.settled + counts.unreconciled === 0 ? "none" : costBasis,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedPromptTokens: this.cachedPromptTokens,
      unpricedRequests: this.unpriced,
      requests: counts,
      byRole,
      byProvider,
      ...(this.blocked ? { blocked: this.blocked } : {}),
      notes: [...this.pricingNotes],
    };
  }

  /** Every request the ledger saw, in order. */
  history(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Reservations still open (requests in flight). */
  outstanding(): readonly Reservation[] {
    return [...this.open.values()];
  }

  /** Add a trace/change listener (the runtime attaches its trace and events to a ledger it did not create). Returns an unsubscribe. */
  subscribe(listener: { trace?: (stage: string, detail: unknown) => void; onChange?: (snapshot: BudgetSnapshot) => void }): () => void {
    this.listeners.push(listener);
    return () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); };
  }

  /** Stop further paid requests with a reason (user cancellation, external policy). */
  stop(reason: string): void {
    if (this.hardBudget) this.block("refused_unreconciled", reason);
  }
}
