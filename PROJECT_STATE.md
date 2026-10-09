# Orca — Project State

> **Update this file at the end of every development session** (rules in
> [CLAUDE.md](CLAUDE.md#project-state)). Record only what you verified yourself —
> in the code, in git, or by running tests. Anything reported but not verified
> goes under **Unverified**, with who reported it.

**Last updated:** 2026-10-09 (core reliability, phase 3) · **Machine:** dev desktop · **By:** Claude Code session

---

## Where the work lives

| Branch | Where | Head | Pushed? | Status |
|---|---|---|---|---|
| `main` | origin | `7b62cce` | yes | Production baseline. Carries the shared-component defects listed in the audit (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`). Local `main` in `C:\Orca\Orca` is 10 commits behind. |
| **`integration/core-reliability`** | dev desktop worktree `C:\Orca\worktrees\core-reliability` | this commit | **no** | **Source-only production integration branch, from `origin/main`.** Phases 0 (docs), 1 (core security), 2 (Pappy verification integrity) and 3 (provider compatibility) done; none approved for merge. No Demo Mode code. |
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

Follow-up A (investigation only, no Pappy change): confirmed gaps — (1) a bug fix, feature or refactor in a project without a test command is labelled `verified` on the strength of the on-disk change alone (PASS, not trainable); (2) a required criterion that is `PARTIAL` stays MEDIUM → WARN when runtime evidence exists; (3) the named-file receipt for documentation proves the file changed, not that its content satisfies the request. Git inventory: untracked new files are captured (`--others --exclude-standard`), deletions and renames (as delete + add) are seen, pre-existing uncommitted edits form the baseline rather than being attributed to the task; ignored paths (`build/`, `*.log`) are excluded by design.

## Unverified

- Behaviour inside the packaged Electron app (the approval dialog flow with real MCP servers) — unit tests use spy executors; the main-process bundle builds (`build-main.mjs`) but no live run was made.
- Prompt-level effect: workers now receive "was not approved" / "blocked" tool results for MCP writes; how each model reacts (retry, alternative tool, give up) was not observed.

---

## Outstanding problems

| # | Problem | Notes |
|---|---|---|
| 1 | **Phases 4–7 of the integration plan** (budget, routing/cancellation, UI, Pappy false rejects) | Not started; each needs its own authorization. |
| 1e | **Follow-up A gaps (need approval before changing Pappy):** change-only "verified" status for behavioural tasks without tests; `PARTIAL` required criteria stay WARN with evidence present; docs receipts do not judge content | Smallest correction proposed in the phase 3 report: require a behavioural receipt (host-recorded post-change command naming the criterion's terms, or a documented alternative backed by a recorded command) for bugfix/feature; a build/typecheck receipt for refactors without tests; `PARTIAL` → HIGH when runtime evidence exists; docs receipts require the criterion's distinctive terms in the final content. |
| 1f | **Evidence corpus known gaps** (8 of 26 fixtures; `docs/ORCA_EVIDENCE_CORPUS.md`) | 4 false rejections from pre-existing keyword heuristics (phase 7); `SUCCESS_CLAIM_PATTERN` misses "tests pass"/"Documented …"; claimProof rejects an honestly reported failed run; inspection status alignment. 0 false acceptances. |
| 1g | `claude-haiku-5-5` is not in Orca's Anthropic catalog (reviewed 2026-09-25) and could not be checked live | The 1.6.1 staging profile and docs use it; on this branch it only produces an init warning and is sent as configured. Verify against Anthropic's live model list before any Live run. |
| 1h | Contract check REVIEW REQUIRED: 12 × Rule 4 (phase 2) + Rule 5 on `apps/runner/src/index.ts` (adapter config fields only; no user-facing output changed) | Needs explicit approval before merge. |
| 1b | **Contract check: REVIEW REQUIRED, 12 Rule 4 findings** (`pappy.ts`, `workspaceVerification.ts` + test, 9 fixtures) | Additive checks and ledger statuses only; nothing downgrades a FAIL. Needs explicit approval before merge. |
| 1c | Ledger criteria without an anchor (no symbol, no named file, not about the output) stay MISSING | Pre-existing; the audit's §6.5 diff-backed receipts are phase 7. |
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

- **2026-10-09 (core phase 3)** (dev desktop) — Provider compatibility: adapter-layer sampling/thinking policy, model catalog, structured provider errors, honest usage reporting, stable provider resolution with warnings, renderer stale-provider fix, runner policy; evidence-bearing eval corpus (26 fixtures, 0 false acceptances, 8 documented known gaps); follow-up A investigation (no Pappy change). No push, merge, build, paid call.
- **2026-10-09 (core phase 2)** (dev desktop) — Audited Pappy's confidence (heuristic, display-only, uncalibrated); implemented runtime workspace evidence, task-aware verification, evidence-strength ledger, evidence status and the training-eligibility gate; adversarial before/after 7→0 false acceptances, 1→0 false rejections; corpus verdict metrics unchanged; full suite 1,597 passed. No push, merge, build, paid call.
- **2026-10-09 (core phase 1)** (dev desktop) — Created `integration/core-reliability` from `origin/main`; preserved the audit and the parallel-work comparison; reviewed the 14 contract findings individually (they belong to the 1.6.1 branch; this branch is CLEAR); implemented Miranda verb classification + path keys and desktop execution-time authorization with regression tests; full suite 1,548 passed. No push, merge, build, paid call.
- **2026-10-09 (audit)** (dev desktop) — Read-only core reliability audit of `origin/main` vs `integration/1.6.1-clean` (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`).
- **2026-10-09 (staging)** (dev desktop) — Validated `integration/1.6.1-clean`, built the Summit staging app, offline smoke 23/23 (see that branch).
