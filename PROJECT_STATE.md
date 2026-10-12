# Orca — Project State

> **Update this file at the end of every development session** (rules in
> [CLAUDE.md](CLAUDE.md#project-state)). Record only what you verified yourself —
> in the code, in git, or by running tests. Anything reported but not verified
> goes under **Unverified**, with who reported it.

**Last updated:** 2026-10-12 (core reliability, phase 4) · **Machine:** dev desktop · **By:** Claude Code session

---

## Where the work lives

| Branch | Where | Head | Pushed? | Status |
|---|---|---|---|---|
| `main` | origin | `7b62cce` | yes | Production baseline. Carries the shared-component defects listed in the audit (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`). Local `main` in `C:\Orca\Orca` is 10 commits behind. |
| **`integration/core-reliability`** | dev desktop worktree `C:\Orca\worktrees\core-reliability` | this commit | **no** | **Source-only production integration branch, from `origin/main`.** Phases 0 (docs), 1 (core security), 2 (Pappy verification integrity), 3 (provider compatibility), 2.5 (behavioural verification, evidence integrity, Moonshiner training safety) and 4 (budget enforcement) done; none approved for merge. No Demo Mode code. |
| `integration/1.6.1-clean` | dev desktop worktree `C:\Orca\worktrees\integration-1.6.1-clean` | `4191c00` + uncommitted `PROJECT_STATE.md` edit and untracked `ORCA-CORE-RELIABILITY-AUDIT.md` (the audit's original copy) | no | Summit 1.6.1 line (Demo Mode, staging build). Reference for later phases; not merged. |
| `fix/live-rehearsal-remediation-1.6.1` | origin (to `58e447e`); worktree `C:\Orca\worktrees\remediation-1.6.1` | `28125ee` | local commits not pushed | Contains the 774 MB build archive. **Never merge.** |
| `wip/live-demo-verification-parallel` | dev desktop | `43edfda` | no | Snapshot of the unreviewed 10/7 parallel verification work (see `docs/ORCA_PARALLEL_WORK_COMPARISON.md`). Reference only. |
| `fix/live-demo-verification` | `C:\Orca\Orca` main checkout | `1e87212` + 27 uncommitted files | no | Original location of the parallel work; untouched. |
| `feature/summit-demo-mode` | dev desktop | `1e87212` | no | Original Summit line; superseded by 1.6.1. |
| *(no branch)* `C:\Orca\worktrees\audit-main` | detached at `7b62cce` | — | — | Built copy of `origin/main` used by the audit to execute production code. Safe to remove. |

Staging build (Summit): `C:\Orca\worktrees\integration-1.6.1-clean\apps\desktop\release\Orca-Summit-Staging-1.6.1\` from `385be88`; see that branch's `PROJECT_STATE.md`.

---

## Implemented and verified (2026-10-09, code + tests, this branch)

### Phase 1 — core security

| Commit | Fix | Verified by |
|---|---|---|
| `e3dd9c6` | Miranda classifies connector mutations by verb (`classifyToolVerb`): `push_files`, `add_issue_comment`, `fork_repository`, `star_repository`, `add_sub_issue`, `assign_copilot_to_issue`, `run_workflow`, `set_config_value` are writes; `get_tag`, `get_label`, `get_latest_release`, `get_workflow_run`, hyphenated reads stay reads; workspace boundary now checks `paths`, `files[].path`, `source`/`src`, `dest` | `mirandaGate.test.ts` (72 incl. 8 new) |
| `99c9818` | Execution-time authorization in front of every desktop `tool.execute` (worker tools, runtime tool service, Cargo pre-flight): external writes / process control / unknown tools need per-call user approval via the existing dialog; sandbox reconfiguration denied; local paths outside the workspace denied; refusals are `ok:false` results with an `authorization` reason. Runtime tool-service path now carries the approval handler. | `toolAuthorization.test.ts` (60 new: original bypasses, preserved reads, server-id prefix, denial/timeout/throwing approver, real `run_command` behind the guard) |
| `883739c` | Docs: audit report, parallel-work comparison, PROJECT_STATE rule in CLAUDE.md | — |

Not included (by design): Demo Mode strict mode, the native presenter-approval dialog, run-stop-on-timeout, budget ledger.

### Phase 2 — Pappy verification integrity (design: `docs/ORCA_VERIFICATION_EVIDENCE.md`)

| Area | Change | Verified by |
|---|---|---|
| `orca-core/src/workspaceEvidence.ts` (+ runtime, repairLoop, helpers, types, index) | Runtime captures a hash inventory of the workspace at task start (git-enumerated, bounded), fingerprints the non-test source synchronously whenever a test command's result is observed, and hands Pappy `workspace` evidence (real changes with test/config contents, host-observed test runs with `sourceState`) plus `priorToolEvents` across repair passes | `workspaceEvidence.test.ts` (9), runtime wiring tests |
| `pappy-core/src/checks/workspaceVerification.ts` | Task-aware checks (bugfix / refactor / feature / docs / inspect): real source change, tests intact (`TEST_FILE_DELETED`, `TEST_FILES_MODIFIED_WEAKENED`, `TEST_EDIT_PROHIBITED`), full-suite receipt on the final source with parsed counts and exit code, reproduction when the user asked for verification; insufficient evidence is HIGH and worded "Not verified (insufficient evidence)", contradictions are worded as failures | `workspaceVerification.test.ts` (39: Summit scenarios A–L, adversarial M–T, task kinds, helpers) |
| `pappy-core/src/pappy.ts` ledger | Receipt `strength` (direct / independent / corroborated / self_reported / none); with runtime evidence a required criterion backed only by the worker's account becomes `UNVERIFIED` → `REQUIRED_EVIDENCE_INSUFFICIENT` (HIGH); "File must be" and named-file criteria need the file to differ on disk; a successful tool call no longer corroborates unrelated claims | same |
| `pappy-core/src/pappy.ts` result | `verification` (status, taskKind, reasons, testEvidence) separate from the verdict; `confidenceBasis: "heuristic"`; verdict rules unchanged | same + 340 pre-existing Pappy tests |
| `pappy-core/src/pappy.ts` eligibility | Evidence-integrity gate: no host evidence → never eligible (legacy callers included); PASS eligible only when verified with a host-recorded test run; contradicted evidence + success claim → rejected; insufficient evidence → review | same; 2 legacy orca-core assertions updated |
| loops (`agent-loop-core`, `ReactAgentAdapter`), `workbench-core` | Failed command output kept as proof (64 KB cap), `exitCode` on results and `_exitCodeForProof` | existing suites |
| desktop renderer, runner tracer | No fabricated confidence values; Pappy's score shown as "score N% (heuristic)" only when Pappy ran | desktop suite, `node --check` |

Adversarial before/after (real Pappy, 20 synthetic cases with runtime evidence; `%TEMP%\orca-audit\phase2-compare.mjs`): should-reject n=15 — false acceptances **7 → 0**; should-accept n=5 — false rejections **1 → 0**. Eval corpus (no workspace evidence by construction): reference 23/23, raw 11/23 (was 14 — three evidence-less runs are no longer training-eligible), hardened 14/23; cheat catch 100 %, false accept 0 %, false reject 57.1 % on all three, unchanged.

### Phase 3 — provider compatibility (+ phase 2 follow-ups)

| Area | Change | Verified by |
|---|---|---|
| `miranda-core/src/llm/samplingPolicy.ts` (new) | Adapter-layer request policy: Anthropic endpoints (by type or `api.anthropic.com` host) receive `temperature` only for Claude generations ≤ 4.6 and never the nonstandard `enable_thinking`; every other provider unchanged. Never changes which model a role uses. | `providerPolicy.test.ts` |
| `miranda-core/src/llm/modelCatalog.ts` (new) | Documented current Anthropic IDs (reviewed 2026-09-25) + legacy pattern; advisory only (`anthropicModelIdStatus`), never blocks a configured ID | same |
| `miranda-core/src/llm/errors.ts` (new) | `ProviderRequestError`: provider, model, status, the provider's own message and a hint (auth / unknown model / rejected sampling field / thinking field / limits / rate limit / 5xx); keys never included | same + `openaiCompat.test.ts` |
| `miranda-core/src/llm/openaiCompat.ts`, `ollama.ts`, `usage.ts` | `supportsTemperature`, `supportsEnableThinking`, `providerName` config; structured errors; invalid/non-JSON bodies are errors; a final SSE line without a newline is processed; streamed usage is no longer fabricated from chunk counts (null when unknown); usage objects with inconsistent counts are null | `openaiCompat.test.ts` (+17), existing Ollama tests |
| `orca-core/src/adapters/directLLM.ts`, `types.ts` (`OrcaLLMResult`) | Provider usage, model and timing pass through to callers | `directLLM.test.ts` (new) |
| `apps/desktop/src/providerAdapter.ts` (new), `providerResolution.ts` (new), `main.ts` | One place builds every role's adapter with the policy applied; roles are resolved by stable id and every role whose provider is missing, keyless or whose Anthropic model ID is unrecognised is named in the init warnings (nothing reassigned); Brain blocker messages name the stale id; `models:fetch` offline fallback uses the catalog | `providerAdapter.test.ts` (new, request bodies for Anthropic / OpenRouter / OpenAI / DashScope / custom / Ollama), `providerResolution.test.ts` (new), `settingsPersistence.test.ts` (new) |
| `apps/desktop/renderer/provider-options.js` (new), `app.js`, `index.html` | Role `<select>` shows "⚠ provider missing" for a stale id instead of the first provider; the configured providers stay available to reassign | `providerOptions.test.ts` |
| `apps/runner/src/index.ts` | Settings-based providers get the same request policy (adapter config only; no output change) | runner suite |
| `packages/pappy-eval/src/evidence/*` (new), `pnpm pappy:eval:evidence` | Supplementary evidence-bearing corpus: 26 fixtures with runtime evidence (debugging 10, feature 4, refactoring 4, documentation 3, inspection 2, evidence availability 3), separate FA / FR / status / eligibility metrics, known-gap list (`docs/ORCA_EVIDENCE_CORPUS.md`). Original 23-case corpus and its expectations untouched. | `evidence.test.ts` |

Follow-up A (investigation only, no Pappy change): confirmed gaps — (1) a bug fix, feature or refactor in a project without a test command is labelled `verified` on the strength of the on-disk change alone (PASS, not trainable); (2) a required criterion that is `PARTIAL` stays MEDIUM → WARN when runtime evidence exists; (3) the named-file receipt for documentation proves the file changed, not that its content satisfies the request. Git inventory: untracked new files are captured (`--others --exclude-standard`), deletions and renames (as delete + add) are seen, pre-existing uncommitted edits form the baseline rather than being attributed to the task; ignored paths (`build/`, `*.log`) are excluded by design. **All three gaps are closed by phase 2.5 below.**

### Phase 2.5 — behavioural verification, evidence integrity, Moonshiner training safety (2026-10-12; design: `docs/ORCA_VERIFICATION_EVIDENCE.md`)

Principle: Pappy establishes what the evidence proves. A confirmed file change proves a file changed, not that a bug is fixed, a feature works or a refactor preserved behaviour.

| Area | Change | Verified by |
|---|---|---|
| `pappy-core/src/checks/workspaceVerification.ts` | Task-aware **behavioural receipts** on the final source: `reproduction`, `regression_test`, `full_suite`, `validation_command` (an "Alternative verification: / Verified by:" line naming a command that ran after the last change, exit 0, output about the request), `build_check` (refactor without tests, LOW `REFACTOR_RUNTIME_EQUIVALENCE_NOT_SHOWN`), `final_content` (docs). New HIGH insufficient-evidence codes `FIX_/FEATURE_/REFACTOR_BEHAVIOUR_EVIDENCE_MISSING`, `DOCS_CONTENT_MISSING`, `DOCS_CONTENT_UNREADABLE`; a feature needs something that exercises it, not just a passing suite; a modification during an inspection is `contradicted` (HIGH); "do not modify the tests" no longer counts as a request for a test run; `=>` in a quoted script is not a shell redirect | `workspaceVerification.test.ts` (49: Summit A–L, adversarial, task kinds, phase 2.5 block) |
| `pappy-core/src/checks/evidenceTerms.ts` (new) | Ties a receipt to a requirement by the identifiers and distinctive words it names; file names never count | same, `evidence.test.ts` |
| `pappy-core/src/pappy.ts` ledger | Every required criterion carries an **assessment** (requires / satisfiedBy / supportedBy / sufficient / contradictedBy / needed); a code-behaviour criterion is PROVED only with implementation on disk **and** a relevant receipt, else PARTIAL; PARTIAL is **HIGH** with workspace evidence (MEDIUM for legacy callers); a document criterion needs the criterion's terms in the final content; unsupported claims keep the status `unverified`; evidence-proved goals supersede `COMPLETENESS_GOAL_COVERAGE` / `COMPLETENESS_MISSING_DOMAIN_TERMS` | same + 340 pre-existing Pappy tests |
| `pappy-core/src/pappy.ts` eligibility | Contradicted evidence excludes a run **by default**: only an account that acknowledges the failure and does not present the work as done stays eligible; acknowledges + claims → review; silent/empty → review; claims → rejected. No keyword list decides inclusion. | same |
| `pappy-core/src/pappy.ts` `evidenceRequests` | Per unmet requirement: confirmed / missing / action (descriptive; no command, receipt or repair is initiated); recorded in the `qc.run.result` trace | same, runtime trace |
| `pappy-core/src/checks/completeness.ts` | Root causes of the keyword false rejections fixed: backticks stripped from goal terms; stems drop a doubled consonant; identifier-anchored goals covered by their symbols; concept mapping no longer matches by bare substring ("one" ⊂ "component") | `completeness.test.ts`, original corpus |
| `pappy-core/src/checks/claimProof.ts` | "I ran X" is proved by the recorded command whatever its exit status; "7 of 8 tests pass" is a partial count proved by a run reporting it, not a tests-pass claim | `claimProof.test.ts`, corpus |
| `orca-core/src/adapters/pappyPort.ts`, `export/exportTrainingData.ts` | Persisted summary carries `evidence=<status>` and `test_evidence=`; the export requires `training_eligibility=eligible` **and** `evidence=verified|contradicted`, skips untagged/legacy/"ok" rows (`missing`, `evidence_tag_missing`) and any evidence that was unavailable, absent, insufficient or unreadable; honest failures stay out of the default PASS export | `exportTrainingData.test.ts` (+4) |
| `orca-core/src/index.ts`, `apps/desktop/src/verificationGuidance.ts` (new), `main.ts` | Worker goals state the evidence Pappy will require per task kind (reproduce / rerun / "Alternative verification:" / test with assertions / build check / write the content); goals only, criteria and AHP packets unchanged | `verificationGuidance.test.ts` (new), desktop suite |
| `orca-core/src/workspaceEvidence.test.ts` | Multi-pass capture: a repair pass sees the first pass's receipts, both passes' changes, the failed run's output and exit code; final vs intermediate runs; renames as delete + add; pre-existing edits as baseline | +3 tests |
| `pappy-eval/src/evidence/*` | Corpus 26 → **45 fixtures** covering every phase 2.5 scenario; known-gap registry emptied by fixing causes; one deliberate relabel recorded (`feature-insufficient-unexercised`, the former `feature-genuine` input) | `evidence.test.ts` |

Same-corpus before/after (45 fixtures, `%TEMP%\orca-audit\phase25\before-after-45.txt`; phase 3 Pappy built from `96bacc6`): false acceptances **3/33 → 0/33**; false rejections **7/11 → 0/11** (legitimate acceptance 4/11 → 11/11); evidence-status accuracy **86.7 % → 100 %**; eligibility accuracy **73.3 % → 100 %**. Original corpus (expectations unchanged): default 23/23 → 23/23, raw **11/23 → 12/23**, hardened **14/23 → 15/23**; cheat catch 100 % and false accept 0 % throughout (`accepted_but_not_trainable-002` no longer falsely rejected). Runtime overhead unchanged: no new workspace rescans; this repo (423 files) baseline 184 ms · stat refresh 76 ms · fingerprint 73 ms · collect 70 ms; Pappy evaluation 0.6 ms per run. Small deterministic corpora — behaviour on named cases, not calibrated rates.

### Phase 4 — budget enforcement, cost accounting, provider-aware spending (2026-10-12; design: `docs/ORCA_BUDGET_ARCHITECTURE.md`)

Root causes on `main`: `metadata.costUsd` had no producer (every caller discarded provider usage), Miranda's `before_llm_call` got `0 / Infinity` placeholders, the only check ran after a pass, parallel workers shared nothing, the $0.10 default had no provenance and was labelled "per request", unknown models were priced at an invented rate.

| Area | Change | Verified by |
|---|---|---|
| `miranda-core/src/budget/` (new: `pricing.ts`, `tokenBound.ts`, `ledger.ts`, `budgetedAdapter.ts`) | Provider-independent **task budget ledger**: estimate / reserve (synchronous, atomic) / measured usage / reconciled cost / unreconciled upper bounds / remaining, per role and provider; refusals `refused_limit`, `refused_pricing_unknown`, `refused_invalid_request`, `refused_unreconciled`, each with an actionable reason; overruns recorded at true cost and block; no usage → unreconciled and block; cancellation before dispatch charges nothing. Reviewed Anthropic price catalog (2026-10-12, sourced, dated, stale after 120 days), custom prices, local inference ($0 external, cost unknown), no substitution between models or providers. Input bound from the request's UTF-8 bytes (+ framing, +10 %), never the context window. `budgetedAdapter` wraps any `LLMAdapter`; `runWithBudget` / `withBudgetAttribution` scope every request to the task ledger with role, stage and the Miranda gate | `budget.test.ts` (26: bounds, pricing, settlement, unknown outcomes, overrun, concurrency, adapter, gate, performance) |
| `miranda-core` gate | `LLMCallGateContext.budget: BudgetDecision`; a refusal BLOCKs with the kind in the reason; the budgeted adapter passes every decision through `before_llm_call` at stage `budget:<stage>` | same + gate suite |
| `orca-core` runtime, repair loop, `budget/passAccounting.ts`, `budget/journal.ts` (new) | One ledger per task (or the shell's message ledger), traced and emitted (`budget:update`); each Maestro pass runs in the scope and its measured cost, unreconciled bound, tokens and refusals land in `metadata`; a budget refusal or exhausted ledger stops with `Stopped by the task budget: … incomplete and was not verified`; repairs and fallbacks draw on the same remaining budget; a repair pass that could not make a request stops before QC; legacy self-reported `costUsd` cap kept for Maestros without adapters; snapshot in `pipeline:summary`, trace `finalResult`, `runs.cost_usd` (reconciled) + new `cost_unreconciled_usd`, `cost_basis`; JSON journal of in-flight snapshots recovered on next start | `runtimeBudget.test.ts` (7), `journal.test.ts` (3), existing runtime/repair stress tests |
| `agent-loop-core`, runner maestro adapter | `budgetGateContext(ctx)` replaces the `0 / Infinity` placeholders at every `before_llm_call` | suites |
| `apps/desktop` (`budgetContext.ts` new, `providerAdapter.ts`, `llmGate.ts`, `settings.ts`, `main.ts`, renderer) | Every adapter budgeted (session ledger outside a message); one message ledger with the configured limit wraps narration, Brain, workers, fallbacks, repairs and Cargo summaries; Miranda fields from the ledger; `budgetSource` (`user` / `legacy_default`), `pricing` (custom prices) in Settings; legacy $0.10 kept enforced, labelled and explained at start-up, never raised; "Budget per task" with 0 = no hard limit; journal recovery warnings; status bar and badge show confirmed / unreconciled / reserved / remaining / by role / by provider / stop reason | `budgetContext.test.ts` (7), `settings.test.ts` (+5), `llmGate.test.ts` (+3), desktop suite |
| `apps/runner` | Adapters budgeted; `ORCA_BUDGET_USD` (hard budget) and `ORCA_PRICING_JSON` (custom prices) | runner suite |

Not changed: Pappy's rules, Moonshiner eligibility, Miranda's tool protections, model assignments, cancellation, MCP behaviour. No paid request, no push, no package.

## Unverified

- Behaviour inside the packaged Electron app (the approval dialog flow with real MCP servers) — unit tests use spy executors; the main-process bundle builds (`build-main.mjs`) but no live run was made.
- Prompt-level effect: workers now receive "was not approved" / "blocked" tool results for MCP writes; how each model reacts (retry, alternative tool, give up) was not observed.

---

## Outstanding problems

| # | Problem | Notes |
|---|---|---|
| 1 | **Phases 5–7 of the integration plan** (routing/cancellation, UI, Pappy false rejects) | Not started; each needs its own authorization. |
| 1k | **Budget limitations** (`docs/ORCA_BUDGET_ARCHITECTURE.md` §Limitations): prices known only for Anthropic's own API (others need a custom price under a hard budget; OpenAI/OpenRouter pages could not be fetched); reservation is an upper bound only where the provider honours `max_tokens` and reports usage (overruns are recorded and stop the task, not prevented); ledger is per process; a stream without usage stops a hard-budget task after one request; cache writes not modelled | Recommended refresh: a dated JSON catalog filled from OpenRouter `/api/v1/models` and Anthropic's Models API, warned on age instead of edited by hand. |
| 1e | ~~Follow-up A gaps~~ | Closed in phase 2.5 (behavioural receipts, PARTIAL → HIGH with evidence, docs content check). |
| 1f | ~~Evidence corpus known gaps~~ | Closed in phase 2.5 by fixing the causes; registry empty (`docs/ORCA_EVIDENCE_CORPUS.md`). |
| 1g | `claude-haiku-5-5` is not in Orca's Anthropic catalog (reviewed 2026-09-25) and could not be checked live | The 1.6.1 staging profile and docs use it; on this branch it only produces an init warning and is sent as configured. Verify against Anthropic's live model list before any Live run. |
| 1h | **Contract check REVIEW REQUIRED: 15 × Rule 4 + 1 × Rule 5** (`apps/runner/src/index.ts`, adapter config fields only) | Rule 4 files: `pappy.ts`, `workspaceVerification.ts` (+ test), `evidenceTerms.ts`, `completeness.ts`, `claimProof.ts`, 9 fixtures. Every one can change a verdict or eligibility (that is their purpose: stricter behavioural evidence, root-cause heuristic fixes, honesty-based eligibility); none downgrades a FAIL, overrides Pappy, or touches Miranda's afterQC. Needs explicit approval before merge. |
| 1c | Ledger criteria without an anchor (no symbol, no named file, not about the output) stay MISSING | Pre-existing; the audit's §6.5 diff-backed receipts are phase 7. |
| 1i | Relevance is lexical (identifiers and distinctive words); a documented verification is checked for recording, timing, exit status, output and relevance, not semantic sufficiency; docs paraphrases are missed (reported as insufficient, never contradicted); non-test commands carry no source-state fingerprint (ordered trace only) | Documented limitations (`docs/ORCA_VERIFICATION_EVIDENCE.md`). Targeted evidence collection from `evidenceRequests` instead of a full repair pass is a future orchestration design. |
| 1j | Behaviour change for existing users: a bug fix / feature / refactor with no test run now FAILs with a specific evidence request instead of passing "verified"; a feature needs a test or documented validation that exercises it; rows without eligibility/evidence tags are no longer exported | Intended by phase 2.5; workers receive the guidance goals so they know what to leave behind. |
| 1d | Eval corpus eligibility expectations for evidence-less runs no longer match (raw judge 14 → 11) | Loophole closed by design; the corpus fixtures were not changed. A corpus with runtime evidence is needed to measure the new gate. |
| 2 | **Behaviour change for MCP users:** tools whose names carry no recognised verb (`sequentialthinking`, `resolve-library-id`, `puppeteer_*`, `browser_*`) now ask for approval on every call; the renderer's "always approve this tool for the session" checkbox covers them. | Consider a per-server trust setting (read-only servers) later. |
| 3 | Miranda's verb classifier does not know server ids, so an MCP server id that itself contains a verb (`search-tools`) can mislead Miranda's connector_read/write split; the desktop layer strips configured ids and is the effective backstop. | Low; documented in tests. |
| 4 | `run_workflow` / `rerun_workflow_run` are writes in both layers now; `dismiss_notification` and `request_copilot_review` are writes by leading verb. Review the official GitHub MCP tool list against `toolAuthorization.test.ts` when the server updates. | — |
| 5 | Desktop app is not type-checked (`apps/desktop` has no tsconfig; `main.ts` has pre-existing strict errors). | Unchanged from `main`. |
| 6 | Nothing on this branch is pushed or merged. | Requires authorization. |

---

## Last verified tests

| Date | Commit | Machine | Command | Result |
|---|---|---|---|---|
| 2026-10-12 | phase 4 head | dev desktop (Node 24.11.1) | `pnpm -r --no-bail test` | **1,789 passed · 0 failed · 1 skipped** (packages 1,423; runner 107; desktop 259) |
| 2026-10-12 | phase 4 head | dev desktop | `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts`, desktop `tsc --noEmit` + `build-main.mjs` | 0 errors; bundle OK |
| 2026-10-12 | phase 4 head | dev desktop | `pnpm contract:check` | REVIEW REQUIRED (15 × Rule 4 from phase 2.5, 1 × Rule 5 runner; no new findings) |
| 2026-10-12 | phase 4 head | dev desktop | ledger benchmark (`miranda-core` scratch) | reserve+settle 70 µs (4 KB prompt) / 390 µs (400 KB); snapshot 1.3 ms at 22k entries; budgeted adapter 24 µs per request over a bare adapter |
| 2026-10-12 | phase 2.5 head | dev desktop (Node 24.11.1) | `pnpm -r --no-bail test` | **1,735 passed · 0 failed · 1 skipped** (packages 1,384; runner 107; desktop 244) |
| 2026-10-12 | phase 2.5 head | dev desktop | `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts`, desktop `tsc --noEmit` + `build-main.mjs` | 0 errors; bundle OK |
| 2026-10-12 | phase 2.5 head | dev desktop | `pnpm contract:check` | REVIEW REQUIRED (15 × Rule 4, 1 × Rule 5 runner) |
| 2026-10-12 | phase 2.5 head | dev desktop | `pnpm pappy:eval` / `:raw-real-pappy` / `:pappy-plus-hardening` | 23/23 · 12/23 · 15/23; cheat 100 % · false accept 0 % · false reject 0 % / 42.9 % / 42.9 % |
| 2026-10-12 | phase 2.5 head | dev desktop | `pnpm pappy:eval:evidence` (45 fixtures) | 45/45; false acceptances 0/33; false rejections 0/11; status 100 %; eligibility 100 % |
| 2026-10-12 | phase 2.5 head | dev desktop | same 45 fixtures against phase 3 Pappy (`96bacc6`) | 30/45; false acceptances 3/33; false rejections 7/11; status 86.7 %; eligibility 73.3 % |
| 2026-10-12 | phase 2.5 head | dev desktop | Miranda `mirandaGate.test.ts` (72), desktop `toolAuthorization.test.ts` (60) | unchanged, passing (in the suites above) |
| 2026-10-09 | phase 3 head | dev desktop (Node 24.11.1) | `pnpm -r --no-bail test` | **1,695 passed · 0 failed · 1 skipped** (packages 1,348; runner 107; desktop 240) |
| 2026-10-09 | phase 3 head | dev desktop | `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| 2026-10-09 | phase 3 head | dev desktop | `pnpm contract:check` | REVIEW REQUIRED (12 × Rule 4 from phase 2, 1 × Rule 5 runner) |
| 2026-10-09 | phase 3 head | dev desktop | `pnpm pappy:eval` / `:raw-real-pappy` / `:pappy-plus-hardening` | 23/23 · 11/23 · 14/23; cheat 100 % · false accept 0 % · false reject 57.1 % (unchanged) |
| 2026-10-09 | phase 3 head | dev desktop | `pnpm pappy:eval:evidence` | 18/26 fully matched; false acceptances 0/18; false rejections 4/7 (all known heuristics); status accuracy 96.2 %; eligibility accuracy 69.2 % |
| 2026-10-09 | phase 3 head | dev desktop | `apps/desktop`: `node build-main.mjs`, `node --check` renderer | OK |
| 2026-10-09 | phase 2 head | dev desktop (Node 24.11.1) | `pnpm -r --no-bail test` | **1,597 passed · 0 failed · 1 skipped** (packages 1,287; runner 107; desktop 203) |
| 2026-10-09 | phase 2 head | dev desktop | `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| 2026-10-09 | phase 2 head | dev desktop | `pnpm contract:check` | REVIEW REQUIRED (12 × Rule 4) |
| 2026-10-09 | phase 2 head | dev desktop | `pnpm pappy:eval` / `:raw-real-pappy` / `:pappy-plus-hardening` | 23/23 · 11/23 · 14/23; cheat 100 % · false accept 0 % · false reject 57.1 % |
| 2026-10-09 | `99c9818` (working tree identical) | dev desktop (Node 24.11.1) | `pnpm -r --no-bail test` | **1,548 passed · 0 failed · 1 skipped** (packages 1,238; runner 107; desktop 203) |
| 2026-10-09 | `99c9818` | dev desktop | `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| 2026-10-09 | `99c9818` | dev desktop | `pnpm contract:check` | CLEAR (10 changed files scanned) |
| 2026-10-09 | `99c9818` | dev desktop | `apps/desktop`: `node build-main.mjs`, `vitest run` | bundle OK; 203 passed |
| 2026-10-09 | `7b62cce` (`origin/main`, audit worktree) | dev desktop | packages + desktop suites, tsc, Pappy eval (3 judges) | 1,230 + 143 passed; 0 errors; 23/23 · 14/23 · 14/23 |

---

## Session log (newest first, keep the last 10)

- **2026-10-12 (core phase 4)** (dev desktop) — Budget enforcement: provider-independent task ledger in miranda-core (atomic reservations from request-derived token bounds, measured settlement, unreconciled upper bounds, refusals with reasons, Miranda budget checkpoint), reviewed Anthropic price catalog (2026-10-12), custom prices, local inference; runtime/repair/desktop/runner wiring, legacy $0.10 kept-and-labelled migration, restart journal, cost display. No push, merge, package, paid call.
- **2026-10-12 (core phase 2.5)** (dev desktop) — Behavioural verification (task-aware receipts: reproduction, regression test, full suite, documented validation command, build check, final docs content), per-criterion assessments with HIGH PARTIAL, honesty-based training eligibility on contradicted evidence, evidence requests, root-cause fixes to the keyword heuristics and claim proof, export that checks evidence tags itself, desktop worker guidance, corpus 26 → 45 with 0/0 false acceptances/rejections, original corpus raw 11→12 / hardened 14→15. Full suite 1,735 passed. No push, merge, build, paid call, retraining.
- **2026-10-09 (core phase 3)** (dev desktop) — Provider compatibility: adapter-layer sampling/thinking policy, model catalog, structured provider errors, honest usage reporting, stable provider resolution with warnings, renderer stale-provider fix, runner policy; evidence-bearing eval corpus (26 fixtures, 0 false acceptances, 8 documented known gaps); follow-up A investigation (no Pappy change). No push, merge, build, paid call.
- **2026-10-09 (core phase 2)** (dev desktop) — Audited Pappy's confidence (heuristic, display-only, uncalibrated); implemented runtime workspace evidence, task-aware verification, evidence-strength ledger, evidence status and the training-eligibility gate; adversarial before/after 7→0 false acceptances, 1→0 false rejections; corpus verdict metrics unchanged; full suite 1,597 passed. No push, merge, build, paid call.
- **2026-10-09 (core phase 1)** (dev desktop) — Created `integration/core-reliability` from `origin/main`; preserved the audit and the parallel-work comparison; reviewed the 14 contract findings individually (they belong to the 1.6.1 branch; this branch is CLEAR); implemented Miranda verb classification + path keys and desktop execution-time authorization with regression tests; full suite 1,548 passed. No push, merge, build, paid call.
- **2026-10-09 (audit)** (dev desktop) — Read-only core reliability audit of `origin/main` vs `integration/1.6.1-clean` (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`).
- **2026-10-09 (staging)** (dev desktop) — Validated `integration/1.6.1-clean`, built the Summit staging app, offline smoke 23/23 (see that branch).
