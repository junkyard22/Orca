import { TaskBudgetLedger } from "@clawde/miranda-core";
import type { BudgetSnapshot, CustomModelPrice } from "@clawde/miranda-core";
import type { OrcaSettings } from "./settings";

/**
 * Desktop budget context.
 *
 * - The *session ledger* accounts every model request this process makes,
 *   with no limit: utility calls made outside a user message (the narrator
 *   lexicon at start-up) land here, and every message ledger mirrors its
 *   costs into it, so the status bar can show what the session has spent.
 * - A *message ledger* is created per user message with the configured task
 *   budget as its hard limit. The runtime reuses it for the task, so Claire's
 *   narration, Brain, workers, fallbacks, repairs and Cargo summaries all draw
 *   on one budget.
 *
 * Custom prices come from Settings and are read by every adapter at request
 * time, so changing them needs no re-initialisation.
 */

let sessionLedger: TaskBudgetLedger | undefined;
let customPrices: readonly CustomModelPrice[] = [];
let messageCounter = 0;

export function getSessionBudget(): TaskBudgetLedger {
  if (!sessionLedger) sessionLedger = new TaskBudgetLedger({ taskId: "session", limitUsd: null, limitSource: "session" });
  return sessionLedger;
}

/** Test hook: start a fresh session ledger. */
export function resetSessionBudget(): void {
  sessionLedger = undefined;
}

export function setCustomPrices(prices: readonly CustomModelPrice[] | undefined): void {
  customPrices = Array.isArray(prices) ? prices.filter(isValidCustomPrice) : [];
}

export function getCustomPrices(): readonly CustomModelPrice[] {
  return customPrices;
}

export function isValidCustomPrice(p: unknown): p is CustomModelPrice {
  if (!p || typeof p !== "object") return false;
  const c = p as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return typeof c["model"] === "string" && c["model"].length > 0 && num(c["inputPer1M"]) && num(c["outputPer1M"])
    && (c["cacheReadPer1M"] === undefined || num(c["cacheReadPer1M"]))
    && (c["maxOutputTokens"] === undefined || (typeof c["maxOutputTokens"] === "number" && Number.isSafeInteger(c["maxOutputTokens"]) && c["maxOutputTokens"] > 0));
}

/** The hard budget a message runs under: the configured amount, or none when 0. */
export function messageBudgetLimit(settings: Pick<OrcaSettings, "budgetUsd">): number | null {
  const v = Number(settings.budgetUsd);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Create the ledger for one user message. */
export function createMessageBudget(settings: Pick<OrcaSettings, "budgetUsd" | "budgetSource">): TaskBudgetLedger {
  messageCounter++;
  return new TaskBudgetLedger({
    taskId: `message-${Date.now().toString(36)}-${messageCounter}`,
    limitUsd: messageBudgetLimit(settings),
    limitSource: settings.budgetSource ?? "user",
    customPrices,
    parent: getSessionBudget(),
  });
}

/**
 * Start-up guidance about the configured budget: a historical default that
 * was never chosen, or no hard limit at all. Never changes the value.
 */
export function budgetWarnings(settings: Pick<OrcaSettings, "budgetUsd" | "budgetSource">): string[] {
  const limit = messageBudgetLimit(settings);
  if (limit === null) {
    return ["No hard task budget is set (0): model spending is tracked and shown but not limited. Set a per-task budget in Settings to have requests refused before they exceed it."];
  }
  if (settings.budgetSource === "legacy_default") {
    return [`The task budget is the historical default of $${limit.toFixed(2)} per task, which was never explicitly chosen. It is enforced: a single request on a frontier model can exceed it and will be refused before it is sent. Set the budget you intend in Settings → General (0 disables the hard limit).`];
  }
  return [];
}

/** One line for the status bar. */
export function formatBudgetStatus(s: BudgetSnapshot): string {
  const confirmed = `$${s.spentUsd.toFixed(4)}`;
  const parts: string[] = [];
  if (s.limitUsd !== null) parts.push(`${confirmed} of $${s.limitUsd.toFixed(2)}`);
  else parts.push(`${confirmed} spent (no hard limit)`);
  if (s.unreconciledUsd > 0) parts.push(`+ $${s.unreconciledUsd.toFixed(4)} unreconciled`);
  if (s.reservedUsd > 0) parts.push(`$${s.reservedUsd.toFixed(4)} reserved`);
  if (s.unpricedRequests > 0) parts.push(`${s.unpricedRequests} request${s.unpricedRequests === 1 ? "" : "s"} unpriced`);
  return parts.join(" · ");
}
