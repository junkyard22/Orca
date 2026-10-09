# Orca — Project State

> **Update this file at the end of every development session** (rules in
> [CLAUDE.md](CLAUDE.md#project-state)). Record only what you verified yourself —
> in the code, in git, or by running tests. Anything reported but not verified
> goes under **Unverified**, with who reported it.

**Last updated:** 2026-10-09 (core reliability, phase 2) · **Machine:** dev desktop · **By:** Claude Code session

---

## Where the work lives

| Branch | Where | Head | Pushed? | Status |
|---|---|---|---|---|
| `main` | origin | `7b62cce` | yes | Production baseline. Carries the shared-component defects listed in the audit (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`). Local `main` in `C:\Orca\Orca` is 10 commits behind. |
| **`integration/core-reliability`** | dev desktop worktree `C:\Orca\worktrees\core-reliability` | this commit | **no** | **Source-only production integration branch, from `origin/main`.** Phase 0 (docs), phase 1 (core security) and phase 2 (Pappy verification integrity) done. No Demo Mode code. |
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

## Unverified

- Behaviour inside the packaged Electron app (the approval dialog flow with real MCP servers) — unit tests use spy executors; the main-process bundle builds (`build-main.mjs`) but no live run was made.
- Prompt-level effect: workers now receive "was not approved" / "blocked" tool results for MCP writes; how each model reacts (retry, alternative tool, give up) was not observed.

---

## Outstanding problems

| # | Problem | Notes |
|---|---|---|
| 1 | **Phases 3–7 of the integration plan** (providers, budget, routing/cancellation, UI, Pappy false rejects) | Not started; each needs its own authorization. |
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

- **2026-10-09 (core phase 2)** (dev desktop) — Audited Pappy's confidence (heuristic, display-only, uncalibrated); implemented runtime workspace evidence, task-aware verification, evidence-strength ledger, evidence status and the training-eligibility gate; adversarial before/after 7→0 false acceptances, 1→0 false rejections; corpus verdict metrics unchanged; full suite 1,597 passed. No push, merge, build, paid call.
- **2026-10-09 (core phase 1)** (dev desktop) — Created `integration/core-reliability` from `origin/main`; preserved the audit and the parallel-work comparison; reviewed the 14 contract findings individually (they belong to the 1.6.1 branch; this branch is CLEAR); implemented Miranda verb classification + path keys and desktop execution-time authorization with regression tests; full suite 1,548 passed. No push, merge, build, paid call.
- **2026-10-09 (audit)** (dev desktop) — Read-only core reliability audit of `origin/main` vs `integration/1.6.1-clean` (`docs/ORCA-CORE-RELIABILITY-AUDIT.md`).
- **2026-10-09 (staging)** (dev desktop) — Validated `integration/1.6.1-clean`, built the Summit staging app, offline smoke 23/23 (see that branch).
