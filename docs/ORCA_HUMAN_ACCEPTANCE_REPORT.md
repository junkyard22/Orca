# Orca human acceptance report (core reliability, phase 6.6)

**Date:** 2026-10-12 · **Branch:** `integration/core-reliability` (worktree `C:\Orca\worktrees\core-reliability`) · **Baseline:** `origin/main` `7b62cce` · **Previous report:** `docs/ORCA_FINAL_SAFETY_VALIDATION.md` · **Classification:** **CONDITIONALLY READY** (§13) — the human checks and the six contract decisions below are the remaining gates, and this report stops at them.

Everything deterministic in the phase 6.6 brief was done. Everything that needs a person — three approval checks, the override-dialog inspection, and six contract decisions — is staged and **PENDING**, not assumed.

## 1. Branch and HEAD

`integration/core-reliability`; phase 6.6 commits are listed in §9 (recorded at commit time). Working tree clean after them. Nothing on `origin/main` is missing from the branch.

## 2. Manual desktop acceptance (Part 1)

**Environment, verified:** source build (`node build-main.mjs`; no installer, no package); isolated profile under `%LOCALAPPDATA%\Temp\orca-audit\phase6\profile-c` (scratch `userData`, `HOME`, workspace); the mock provider listens on `127.0.0.1:3939` only and contains no outbound call of any kind (`grep` for `fetch(`, `http.request`, `net.connect`, `axios`, `undici` in `scripts/desktop-validation/mock-provider.mjs`: none); the seeded settings name no other provider; no GitHub token is set; no installed Orca or Summit kit is touched (the app runs from `apps/desktop` with `ELECTRON_RUN_AS_NODE` removed and its own `--user-data-dir`). The app is launched visibly with **no DevTools port**: nothing in this phase reads or drives the window.

**Checks A, B, C — PENDING (human).** The staged steps are in §7 (rows 3, 4, 7). The agent does not click, inspect, or confirm any of them; it records what the presenter reports. Rows that only an automated witness saw remain marked as such.

## 3. Workspace override review (Part 2)

**Dialog inspection — PENDING (human).** `scripts/desktop-validation/stage-override.mjs --profile <dir>` starts one harmless sleeper (`node`, 20 minutes, touches nothing) and records it in the profile's `workspace-protection.json` as a process a previous task could not confirm stopped. On launch the banner appears; the presenter opens the native dialog and **presses Cancel** (the sleeper is the stand-in for an uncontrolled writer; no override is performed while it runs). What to confirm is in §7, row 13b. Ending the sleeper from Task Manager shows the protection lifting by *verification* (status line "Workspace released (every process verified gone)"), which is the contrast the brief asks for.

**Override accounting — PASS (deterministic, `packages/orca-core/src/overrideAccounting.test.ts`, 3 tests):** an override is recorded in the audit log with the protection as it stood (operations and processes intact); the workspace generation goes 0 → 1; the interrupted task's run record stays `FAIL / interrupted`; its lifecycle stays INTERRUPTED and its late tool call, approval request and model call are still refused; the budget's unreconciled amount is unchanged; the next task still asks for approval like any task (the override granted no authority); an override without the literal `acknowledged: true` is refused; events and logs say `verification: every process was verified gone` for a verified release and `override: the user accepted the risk …` for an override. The renderer labels them "Workspace released (every process verified gone)" versus "Workspace protection overridden — recorded as your decision, nothing was verified or stopped".

## 4. Process-survivor performance (Part 3)

`scripts/profiling/survivor-scan-bench.mjs --samples 10` (disposable `node -e` commands in a scratch directory; Windows, Node 24.11.1). The phase 6.5 figure of ≈3.4 s came from a benchmark that ran the scan from inside a heavier process; measured directly, one enumeration costs ≈0.6 s (PowerShell start 0.24 s + CIM query ≈0.35 s + formatting), and all alternatives tried (CSV, `Get-Process`, a creation-date WQL filter) cost the same because the query dominates.

| Scenario | Command (p50 / p95 / max) | Scan (p50 / p95 / max) | End-to-end | Notes |
|---|---|---|---|---|
| one short command (n = 10) | 78 / 92 / 123 ms | 768 / 796 / 820 ms | 859 / 878 / 898 ms | scan = 150 ms coalescing window + ≈0.6 s enumeration, asynchronous |
| 10 sequential commands | 985 ms for all | last scan done at 1,884 ms | 188 ms per command | scans overlap the next command |
| 20 sequential commands | 3,253 ms | 4,292 ms | 215 ms per command | |
| 10 independent parallel commands | 259 ms | 977 ms | — | **one** enumeration served all ten (before coalescing: 2,368 ms, ten enumerations) |
| build creating children (n = 5) | 308 / 308 / 327 ms | 773 / 777 / 777 ms | — | 0 survivors (children exited) |
| detached grandchild | 96 ms | 762 ms | — | grandchild reported as "orphan of: node grandchild.js"; workspace protected while alive; settled on the first check after it exited (0 ms) |
| normal exit, no descendants | 79 ms | 790 ms | — | `done`, 0 survivors |
| scan unavailable (`ORCA_PROCESS_SCAN=off`) | 76 ms | 0 ms | — | `unknown` — reported, never read as "none" |

Overhead: Node CPU 0.64 s over 23.5 s of benchmark wall time; RSS 67 → 72 MB; each enumeration is a short-lived PowerShell child (its CPU is outside Node). Effect on a worker: a command's *result* is not delayed at all; QC waits for a pending scan (≤ 8 s) so the last command before verification adds ≈0.8 s once; parallel commands are not serialised.

**Optimisation implemented (the smallest):** scans requested within a 150 ms window share one enumeration that starts after the window closes. Safety is unchanged: the snapshot is taken after every sharing request was made, i.e. after each command's shell had exited, which is exactly what an individual scan sees; an enumeration already in flight is never shared. Verified by `survivingProcesses.test.ts` "scan coalescing" (5 concurrent commands, fewer than 5 enumerations, each with its own correct result). Not done, and why: scoping the query by creation date (same cost); caching (a stale snapshot could miss a survivor); skipping the scan for "known-safe" commands (absence of evidence is not safety).

## 5. Six contract exceptions — individual decisions (Part 4 §6)

Status: REVIEW REQUIRED (15 × Rule 4, 1 × Rule 5, 0 BLOCKED). Rule 4 flags any file under `pappy-core/src/checks/`, `pappy.ts`, or a pappy-core path matching `verdict|repair|qc`; Rule 5 flags `apps/runner/src/index.ts` by name. **Decisions are the human's; the recommendation column is advice, not approval.**

| # | Rule / file | Relevant code | Why it triggered | Why intentional | Impact | Tests | Remaining risk | Recommendation | **Decision** |
|---|---|---|---|---|---|---|---|---|---|
| E1 | 4 · `packages/pappy-core/src/pappy.ts` | `buildCriteriaLedger`, `requireBehaviouralEvidence`, `requireAttributableEvidence`, `deriveTrainingEligibility`, `deriveVerificationStatus`, evidence requests | path match | phases 2 / 2.5 / 6.5: a required criterion needs criterion-specific, worker-independent evidence; a contradicted claim is never trainable; unresolved attribution is never trainable | verification: stricter; training: stricter; authorization: none; no FAIL downgraded; Miranda `afterQC` untouched | `pappy.test.ts` 50, `workspaceVerification.test.ts` 43, `integrationStress.test.ts`, suites 23/23·12/23·15/23, corpus 45/45 | relevance is lexical (documented) | **Approve** | ☐ PENDING |
| E2 | 4 · `packages/pappy-core/src/checks/workspaceVerification.ts` | `runWorkspaceVerificationChecks`: partial inventory, test-edit checks, behavioural receipts, source-state fingerprints, contested writes (LOW / LOW+attribution / MEDIUM) | path match | the host's own evidence judged instead of the worker's account | downgrades and issues only; never upgrades | 43 + evidence corpus + stress tests | lexical; survivor scan is a lower bound (not this file) | **Approve** | ☐ PENDING |
| E3 | 4 · `packages/pappy-core/src/checks/evidenceTerms.ts` | `distinctiveTerms`, `withoutFilePaths`, `textCoversRequirement` | path match | file names must not count as symbols; docs must contain the requested item | relevance matching only; fixed two false acceptances | `criterionSymbols.test.ts`, `claimProof.test.ts` 24, corpus | lexical | **Approve** | ☐ PENDING |
| E4 | 4 · `packages/pappy-core/src/checks/completeness.ts` | `testsExpected` with `withoutProhibitions`, keyword root-cause fixes | path match | "do not modify the existing tests" must not read as "tests requested" | fewer false "tests requested" readings | `completeness.test.ts` 40, corpus | lexical | **Approve** | ☐ PENDING |
| E5 | 4 · `packages/pappy-core/src/checks/claimProof.ts` | partial pass counts ("7 of 8 pass") are not pass claims; stronger `CLAIM_SUCCESS_PATTERN` | path match | a partial result must not prove success | catches more unproven claims | `claimProof.test.ts` 24, corpus | lexical | **Approve** | ☐ PENDING |
| E6 | 5 · `apps/runner/src/index.ts` | `budgetedAdapter(...)`, `ORCA_BUDGET_USD`, `ORCA_PRICING_JSON`, `providerAcceptsTemperature` / `EnableThinking`, `sessionBudget` | file on Rule 5's list | the CLI must account every request the way the desktop does | no user-facing text changed; refusals surface through the runtime summary as before; no diagnostic leaks | runner suite 107, `runtimeBudget.test.ts` | none identified | **Approve** | ☐ PENDING |

Nothing was suppressed; the checker still reports all sixteen.

## 6. Ten false positives (Part 4 §7)

| # | File | Why it is a false positive | Unsafe execution or verdict handling? |
|---|---|---|---|
| F1 | `packages/pappy-core/src/checks/workspaceVerification.test.ts` | a test file under `checks/`; no runtime behaviour | no — it is the evidence for E2 |
| F2–F10 | `packages/pappy-core/src/checks/__fixtures__/find-fix/` — `ISSUE.md`, `base_npmtest.out`, `base_subset.out`, `bookings.base.txt`, `bookings.fixed.txt`, `bookings.test.base.txt`, `bookings.test.tamper.txt`, `fixed_npmtest.out`, `tamper_npmtest.out` | fixture data read only by tests and the evaluation corpus | no — they are the corpus the verdicts are measured against |

Rationale kept here and in PROJECT_STATE item 1h; the checker is unchanged so the record stays auditable on every run.

## 7. Corrected checklist accounting (Part 5)

Phase 6.5 reported 9 PASS + 2 PARTIAL + 3 PENDING = 14 for 13 rows: row 2 had been counted both as PASS and as PARTIAL. Correct: **8 PASS, 2 PARTIAL, 3 PENDING = 13** (plus the override dialog, 13b, which was always PENDING). Full record (`A` = automated witness through the DevTools port in phase 6.5; `H` = must be witnessed by a human):

| Id | Check | Expected | Observed (phase 6.5) | Witness | Status | Evidence | Remaining action |
|---|---|---|---|---|---|---|---|
| 1 | Startup, isolated profile | window, "ready", no warnings, scratch workspace | as expected | A | PASS | `shot-01-startup.png`, `app-a.log` | H: confirm visually (optional) |
| 2 | Provider configuration | Billing select works; metered + price refuses | seeded settings took effect (local and metered) | A | PARTIAL | `shot-07-budget-refusal.png` | H: change Billing in Settings, save, observe |
| 3 | Approval presentation | dialog names tool and action, workspace understandable, no secrets, safe default, bound to the active task | card appeared ("Tool call request … Deny · Approve"); not inspected | — | PENDING | `shot-06-approval.png` (card present, scrolled) | **H: inspect** (§2 A) |
| 4 | Approve / Deny | Approve runs only that command; Deny runs nothing and is never shown as executed | not clicked | — | PENDING | — | **H: click both** (§2 B) |
| 5 | Approval timeout | auto-deny at 60 s, worker told, no execution | as expected | A | PASS | transcript in `RESULTS-2026-10-12.md` | — |
| 6 | Stop during a model request | Stopping… → Stopped — settled; `cancelled`; no fallback | defect found and fixed; after the fix as expected | A | PASS | `shot-03-stop.png` | — |
| 7 | Stop while approval pending | CANCELLING, approval invalid, late click inert, no further requests, `cancelled` | not performed | — | PENDING | unit: `runtimeCancellation.test.ts` | **H: perform** (§2 C) |
| 8 | Task state badges | truthful state; never green after Stop | `failed`, `cancelled`, `failed (process … never settled)`; missing row fixed | A | PASS | transcripts | — |
| 9 | Brain fallback visibility | "Planning fell back: … invalid_plan …" | as expected | A | PASS | transcript | — |
| 10 | Budget refusal display | refused before dispatch, actionable text, mock not contacted | as expected; refused planning call shown as fallback → fixed | A | PASS | `shot-07-budget-refusal.png`, mock log 39 → 39 | — |
| 11 | Pappy verification result | fabricated claim → FAIL with the issue | `PROOF_CLAIM_UNVERIFIED`, FAIL | A | PASS | `shot-02-hello.png` | — |
| 12 | Recovery after restart | init warning with exposure; run `interrupted` | as expected | A | PASS | `shot-04-recovery.png` | — |
| 13 | Workspace lock / protection banner | "still stopping" refusal; banner with recovery text | banner observed (orphan false positive, released by verification); "still stopping" not observable (Brain cancels in ms) | A | PARTIAL | `shot-06-approval.png` | H: see 13b |
| 13b | Override dialog | unsafe clearly stated; unsettled listed; "does not stop"; literal acknowledgement; default Cancel; "I accept the risk — override"; never "verified safe" | not opened | — | PENDING | staged by `stage-override.mjs` | **H: open, inspect, Cancel** (§3) |

## 8. Complete regression results (Part 6)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test` (after the last code change) | **1,891 passed · 0 failed · 1 skipped** (orca-core 312, pappy-core 393, miranda-core 236+1, workbench-core 63, desktop 292, runner 107, others unchanged; +7 since phase 6.5: overrideAccounting 3, agentDispatch 3, scan coalescing 1) |
| Miranda authorization (`miranda-core` 236+1 skipped), desktop `toolAuthorization` / `llmGate` | pass |
| lifecycle / cancellation (`lifecycle`, `runtimeCancellation`, `runtimeWorkspaceSafety`, `taskSession`, `workspaceSafety`) | pass |
| workspace ownership / survivors (`workspaceGuard`, `overrideAccounting`, `survivingProcesses` incl. coalescing, `processIdentity`, `runCommandCancellation`) | pass |
| Pappy suites | 23/23 · 12/23 · 15/23 · evidence 45/45 (FA 0/33, FR 0/11) — unchanged |
| Moonshiner eligibility/export (`exportTrainingData.test.ts`, `integrationStress`) | pass |
| Brain/Maestro routing (`brainFallback`, `routingPolicy`, `repairRouting`) | pass |
| budget / provider (`budget`, `budgetHardening`, `runtimeBudget`, `journal`, `providerPolicy`, `openaiCompat`) | pass |
| desktop mock-provider assets (`node --check`; live run in phase 6.5) | pass |
| worker dispatch (`agentDispatch.test.ts`, new) | pass |
| tsc all packages + scripts; desktop bundle; renderer | 0 errors |
| contract checker | REVIEW REQUIRED, 15 × Rule 4 + 1 × Rule 5, 0 BLOCKED |

No evaluation expectation was changed; no assertion was weakened.

## 9. Files modified and commit hashes (phase 6.6)

Recorded in PROJECT_STATE at commit time. Files: `packages/workbench-core/src/tools/processIdentity.ts` (scan coalescing, `survivorScanStatistics`), `survivingProcesses.test.ts`; `packages/orca-core/src/overrideAccounting.test.ts` (new); `apps/desktop/src/agents/ReactAgentAdapter.ts` (lifecycle check before every model call), `agents/agentDispatch.test.ts` (new); `scripts/profiling/survivor-scan-bench.mjs` (new), `scripts/desktop-validation/stage-override.mjs` (new), `RESULTS-2026-10-12.md` (accounting); docs.

## 10. Remaining operational risks

- Three approval checks and the override dialog are unwitnessed by a human (staged; §2, §3).
- Six contract exceptions await a decision (§5).
- No real-provider run on this branch; the rehearsal plan (§11) needs separate authorization.
- The survivor scan is a lower bound and can flag unrelated short-lived orphans (released by verification within seconds); hosts without PowerShell / `ps` get "unknown" and no scan-based protection.
- An external process that ignored the kill cannot be fenced; an override records that the user accepts it.
- Prices known only for Anthropic's API; other paid endpoints need a custom price under a hard budget.

## 11. Live AI rehearsal plan (Part 7) — plan only, not authorized

1. **Isolation.** `launch-isolated.mjs --profile <new dir>` with a disposable workspace containing a small real project (e.g. the `find-fix` booking fixture copied as a repo); scratch `HOME`; no GitHub token; MCP servers off.
2. **Initiation.** The human types the first message and presses Send; nothing is scripted.
3. **Provider.** One Anthropic provider, `billing: metered`, a model present in the reviewed catalog (e.g. `claude-sonnet-5-5`), API key entered in Settings by the human for the session and removed afterwards; `models:fetch` confirms access before any task.
4. **Budget.** Hard task budget **$0.50**; the catalog price is shown in the badge; the refusal path is exercised once with a $0.01 budget before the real run.
5. **Dialogs.** Every tool approval answered by the human; the override dialog opened only if a protection appears.
6. **Verification.** Pappy's real requirements: the task must produce a reproduction, a change and a passing run on the final source; the badge must show "completed and verified" only then.
7. **Reconciliation.** After each task: status line confirmed figures vs the provider's usage; `unreconciled` must be $0 when usage was reported; a cancelled request must show as unreconciled upper bound.
8. **Stop during a command.** A task that runs `node -e "setTimeout(()=>{},60000)"` (approved); Stop at 10 s; expect CANCELLING → CANCELLED (kill confirmed) or INTERRUPTED + protection; no late output.
9. **Stop during an approval.** Trigger an approval, press Stop, then click Approve: nothing runs; `cancelled`.
10. **Recovery.** Kill the app during a streaming reply; relaunch the same profile; init warning with the exposure; nothing resumed.
11. **Evidence.** Keep `pipeline-traces/`, `budget-journal.json`, `workspace-protection.json`, the mock-free provider usage page, and screenshots of every dialog.
12. **Criteria.** PASS: every step as expected and the invoice matches the ledger within the provider's rounding. PARTIAL: a step deviates without a safety consequence (e.g. a label). FAIL: any request after Stop, any unverified run shown as verified, any approval taken without a click, any spend over the hard budget, any workspace write after INTERRUPTED without protection.

**Any paid API execution requires separate explicit authorization.** Completing this plan is not that authorization.

## 12. Recommended production merge sequence (Part 8 §13)

- **References.** `integration/core-reliability` (phase 6.6 HEAD in PROJECT_STATE) onto `origin/main` `7b62cce`; 39 + phase 6.6 commits; 136 files, source, tests, fixtures, docs and validation scripts only. Checked by file list and by name: no `release/`, `dist`, `.exe`, `.asar`, key/certificate, `.env`, Summit or staging asset, log, or personal path.
- **Database.** `runs` gains `cost_unreconciled_usd REAL` and `cost_basis TEXT` (idempotent `ALTER TABLE` at open; phase 4).
- **Settings.** New optional fields `budgetSource`, `pricing[]`, `providers[].billing`; existing files load unchanged (historical $0.10 labelled; Ollama local, other endpoints unknown). New userData files `budget-journal.json`, `workspace-protection.json`.
- **User-visible changes.** Evidence-less code changes fail with an evidence request; budget refusals and unreconciled costs shown; Stop answers at once and the next message waits for settlement; a workspace can stay protected after a task with an explicit, recorded override; contested writes judged as §4 of the previous report; "summarize the facts"-shaped departments go to Narrator; a cancelled planning call is a cancellation, a refused one a budget stop; a command's surviving descendants protect the workspace.
- **Contract.** Six exceptions pending human approval (§5); ten false positives recorded (§6); checker unchanged.
- **Post-merge tests.** `pnpm -r test`, `pnpm contract:check:strict`, the four Pappy suites, `build-main.mjs`; then a packaged build and the 13-row checklist on it (new authorization).
- **Rollback.** Revert the merge commit; the extra columns and files are inert for older code.
- **Release validation.** The live rehearsal (§11) is a release gate even after merge approval; a packaged build is a separate authorization.
- **Limitations carried.** §10.

## 13. Final readiness classification

**CONDITIONALLY READY.** Source-level validation passes with no confirmed defect open. Merge into `main` is blocked only by human acts: the three approval checks and the override inspection (staged, PENDING), and the six contract decisions (PENDING). Distribution of a public release is further gated by the live rehearsal and a packaged build, both needing separate authorization. This is not READY FOR HUMAN MERGE APPROVAL until the PENDING rows are witnessed and the decisions recorded; it is not NOT READY, because nothing outstanding is a confirmed failure.
