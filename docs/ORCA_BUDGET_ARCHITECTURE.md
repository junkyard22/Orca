# Orca budget architecture (core reliability, phase 4)

**Status:** implemented on `integration/core-reliability` (2026-10-12). Not merged. Prices reviewed 2026-10-12; see "Pricing".

A budget that isn't enforced isn't a budget. A budget so restrictive that ordinary work cannot run isn't useful.

## What was wrong in production

- `metadata.costUsd` had no producer: the desktop agents, Brain routing, synthesis, narrator and Cargo summaries discarded the provider's `usage`; the runner's adapter discarded `OrcaLLMResult.usage`. The runtime's and repair loop's "budget cap reached" checks summed zeros and could never fire.
- Miranda's `before_llm_call` received `budgetUsed: 0, budgetLimit: Infinity` from hard-coded placeholders (`agent-loop-core`, runner adapter) or `budgetUsed: 0` from the desktop gate helper, so `used >= limit` was always false.
- The only check ran *after* a pass completed; nothing reserved or refused before a request was sent; parallel workers had no shared accounting.
- The $0.10 default lived in `settings.ts` without provenance, labelled "Budget per request" in the UI, and could not be set to 0 ("no limit") from the UI although the runtime documented that meaning.
- Unknown models were priced at an invented $1/$2 per million (`miranda-core/metrics/costs.ts`); the persisted `cost_usd` was always null; the renderer's cost pill waited for an event nothing emitted.

## Semantics

| Term | Meaning | Enforced? |
|---|---|---|
| **Per-task budget** (`budgetUsd`, Settings "Budget per task") | Hard limit on everything one user message asks a model: Claire's narration, Brain, workers (parallel included), fallbacks, repairs, Cargo summaries. `0` = no hard limit. | **Yes** — every request is reserved against the task ledger before dispatch; a request the remaining budget cannot cover is refused before any network activity. |
| **Per-request bound** | The reservation: input byte-bound × input price + `maxTokens` × output price, 10 % margin, capped by the model's documented limits. Not a user setting. | Yes — it is what the reservation commits; a response exceeding it is recorded at its true cost and stops the task. |
| **Session accounting** | Everything the process spent across messages, plus start-up utility calls made outside any message. | No — informational (status bar). Orca has no account-level product setting, so none was invented. |

A configured limit never silently becomes unlimited: unknown prices, stale prices, unbounded requests, unreported usage and overruns all *stop* a hard-budget task with a reason, they never let it through.

### Six numbers, kept apart

| Number | Source |
|---|---|
| estimated cost | `ledger.decide()` before dispatch (upper bound; "cost estimate unavailable" when unpriced) |
| reserved | sum of open reservations (requests in flight) |
| actual usage | the provider's `usage` object (prompt, completion, cached prompt tokens) — never chunk counts, never assumed zero |
| reconciled cost (`spentUsd`) | measured usage × reviewed or custom price, cached tokens at the cache-read rate |
| unreconciled (`unreconciledUsd`) | upper bounds of requests sent whose outcome is unknown: no usage, failure or cancellation after dispatch |
| remaining | limit − spent − unreconciled − reserved |

`costBasis` says what the figures rest on: `measured`, `upper_bound`, or `none` (unpriced).

## Architecture

```
miranda-core/src/budget/
  pricing.ts        reviewed catalog (Anthropic API, dated, sourced) · custom prices · local inference · stale/unknown
  tokenBound.ts     input token upper bound from the request's UTF-8 bytes (+ framing, +10 %)
  ledger.ts         TaskBudgetLedger: decide / reserve (atomic, sync) / settle / markUnreconciled / release / snapshot
  budgetedAdapter.ts wraps any LLMAdapter; AsyncLocalStorage scope (runWithBudget) + attribution (role, stage, gate)
miranda-core gate   LLMCallGateContext.budget: BudgetDecision → BLOCK on any refusal kind
orca-core
  runtime.ts        one ledger per task (or the shell's message ledger); passes run inside the scope; per-pass accounting into metadata; budget stop → FAIL with reason; budget:update events; trace; journal
  repairLoop.ts     stops before a repair the ledger cannot fund; stops a pass that made no request
  budget/journal.ts in-flight snapshots on disk → reported on next start
  persistence       runs.cost_usd (reconciled), cost_unreconciled_usd, cost_basis
apps/desktop
  providerAdapter   every adapter (Brain, roles, fallbacks) is budgeted; session ledger as fallback
  budgetContext     session ledger, message ledger from Settings, custom prices, warnings
  main.ts           message scope around handleUserMessage; journal recovery warnings; budget:update to the renderer; snapshot in the reply
  llmGate           Miranda fields from the ledger; role attribution
apps/runner         ORCA_BUDGET_USD env → hard budget; adapters budgeted
```

### Reservation (before dispatch)

For every BPE tokenizer Orca's providers use, no token covers less than one byte, so `input tokens ≤ UTF-8 bytes of the request`. The bound adds 32 tokens per message and 512 per request for framing, multiplies by 1.1, and caps at the model's documented input limit. Output is bounded by the request's `maxTokens`; reasoning/thinking tokens are billed as output within that limit on Anthropic, OpenAI and DashScope. Reservation = bound × input rate + `maxTokens` × output rate (tiered models use the tariff the bound falls in).

Refusals (hard budget only): `refused_limit` (reservation > remaining), `refused_pricing_unknown` (unknown or stale price), `refused_invalid_request` (no `maxTokens`, `maxTokens` above the documented output limit, non-text content), `refused_unreconciled` (the ledger is blocked by an earlier unreconciled charge or overrun). Each reason names the figures and the fix (raise the budget, cheaper model, custom price, lower max tokens).

### Settlement (after the response)

Usage must be present and consistent (`total = prompt + completion`). Cost = (prompt − cached) × input + cached × cache-read + completion × output. The reservation is released and the measured cost recorded. If the cost exceeds the reservation (the bound was wrong), it is recorded at its true value and the task is blocked. No usage → the reservation's upper bound is charged as *unreconciled* and the task is blocked; the same for a failure or cancellation after dispatch. A cancellation *before* dispatch releases the reservation unchanged. A different `model` in the response is noted; the requested model's rate applies.

### Concurrency

`reserve()` is synchronous and reads the same ledger every caller writes, so two workers reserving "at the same time" are serialised by the event loop: the second sees the first's reservation. Parallel execution is preserved (the brief's example: $3 budget, Brain $0.40, two workers at $1.50 → one worker admitted, one refused before dispatch, total never above $3). Repairs and fallbacks reserve against the same remaining budget; `byRole` / `byProvider` attribute every request.

### Miranda and Maestro

The budgeted adapter previews the decision and passes it through `before_llm_call` at stage `budget:<caller stage>` with `budgetUsed = accounted + reserved` and `budgetLimit`. Miranda distinguishes `authorized`, `no_hard_budget`, `refused_limit`, `refused_pricing_unknown`, `refused_unreconciled`, `refused_invalid_request`. The callers' own gate calls now carry the ledger's real figures instead of placeholders. Maestro never switches models to dodge a refusal (model selection is unchanged); Pappy's requirements are untouched; a budget stop returns `FAIL` with `Stopped by the task budget: … The work is incomplete and was not verified.` and skips repairs; a repair pass that could not make a single request stops before QC.

### Pricing

`ANTHROPIC_PRICES` (reviewed **2026-10-12** against platform.claude.com pricing and models pages): Fable 5.1 $10/$50, Fable 5 $10/$50, Opus 5.5 $4/$20, Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 $5/$25, Sonnet 5.5 $2/$10, Sonnet 5 $2/$10, Sonnet 4.6 / 4.5 $3/$15, Haiku 5.5 $0.10/$0.50 up to 100k prompt tokens and $0.50/$2.50 above, Haiku 4.5 $1/$5; cache reads at 0.1× (0.05× Opus/Sonnet 5.5, 0.025× Fable 5.1); 1M context / 128K output on the 4.6+ lineup. Applies only to Anthropic's own endpoint. Rows older than `PRICE_MAX_AGE_DAYS` (120) are `stale`: usable for an estimate, refused under a hard budget, with the review date in the message. No expiry date bricks the app.

Every other provider/model is **unknown** until the user sets a custom price in Settings (JSON, per provider id and model). OpenAI's pricing page and OpenRouter's model-list docs could not be fetched during this phase, so no rate was copied from memory. Local inference (Ollama, loopback or private-network endpoints): $0 external charge, allowed under a hard budget, labelled "electricity, hardware and hosting costs are not accounted".

Recommended refresh process (not implemented): a script that pulls OpenRouter's `/api/v1/models` (which publishes per-model prices) and Anthropic's Models API (`max_input_tokens`, `max_tokens`) into a dated JSON catalog checked into the repo, with the human-reviewed Anthropic *rates* kept as the only hand-maintained table; the app would then warn when the catalog file is older than the allowed age instead of needing source edits.

### Legacy budget migration

A settings file that records `budgetSource` is taken at its word. An older file holding exactly $0.10 (or no budget) is a generated default, not a choice: it is kept **and enforced**, labelled `legacy_default`, surfaced at start-up ("historical default … never explicitly chosen … a single request on a frontier model can exceed it"), and shown in Settings. Any other stored value is the user's. Saving Settings records `budgetSource: "user"`. Nothing is raised, removed or turned into infinity silently; `0` is a deliberate "no hard limit".

### Restart recovery

The runtime writes each task's snapshot to `budget-journal.json` on every change and removes it when the task ends. On the next start, tasks still listed had requests in flight when the process died; the app warns with the exposure (reserved + unreconciled upper bounds) and the task id.

### Visibility

Status bar: `$spent of $limit confirmed · $x unreconciled · $y reserved · n unpriced · stopped by budget`. Pipeline badge rows: task budget (and whether it is the historical default), spent (confirmed) with tokens, unreconciled, reserved, remaining, unpriced requests, by role, by provider, budget stop reason. Figures are confirmed unless labelled; nothing claims a promotional-credit balance (not available from any supported API); credits do not make usage free.

## Worked examples ($3 task budget)

Verified Anthropic rates (2026-10-12); token counts are illustrative.

**One ordinary task on Opus 5.5.** Brain route: 6 KB prompt → bound ≈ 7.2k tokens × $4/M + 512 max output × $20/M = **$0.039 reserved**; measured 1.6k in / 120 out → **$0.0088 settled**. Worker iteration 1: 40 KB prompt → bound ≈ 44.6k × $4/M + 8,192 × $20/M = **$0.34 reserved**; measured 10k / 900 → **$0.058 settled**. Five more iterations at growing context settle around $0.06–$0.10 each. End: ≈ **$0.45 confirmed, $2.55 remaining**, no reservations open.

**Pappy rejects, one repair.** Repair pass reserves like the worker ($0.34), settles $0.09. Total ≈ $0.54. Remaining $2.46. Repair never gets a fresh budget.

**Two parallel workers near the limit.** Remaining $0.60 after Brain. Worker A reserves $0.34 (ok, remaining $0.26); Worker B needs $0.34 → **refused before dispatch**: "reserving $0.3400 … would exceed the remaining task budget of $0.2600 … raise the task budget in Settings or use a cheaper model/shorter prompt". A settles at $0.06, releasing $0.28; the task reports FAIL for B's branch with that reason; nothing was charged for B.

**Provider returns no usage.** A 2 MB-context Sonnet 5.5 stream whose provider dropped the usage chunk: reservation (≈ $4.6 input bound… exceeds $3, so it is refused up front on a $3 budget). On a $10 budget it would be sent; with no usage it is charged $4.6 as *unreconciled* and the task stops: "the provider reported no usage for a request that was sent … no further paid requests are made in this task".

**Legacy $0.10 default.** Opus 5.5 worker reservation $0.34 > $0.10 → refused before dispatch with the reason; Haiku 5.5 (short prompt: 7.2k × $0.10/M + 4,096 × $0.50/M ≈ **$0.003**) runs. The start-up warning says why and where to change it.

## Limitations (unresolved spending risks)

- Reservation is an upper bound only where the provider honours `max_tokens` and reports usage; a provider that ignores `max_tokens` or bills tokens Orca cannot see (server-side tools, web search) can exceed it. Such overruns are recorded honestly and stop the task; they are not prevented.
- Prices are known only for Anthropic's own API; every other model needs a custom price under a hard budget. Stale catalog rows refuse rather than guess.
- The in-process ledger does not span processes; two Orca instances share nothing (the desktop runs one task at a time; the journal only reports, it does not enforce across restarts).
- Streamed requests to an endpoint that rejects `stream_options` return no usage and stop a hard-budget task after the first such request (the task is told why); switching that role to non-streaming is the current workaround.
- Cache-write pricing is not modelled (Orca does not create caches explicitly); cache reads are.
- Local inference is $0 external; its real cost is unknown and shown as such.

## Phase 5 hardening (2026-10-12)

### Cache writes (§10)

`TokenUsage.cacheCreationTokens` is parsed from `prompt_tokens_details.cache_creation_tokens` or Anthropic's `cache_creation_input_tokens` when a gateway passes it through (`cache_read_input_tokens` feeds `cachedPromptTokens`). Settlement prices written tokens at the catalog's cache-write rate (Anthropic: 5-minute write, reviewed 2026-10-12 — Opus 5.5 $5/M, Sonnet 5.5 $2.50/M, Haiku 5.5 $0.125/M …), read tokens at the cache-read rate, the rest at the base rate. For a custom-priced model with cache writes and no `cacheWritePer1M`, the write is priced at the base rate, the entry's `costBasis` becomes `estimate` with a note, and a hard budget **stops** (`refused_pricing_unknown`) because the true charge is known to be higher; without a hard budget it is recorded and annotated. Reservations do not add a cache-write allowance: Orca never requests caching itself, and a provider that caches on its own bills the write within the prompt tokens the reservation already bounds at the base rate — the settlement flag above is what catches the difference. Orca's OpenAI-compatible transports cannot *see* Anthropic cache writes unless the gateway forwards the field; that is a reporting limitation of the chat-completions surface, documented here, not a pricing guess.

### Billing is not location (§11)

`ProviderEntry.billing` (`local` / `metered` / `unknown`, Settings → provider "Billing"). Ollama defaults to `local`; every other endpoint — including one on `localhost` or a private network — defaults to `unknown` and is **unpriced under a hard budget** until the user classifies it as `local` or gives it a custom price (`metered`). A local proxy that forwards to Anthropic or OpenRouter is therefore never treated as free by accident. Existing configurations are not modified: an unclassified custom endpoint that used to count as free now refuses under a hard budget with a message naming the two fixes; without a hard budget it runs and is labelled unpriced.

### Streaming and cancellation (§12)

Outcomes the ledger keeps apart, all exercised through the real `OpenAICompatAdapter` with recorded responses: never dispatched (released, nothing charged); dispatched then cancelled (upper bound charged as unreconciled, hard budget stops); completed with measured usage (settled); completed without usable usage — stream without the usage chunk, inconsistent counts, an endpoint that rejected `stream_options` (unreconciled, hard budget stops); failed after generation began (unreconciled). A late usage report cannot reconcile a request already marked unreconciled. Cancellation never releases a reservation that may have reached the provider.

### Legacy $0.10 (§13)

The start-up warning, the Settings note and now the **refusal message** all say the same thing: the limit is Orca's historical default, never explicitly chosen, enforced as is, and changed in Settings → General (0 disables the hard limit). The execution ledger carries `limitSource` so the refusal wording matches the setting's provenance; a user-set limit gets the ordinary "raise the budget or use a cheaper model" guidance.
