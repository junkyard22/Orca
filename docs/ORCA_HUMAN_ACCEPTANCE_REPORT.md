# Orca human acceptance report (core reliability, phase 6.6)

**Dates:** 2026-10-12 (preparation) · 2026-10-13 (human checks, contract decisions, corrections) · **Branch:** `integration/core-reliability` (worktree `C:\Orca\worktrees\core-reliability`) · **Baseline:** `origin/main` `7b62cce` · **Previous report:** `docs/ORCA_FINAL_SAFETY_VALIDATION.md` · **Classification:** **CONDITIONALLY READY** (§13).

The human presenter completed the desktop acceptance checks on the source build and decided the six contract exceptions. Two decisions required changes (E1, E3); both are made, tested and ready for reconsideration (§5). Three presenter-found defects were fixed (§2). What remains open is listed exactly (§10, §13).

## 1. Branch and HEAD

`integration/core-reliability`; phase 6.6 commits in §9. Working tree clean after the final commit. Nothing on `origin/main` is missing from the branch.

## 2. Manual desktop acceptance (Part 1) — witnessed by the presenter

**Environment, verified:** source build (`node build-main.mjs`; no installer); isolated profile `%LOCALAPPDATA%\Temp\orca-audit\phase6\profile-c` (scratch `userData`, `HOME`, workspace); mock provider on `127.0.0.1:3939` only, with no outbound call in its source; no other provider in the seeded settings; no GitHub token; nothing of the installed Orca or any Summit kit touched; **no DevTools port** — nothing read or drove the window; the presenter typed, clicked and sent screenshots, and every result below was cross-checked against the pipeline trace, the protection file, the mock's log and the app's log.

| Check | Presenter observed (screenshots) | Runtime cross-check | Result |
|---|---|---|---|
| **13b override dialog** | Native dialog "Override workspace protection": "Orca has NOT confirmed that this workspace is quiet."; lists pid 18396 (node sleeper); "It does not stop anything: a process Orca could not stop keeps whatever access it has …"; Cancel focused as default; only affirmative button "I accept the risk — override"; no wording presents it as safe. Presenter pressed Cancel; banner stayed. | After Cancel: protection intact, generation 0, overrides 0, no override/release in the app log. Sleeper ended only after name, command line and creation time matched; app logged "released … by verification: every process was verified gone" within 8 s. | **PASS** — acknowledgement is one click on the explicitly worded button (no typed text) |
| **3 approval presentation** | In-app modal "Tool call request": tool `run_command`, args `Command: node -e "console.log('orca-validation')"`, 47 s countdown, "Always approve run_command this session" unticked, Deny (plain), Approve (highlighted). | Trace: WAITING_FOR_APPROVAL entered before any execution. | **PARTIAL** — workspace not shown, task binding not shown, Approve visually primary (all three addressed in the fix below; the fixed card has not yet been inspected) |
| **4 Approve** | Six "run_command ✓ Approved" cards, each after "Waiting for your approval."; badge FAIL (`AGENT_LOOP_DETECTED`). | Trace `run_…w4ul34`: WAITING_FOR_APPROVAL six times, each settled before its execution; six host-observed `orca-validation` outputs; loop caused by the mock's turn detection (fixed), not by Orca; workspace unchanged. | **PASS**, pending one detail: whether the presenter clicked six times or ticked "Always approve" (asked; not yet answered — if the box was ticked, Approve is PARTIAL) |
| **4 Deny** | Two "run_command ✗ Denied" cards (initial + repair pass); final reply "The command was not approved, so it did not run"; badge FAIL. | Trace `run_…8rc1b1`: two approval requests, both denied; both tool results `ok:false "Command execution denied by user"`; zero executions; no output anywhere; workspace unchanged. | **PASS** — denial never shown as executed; no carry-over to the repair pass |
| **7 Stop while approval pending — first attempt** | "It won't let me click stop or do anything unless I click on the card." | The modal (`#tool-approval-dialog`, fixed, z-index 999) covered the Stop button. | **DEFECT, fixed** (see below) |
| **7 — second attempt, "Stop task" on the card** | "Stopped — all operations settled.", "Stopped.", badge Task state cancelled, 0 repairs; no Approved card, no output. | Trace `run_…lb519c`: WAITING_FOR_APPROVAL → CANCELLING → CANCELLED; one tool request, no result; three model calls all before Stop, none after (mock log ends at the worker's tool-call turn); app log "task:abort requested by user". The card is dismissed by Stop, so no late click is possible from the UI; the runtime refusing a late approval is unit-tested. | **PASS** |
| **7 — variant, red Stop button with the card open** | not yet reported | — | **PENDING (presenter)** |
| **5 approval timeout** | not performed in 6.6 | Phase 6.5's claim was wrong (§7 correction) | **PENDING** |

**Corrections to phase 6.5.** The claim that an approval card had appeared and timed out (rows 3 and 5) was wrong: the traces show the `echo` command was auto-approved by the sandbox's safe-command allowlist (by design) and no approval was ever requested; my DOM probe had matched a hidden element. Row 5 is PENDING; row 3 was first witnessed today with a non-allowlisted command.

**Defects found by the presenter and fixed (renderer only):**
1. Stop unreachable while an approval is pending → "Stop task" action on the card; the card closes on CANCELLING / CANCELLED / INTERRUPTED; Deny gets keyboard focus (Enter denies); the card shows the workspace folder (`79319ba`).
2. A protection that survived a restart was never re-verified on the 5-second timer → `recover()` now announces kept protections (`d6871af`).
3. Not fixed, noted: the fallback badge shows "Verdict FAIL / ERROR Stopped." beside "Task state cancelled"; the banner duplicates the start-up warning text.

## 3. Workspace override review (Part 2)

Dialog inspected by the presenter: PASS (§2, 13b). Override accounting, deterministic (`overrideAccounting.test.ts`, 3): recorded with the protection as it stood; generation 0 → 1; interrupted run and lifecycle unchanged; late tool / approval / model calls still refused; unreconciled budget unchanged; next task still gated; literal acknowledgement required; events distinguish `verification` from `override`. Renderer labels: "Workspace released (every process verified gone)" vs "Workspace protection overridden — recorded as your decision, nothing was verified or stopped".

## 4. Process-survivor performance (Part 3)

Unchanged from the preparation run (`scripts/profiling/survivor-scan-bench.mjs --samples 10`, idle host): one enumeration ≈ 0.6 s (PowerShell start 0.24 s + CIM query ≈ 0.35 s), not the 3.4 s a heavier benchmark process had shown. Scans requested within 150 ms share one enumeration taken after the window closes (same guarantee): 10 parallel commands 2.4 s → 1.0 s for all scans; 10 sequential 188 ms per command end to end; a build's children: 0 survivors; a detached grandchild: reported, protected while alive, released on the first check after it exited; `ORCA_PROCESS_SCAN=off`: "unknown", never "none". Node CPU 0.64 s over 23.5 s; RSS +5 MB. QC waits ≤ 8 s for a pending scan, so a task whose last action was a command pays ≈ 0.8 s once before verification.

## 5. Six contract exceptions — decisions and evidence (Part 4 §6)

Checker status unchanged: REVIEW REQUIRED, 15 × Rule 4 + 1 × Rule 5, 0 BLOCKED; nothing suppressed.

| # | File | Decision (2026-10-13) | Status |
|---|---|---|---|
| E1 | `pappy-core/src/pappy.ts` | **Require changes / additional evidence** — show the full training path for honest failures; segregate positive and negative; correct if needed | **Done — ready for reconsideration** (below) |
| E2 | `checks/workspaceVerification.ts` | **Approved** — downgrade and final-source rules intentional, preserved | closed |
| E3 | `checks/evidenceTerms.ts` | **Require changes** — lexical match is candidate evidence, not proof; add adversarial examples; no automatic VERIFIED without reliable evidence | **Done — ready for reconsideration** (below) |
| E4 | `checks/completeness.ts` | **Approved** — subordinate to the criteria ledger | closed |
| E5 | `checks/claimProof.ts` | **Approved** — partial-result honesty preserved | closed |
| E6 | `apps/runner/src/index.ts` | **Approved for Rule 5 only**; the runner's missing workspace guard to be documented and assessed separately, not accepted by this approval | closed as a Rule 5 exception; runner limitation in §10 |

**E1 — what was already enforced, what was missing, what changed.** Already enforced, now demonstrated end to end in `packages/orca-core/src/export/trainingPath.test.ts` through the production Pappy port (`createPappyPort`) and the real `exportTrainingData`: an honest, contradicted failure is verdict FAIL, evidence `contradicted`, eligibility `eligible`; every `contradicted` downgrade in `workspaceVerification.ts` (12 sites) carries a HIGH or CRITICAL issue, so such a run can never be PASS; the default export is the positive set (`verdict: 'PASS'`) and excludes the run by verdict before any tag is read; a FAIL export is an explicit request. **Genuine gap found and closed (`1b2b990`):** a FAIL record fell through to the WARN score of 7, which a score-based consumer could read as a decent success example. FAIL now scores 0 and every record carries `metadata.outcome` (`success` / `partial_success` / `honest_failure`); no Brain record is emitted for FAIL exports. A run whose account claims success against contradicting evidence is `rejected` (also tested). Segregation is therefore by verdict filter, by score and by an explicit label.

**E3 — what was already enforced, what was missing, what changed.** Already enforced: the 60 % rule applied only to a *changed* named file, so it could promote nothing without an on-disk change; training was protected because docs tasks carry no test evidence. Genuine gap: the rule could make a prose documentation criterion PROVED and the run **verified** from word overlap alone — a document using the requirement's words and stating the opposite would have been verified. **Changed (`4a951f1`):** lexical matching is candidate evidence. Only an identifier-anchored requirement whose identifiers the final content carries is PROVED; a prose requirement matched by words is PARTIAL with `candidate: "lexical"`, issue `RECEIPT_LEXICAL_CANDIDATE` (MEDIUM, needs human review), verdict WARN at best, status `unverified`, eligibility `needs_human_review`. Adversarial examples added as asked: unit (`workspaceVerification.test.ts`: terms present + opposite content → not verified; identifier-anchored → verified) and corpus (`docs-adversarial-matching-terms` → WARN/unverified/needs_human_review; `docs-anchored-genuine` → PASS/verified). `docs-genuine` relabelled with the registry entry stating this decision as the reason; corpus 47/47, 0 false acceptances, 0 false rejections; original suites unchanged. Nothing in Pappy's acceptance criteria, Moonshiner's positive eligibility or Miranda's authorization was weakened.

## 6. Ten false positives (Part 4 §7)

Unchanged and still reported by the checker: `checks/workspaceVerification.test.ts` (a test file) and the nine `checks/__fixtures__/find-fix/*` data files. None executes or decides anything at runtime; they are the evidence and corpus behind E1–E5.

## 7. Checklist accounting (Part 5)

Thirteen rows plus the override dialog (13b). `A` = automated witness through the DevTools port in phase 6.5; `H` = human presenter in phase 6.6.

| Id | Check | Expected | Observed | Witness | Status | Evidence | Remaining action |
|---|---|---|---|---|---|---|---|
| 1 | Startup, isolated profile | window, ready, scratch workspace | as expected (6.5); presenter saw the same window today | A, H | PASS | `shot-01`, screenshots 2026-10-13 | — |
| 2 | Provider configuration | Billing select; metered + price refuses | seeded settings took effect | A | PARTIAL | `shot-07` | H: change Billing in Settings and save |
| 3 | Approval presentation | tool, command, workspace, safe default, task binding | tool and command shown; workspace, binding missing; Approve primary (fixed after) | H | PARTIAL | screenshot 11 | H: inspect the fixed card once more |
| 4 | Approve / Deny | one approval = one execution; deny = none | six approvals → six executions, each approved first; deny → zero | H | PASS (Approve detail pending: clicks vs checkbox) | traces w4ul34, 8rc1b1; screenshots 12–16 | H: confirm six clicks |
| 5 | Approval timeout | auto-deny at 60 s | not performed (6.5 claim withdrawn) | — | PENDING | — | H: leave a card untouched 60 s |
| 6 | Stop during a model request | Stopping → Stopped, cancelled, no fallback | as expected after the 6.5 fix | A | PASS | `shot-03` | — |
| 7 | Stop while approval pending | CANCELLING, approval invalid, no execution | first attempt: Stop unreachable (defect, fixed); second: as expected via "Stop task" | H | PASS (card path); red-Stop variant PENDING | trace lb519c; screenshot 17 | H: red Stop with a card open |
| 8 | Task state badges | truthful; never green after Stop | `failed`, `cancelled` shown | A, H | PASS | screenshots | note: "Verdict FAIL" shown for a cancelled task |
| 9 | Brain fallback visibility | fallback line | "Planning fell back: Brain invalid_plan …" seen today | A, H | PASS | screenshots 7, 15 | — |
| 10 | Budget refusal display | refused before dispatch | as expected (6.5); mock not contacted | A | PASS | `shot-07` | — |
| 11 | Pappy verification result | fabricated claim → FAIL | `PROOF_CLAIM_UNVERIFIED` FAIL (6.5); today `REQUIRED_RECEIPT_MISSING` FAIL on the mock's thin answers | A, H | PASS | screenshots | — |
| 12 | Recovery after restart | init warning, run interrupted | as expected | A | PASS | `shot-04` | — |
| 13 | Workspace lock / banner | "still stopping"; banner | banner witnessed by the presenter today (13b) | A, H | PARTIAL | screenshots 4–5 | H: "still stopping" needs a slow non-cancellable tool |
| 13b | Override dialog | unsafe stated, unsettled listed, does not stop, default Cancel, explicit acknowledgement, not "safe" | all six confirmed | H | PASS | screenshot 5; protection file | — |

Totals: PASS 9 (1, 4, 6, 7, 8, 9, 10, 11, 12) + 13b; PARTIAL 3 (2, 3, 13); PENDING 1 (5), plus the row 7 red-Stop variant and the row 4 click detail.

## 8. Complete regression results (Part 6)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test`, idle host | **1,896 passed · 0 failed · 1 skipped** (orca-core 315, pappy-core 393, pappy-eval 150, miranda-core 236+1, workbench-core 63, desktop 292, runner 107, others unchanged; +5 since the preparation run: trainingPath 2, pappy-eval +2, guard recovery 1) |
| the same suite run concurrently with the type checks and evaluation jobs | one timing benchmark (`budget.test.ts` "reserves and settles thousands of requests in well under a second": 1.10 s vs the 1 s bound) failed under contention and passes alone; not a code change |
| Miranda authorization (236 + 1 skipped), desktop `toolAuthorization` / `llmGate` | pass |
| lifecycle / cancellation; workspace ownership / survivors; override accounting; worker dispatch | pass |
| Pappy suites | 23/23 · 12/23 · 15/23 · evidence **47/47** (FA 0/33, FR 0/11; `docs-genuine` relabelled by decision E3, two fixtures added) |
| Moonshiner eligibility / export (`exportTrainingData.test.ts`, `trainingPath.test.ts`) | pass |
| Brain / Maestro routing; budget / provider; desktop (292) | pass |
| tsc all packages + scripts; desktop bundle; renderer and validation scripts | 0 errors |
| contract checker | REVIEW REQUIRED, 15 × Rule 4 + 1 × Rule 5, 0 BLOCKED |

No evaluation expectation was changed to fit; the one relabel is by human decision and recorded as such.

## 9. Files modified and commit hashes (phase 6.6)

`777f100` scan coalescing + benchmark · `916ea7f` worker dispatch honours the lifecycle; override accounting tests · `d31de5c` staging script, checklist accounting · `e36362e` report, PROJECT_STATE · `d6871af` recovered protections announced · `1b2b990` export: FAIL = negative example (E1) · `4a951f1` lexical matching = candidate evidence (E3) · `79319ba` Stop reachable from the approval card · `f123144` mock worker command from the request · `a632931` docs · final docs/PROJECT_STATE commit: see `git log` (the commit after `a632931`).

## 10. Remaining operational risks (Task 3)

| Item | Classification |
|---|---|
| Row 5 (approval timeout), row 7 red-Stop variant, row 3 re-inspection of the fixed card, row 2 Settings edit, row 4 click detail | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL (witness pending; nothing indicates a defect) |
| E1 and E3 reconsideration | awaiting the human's decision on the changes made |
| **Runner CLI has no workspace guard** (E6 follow-up). The runner (`apps/runner`, `private: true`, not part of the desktop package) runs one task per process with tools enabled and `WORKSPACE_ROOT` from the environment; an interrupted CLI task drains ≤ 10 s, records survivors in the trace (`task.notes`, `workspace.unprotected`), but persists no protection, so a second CLI invocation in the same workspace is not refused. Assessment: write-capable CLI tasks are safe only for a developer who reads the trace; they are not releasable as a product surface without wiring `createWorkspaceGuard` (a file under `~/.orca`) into the runner — a small change, not made in this phase. | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL for the dev-only CLI; **RELEASE BLOCKER** if the CLI is distributed |
| Survivor scan is a lower bound; unrelated short-lived orphans can be flagged (released by verification within seconds); hosts without PowerShell / `ps` get "unknown" | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL |
| An external process that ignored the kill cannot be fenced; an override records that the user accepts it | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL |
| Safe-command allowlist (`echo`, read-only git, …) auto-approves by design | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL (documented; the human may want `requireApprovalForAll`) |
| Approve remains the visually prominent button; cancelled task badge reads "Verdict FAIL"; banner duplicates the start-up warning | POST-RELEASE IMPROVEMENT |
| Prices known only for Anthropic's API; no real-provider run on this branch | RELEASE BLOCKER for a public release (the rehearsal, §11) — not for source merge |

## 11. Live AI rehearsal plan (Task 4) — plan only; no paid request without separate authorization

1. **Isolation.** `launch-isolated.mjs --profile <new dir>`; disposable workspace = a fresh `git init` of the `find-fix` booking fixture (`packages/pappy-core/src/checks/__fixtures__/find-fix`, with `package.json` scripts.test = `node --test`); scratch `HOME`; no GitHub token; MCP servers off.
2. **Human initiation.** The presenter enters the Anthropic key in Settings for the session (removed afterwards), picks `claude-sonnet-5-5` (reviewed catalog price), sets Billing `metered`, confirms model access with the Settings "fetch models" action, and types every message.
3. **Budget.** Hard task budget **$0.50**, shown in the badge; first a $0.01 budget to witness a refusal before dispatch, then $0.50.
4. **The task.** "Users report a meeting cannot start exactly when the previous one ends. Fix the overlap check in src/bookings.js, run the tests, and do not modify the existing tests." Normal path Brain → Maestro → debugger → Miranda (approval for `npm test`) → Pappy.
5. **Completion criterion, objective.** `npm test` on the final source reports 8/8 (host-observed in the trace's `agent.tool.result`), `src/bookings.js` changed, test files unchanged; badge "completed and verified"; `training_eligibility=eligible evidence=verified` in the stored summary. The model's own statement counts for nothing.
6. **Cancellation scenario.** Second task: "Run `node -e "setTimeout(()=>{},60000)"` and report" — approve, press Stop at ~10 s: expect CANCELLING → CANCELLED (kill confirmed) or INTERRUPTED + protection; no output after Stop. Third: trigger an approval, press "Stop task" on the card: nothing runs, `cancelled`.
7. **Recovery.** Kill the app during a streaming reply; relaunch the profile; init warning with the exposure; nothing resumed.
8. **Reconciliation.** Compare the status line's confirmed figures with the Anthropic usage page for the key; `unreconciled` must be $0 when usage was reported; the cancelled request must show as an unreconciled upper bound.
9. **Evidence.** Keep `pipeline-traces/`, `budget-journal.json`, `workspace-protection.json`, the provider usage page, and a screenshot of every dialog, under a dated folder next to `RESULTS-2026-10-12.md`.
10. **Criteria.** PASS: every step as expected and the invoice matches the ledger within provider rounding. PARTIAL: a deviation without safety consequence (a label, a wording). FAIL: any request after Stop, any unverified run shown as verified, any approval taken without a click, any spend over the hard budget, any workspace write after INTERRUPTED without protection.

## 12. Production integration plan (Task 5 / Part 8)

- **References.** `integration/core-reliability` (HEAD in PROJECT_STATE) onto `origin/main` `7b62cce`; 50 commits; 140 files: source, tests, fixtures, docs, validation and profiling scripts only — no build output, installer, key, `.env`, Summit or staging asset, log, or personal path (checked by file list and by name).
- **Database.** `runs` + `cost_unreconciled_usd`, `cost_basis` (idempotent `ALTER TABLE`).
- **Settings.** New optional fields `budgetSource`, `pricing[]`, `providers[].billing`; existing files load unchanged. New userData files `budget-journal.json`, `workspace-protection.json`.
- **User-visible changes.** Evidence-less code changes fail with an evidence request; prose documentation tasks now need a human review (WARN) unless the requirement names an identifier; budget refusals and unreconciled costs shown; Stop answers at once and the next message waits for settlement; a workspace can stay protected after a task, released only by verification or a recorded override; approvals can be stopped from the card; surviving child processes protect the workspace; FAIL exports are labelled negative.
- **Contract.** E2, E4, E5, E6 (Rule 5) approved by the human on 2026-10-13; E1 and E3 changed and awaiting reconsideration; ten false positives recorded; checker unchanged.
- **Post-merge tests.** `pnpm -r test`, `pnpm contract:check:strict`, the four Pappy suites, `build-main.mjs`; then a packaged build and the checklist on it (new authorization).
- **Rollback.** Revert the merge commit; extra columns and files are inert for older code.
- **Release validation.** The live rehearsal (§11) and a packaged build are release gates after merge approval, each needing its own authorization.

## 13. Final readiness classification

**CONDITIONALLY READY**, for source merge into `main` once the human (a) reconsiders E1 and E3 on the evidence in §5, and (b) reports the pending witness items (row 5, the row 7 red-Stop variant, the row 4 click detail, and a look at the fixed approval card). No confirmed security, workspace-safety, cancellation, verification or budget defect is open: the three defects found by the presenter are fixed and witnessed or covered by tests. **Not ready for public distribution** until the live rehearsal (§11) and a packaged build pass; the runner CLI is a dev tool and must not ship without a workspace guard.
