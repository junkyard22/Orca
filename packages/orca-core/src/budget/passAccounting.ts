/**
 * Per-pass cost accounting on top of the task ledger.
 *
 * The runtime runs each Maestro pass (initial, repair) inside the task's
 * budget scope and reads the ledger before and after, so the pass's own
 * figures — measured cost, unreconciled upper bounds, tokens, refusals — go
 * into `metadata` where persistence, traces and the UI already look for them.
 * Nothing here estimates: a pass that made no priced request has no cost.
 */
import { runWithBudget, withBudgetAttribution } from "@clawde/miranda-core";
import type { BudgetSnapshot, MirandaGate, TaskBudgetLedger } from "@clawde/miranda-core";
import type { OrcaMaestroResult } from "../types.js";

export interface PassAccounting {
  costUsd?: number;
  costUnreconciledUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  costBasis: NonNullable<OrcaMaestroResult["metadata"]>["costBasis"];
  /** Requests the ledger settled during the pass. */
  settled: number;
  /** Requests the ledger refused during the pass. */
  refused: number;
  /** Reason of the last refusal during the pass, when any. */
  lastRefusal?: string;
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function accountingBetween(ledger: TaskBudgetLedger, before: BudgetSnapshot, beforeCount: number): PassAccounting {
  const after = ledger.snapshot();
  const entries = ledger.history().slice(beforeCount);
  const settled = entries.filter((e) => e.status === "settled").length;
  const unreconciled = entries.filter((e) => e.status === "unreconciled").length;
  const refusedEntries = entries.filter((e) => e.status === "refused");
  const measured = entries.some((e) => e.status === "settled" && e.costBasis === "measured");
  const bound = entries.some((e) => e.status === "unreconciled" && e.costBasis === "upper_bound");
  const unpriced = entries.some((e) => (e.status === "settled" || e.status === "unreconciled") && e.costBasis === "none");
  const costUsd = round(after.spentUsd - before.spentUsd);
  const costUnreconciledUsd = round(after.unreconciledUsd - before.unreconciledUsd);
  const inputTokens = after.inputTokens - before.inputTokens;
  const outputTokens = after.outputTokens - before.outputTokens;
  const anyUsage = inputTokens > 0 || outputTokens > 0;
  const lastRefusal = refusedEntries.length > 0 ? refusedEntries[refusedEntries.length - 1]!.notes.find((n) => n.length > 0) : undefined;
  return {
    ...(measured || costUsd > 0 ? { costUsd } : {}),
    ...(costUnreconciledUsd > 0 ? { costUnreconciledUsd } : {}),
    ...(anyUsage ? { inputTokens, outputTokens } : {}),
    costBasis: settled + unreconciled === 0 ? "none" : unpriced ? "none" : bound ? "upper_bound" : measured ? "measured" : "none",
    settled,
    refused: refusedEntries.length,
    ...(lastRefusal ? { lastRefusal } : {}),
  };
}

/** Run one Maestro pass inside the ledger's scope and account what it cost. */
export async function accountPass<T>(ledger: TaskBudgetLedger, fn: () => Promise<T>, gate?: Pick<MirandaGate, "beforeLLMCall">): Promise<{ result: T; accounting: PassAccounting }> {
  const before = ledger.snapshot();
  const beforeCount = ledger.history().length;
  try {
    const result = await runWithBudget(ledger, () => (gate ? withBudgetAttribution({ gate }, fn) : fn()));
    return { result, accounting: accountingBetween(ledger, before, beforeCount) };
  } catch (error) {
    // The pass failed; its accounting still exists for the trace and the ledger.
    (error as { passAccounting?: PassAccounting }).passAccounting = accountingBetween(ledger, before, beforeCount);
    throw error;
  }
}

/** Write a pass's accounting into the Maestro result's metadata. */
export function withPassAccounting(result: OrcaMaestroResult, accounting: PassAccounting): OrcaMaestroResult {
  const { settled: _s, refused: _r, lastRefusal: _l, ...metadata } = accounting;
  return { ...result, metadata: { ...(result.metadata ?? {}), ...metadata } };
}

/**
 * Why the task must not spend any more, or undefined when it may. A hard
 * budget stops when the ledger is blocked (unreconciled charge, overrun,
 * cancellation), when nothing remains, or when the last pass could not get a
 * single request through.
 */
export function budgetStopReason(ledger: TaskBudgetLedger | undefined, lastPass?: PassAccounting): string | undefined {
  if (!ledger?.hardBudget) return undefined;
  const s = ledger.snapshot();
  if (s.blocked) return s.blocked.reason;
  if (s.remainingUsd !== null && s.remainingUsd <= 0) return `the task budget of $${s.limitUsd!.toFixed(2)} is used up ($${s.accountedUsd.toFixed(4)} accounted, $${s.reservedUsd.toFixed(4)} reserved)`;
  if (lastPass && lastPass.refused > 0 && lastPass.settled === 0) return lastPass.lastRefusal ?? "every model request of the last pass was refused by the budget";
  return undefined;
}

export function formatBudgetStop(reason: string, snapshot: BudgetSnapshot): string {
  return `Stopped by the task budget: ${reason}. Accounted $${snapshot.accountedUsd.toFixed(4)} of $${(snapshot.limitUsd ?? 0).toFixed(2)} (confirmed $${snapshot.spentUsd.toFixed(4)}, unreconciled $${snapshot.unreconciledUsd.toFixed(4)}). The work is incomplete and was not verified.`;
}

/**
 * Miranda's before_llm_call budget fields from the task ledger: what is
 * accounted plus what is reserved, against the hard limit (Infinity when none).
 * Replaces the neutral `budgetUsed: 0 / budgetLimit: Infinity` placeholders.
 */
export function budgetGateContext(ctx: { budget?: TaskBudgetLedger }): { budgetUsed: number; budgetLimit: number } {
  const s = ctx.budget?.snapshot();
  if (!s) return { budgetUsed: 0, budgetLimit: Infinity };
  return { budgetUsed: s.accountedUsd + s.reservedUsd, budgetLimit: s.limitUsd ?? Infinity };
}
