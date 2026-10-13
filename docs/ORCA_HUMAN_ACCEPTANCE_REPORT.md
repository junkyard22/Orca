# Orca human acceptance report (core reliability, phase 6.6 — final closure)

**Dates:** 2026-10-12 (preparation) · 2026-10-13 (human checks, contract decisions, E1/E3 corrections, final closure) · **Branch:** `integration/core-reliability` (worktree `C:\Orca\worktrees\core-reliability`) · **Baseline:** `origin/main` `7b62cce` · **Previous report:** `docs/ORCA_FINAL_SAFETY_VALIDATION.md` · **Assessment:** **CONDITIONAL GO** for source merge (§13).

The presenter completed the desktop acceptance checks on the source build and decided the six contract exceptions. E1 and E3 required changes; both are made and tested, E3 in two rounds after the reviewer's `budgetedAdapter` case exposed a second path. Four presenter-found defects were fixed. Every human observation below is marked as such and separated from what the traces confirm.

## 1. Branch and HEAD

`integration/core-reliability`, HEAD in §9 (recorded at the final commit). Working tree clean. Nothing on `origin/main` is missing from the branch.

## 2. E3 adversarial results (Task 1)

**Vulnerability confirmed.** "Document that `budgetedAdapter` refuses unpriced models under a hard budget" with a document saying it *permits* them was PROVED / PASS / verified: the symbol-presence path (the identifier appears in a file the runtime saw change) ran before the named-file rule tightened in the first round. Five of the seven variations were accepted the same way; positive training was protected only because documentation tasks carry no test evidence.

**Correction (`5f137c6`, `requireSubstantiveEvidence` in `pappy.ts`).** A receipt proved only by an identifier's presence satisfies the criterion when the criterion asks for nothing but the mention. When it makes a substantive claim about the identifier, presence is candidate evidence for a human: PARTIAL, `candidate: "lexical"`, `RECEIPT_LEXICAL_CANDIDATE` (MEDIUM), WARN / `unverified` / `needs_human_review`, with the explanation "presence of `budgetedAdapter` cannot show that what is said about it (refuses, unpriced, models, hard, budget) is present and correct". A host-recorded run on the final source that covers the criterion verifies the behaviour, not the wording; the receipt stays a candidate and says which part is verified. No keyword rule claims to understand the sentence. Code-behaviour criteria of code-change tasks are untouched.

| Variation | Criterion | Verdict | Evidence status | Eligibility | Positive export |
|---|---|---|---|---|---|
| correct identifier, opposite claim | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded; also excluded from a WARN export |
| correct identifier, missing behaviour | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded |
| correct identifier, wrong number ($5.00 vs $0.50) | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded |
| correct identifier, misleading negation | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded |
| correct identifier, unrelated description | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded |
| correct identifier, genuinely correct wording | PARTIAL (candidate) | WARN | unverified | needs_human_review | excluded — indistinguishable by any keyword rule; a human reading verifies it |
| requirement asks only for a mention | PROVED | PASS | verified | accepted_but_not_trainable | excluded (no test evidence) |
| host run on the final source + contradicting document | PARTIAL (candidate; note: behaviour verified, wording not) | WARN | unverified | needs_human_review | excluded |
| bug fix proved by a full suite on the final source (E2 path) | PROVED | PASS | verified | eligible | unchanged |

Tests: `workspaceVerification.test.ts` "identifier presence is not a claim" (4 cases covering the table), the first-round docs/adversarial/anchored cases, `trainingPath.test.ts` (adversarial export). Corpus: `docs-anchored-genuine` relabelled with the reason in the registry, `docs-anchored-opposite-claim` and `docs-mention-only-genuine` added — 49/49, 0/33 false acceptances, 0/11 false rejections; original suites 23/23 · 12/23 · 15/23 unchanged. **Residual ambiguity:** Pappy cannot tell a correct substantive documentation statement from an incorrect one; it now says so and asks for a reader rather than guessing.

## 3. Contract review (Task 3)

| # | File | Human decision | Status after this phase |
|---|---|---|---|
| E1 | `pappy-core/src/pappy.ts` | Require changes / evidence (2026-10-13) | **Changes made (`1b2b990`): FAIL exports scored 0 with `outcome: honest_failure`; path demonstrated end to end. Awaiting the human's final confirmation.** |
| E2 | `checks/workspaceVerification.ts` | **Approved** | closed |
| E3 | `checks/evidenceTerms.ts` (and the presence path in `pappy.ts`) | Require changes (2026-10-13) | **Changes made in two rounds (`4a951f1`, `5f137c6`); evidence in §2. Awaiting the human's reconsideration.** |
| E4 | `checks/completeness.ts` | **Approved** | closed |
| E5 | `checks/claimProof.ts` | **Approved** | closed |
| E6 | `apps/runner/src/index.ts` | **Approved for Rule 5 only** | closed as a Rule 5 exception; the runner's missing workspace guard is tracked in §10 and is not covered by the approval |

Ten false positives (a test file, nine fixtures) remain visible in every checker run; the checker is unchanged: REVIEW REQUIRED, 15 × Rule 4 + 1 × Rule 5, 0 BLOCKED.

## 4. Desktop acceptance (Task 2) — human observations and trace confirmation

Environment as before: source build, isolated profile `profile-c`, local mock on `127.0.0.1:3939` with no outbound call, no DevTools port, no credentials, nothing of any installed Orca touched.

| Check | Presenter observed | Trace / files confirm | Result |
|---|---|---|---|
| 13b override dialog | all six required elements; pressed Cancel; banner stayed | protection intact after Cancel; sleeper ended only after an identity match; released by verification | **PASS** |
| Row 3 approval card (first card) | tool and command visible; no workspace line; no task binding; Approve highlighted | WAITING_FOR_APPROVAL before any execution | **PARTIAL** → card fixed (workspace line, "Stop task", Deny focused) |
| **Check A** fixed card | *not yet described by the presenter* | — | **PENDING (human)** |
| Row 4 Approve | "clicked Approve individually whenever each approval card appeared; did not select Always approve" | six approval waits, each settled before its own execution; six host-observed outputs | **PASS — six independent human authorizations** (Check B answered) |
| Row 4 Deny | two Denied cards; honest final reply | two `denied by user` results; zero executions | **PASS** |
| Row 5 approval timeout (Check C) | "timed out without interaction and Orca displayed Denied" | run `h9e6i0`: two 60 s waits (initial + repair pass), both auto-denied, zero executions, six ordinary model turns, no unapproved fallback, FAILED, worker reported "not approved, so it did not run" | **PASS** |
| Row 7 "Stop task" on the card | "Stopped — all operations settled.", task state cancelled | run `lb519c`: WAITING_FOR_APPROVAL → CANCELLING → CANCELLED, no execution, no model call after Stop | **PASS** |
| Row 7 global red Stop (Check D) | "card was visible when I clicked the global red Stop; it disappeared immediately; 'Stopped — all operations settled'; task state cancelled" | run `gry88j`: WAITING_FOR_APPROVAL → CANCELLING → CANCELLED in 1.6 s; one tool request, no result; three model calls all before Stop; app log "task:abort requested by user" | **PASS** |
| Cancelled task's panel | "displays FAIL / unknown instead of a distinct cancelled outcome" | renderer fallback summary labelled every non-ok result FAIL | **DEFECT, fixed (`b6b2319`)** — not yet re-witnessed |

Checklist accounting (13 rows + 13b): PASS 10 (1, 4, 5, 6, 7, 8, 9, 10, 11, 12) + 13b; PARTIAL 3 (2, 3, 13); PENDING: Check A (the fixed card) and the cancelled-panel re-check. Verbatim witness log: `scripts/desktop-validation/WITNESS-2026-10-13.md`.

## 5. Defects corrected in this closure

1. Stop unreachable while an approval was pending → "Stop task" on the card, auto-close on cancel, Deny focused, workspace shown (`79319ba`); witnessed via both paths.
2. Recovered protections not re-verified after a restart (`d6871af`).
3. FAIL training records scored like WARN (`1b2b990`, E1).
4. Identifier presence proved substantive documentation claims (`5f137c6`, E3) and 60 % word overlap proved prose claims (`4a951f1`, E3).
5. Cancelled task shown as "FAIL / ERROR Stopped." (`b6b2319`).

## 6. Full test results (Task 4)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test`, idle host | **1,903 passed · 0 failed · 1 skipped** (orca-core 316, pappy-core 397, pappy-eval 152, miranda-core 236+1, workbench-core 63, desktop 292, runner 107, others unchanged) |
| Pappy evidence corpus | **49/49**, 0/33 false acceptances, 0/11 false rejections (relabels: `docs-genuine`, `docs-anchored-genuine`, each with the human decision as reason; before/after in `docs/ORCA_EVIDENCE_CORPUS.md`) |
| Original Pappy suites | 23/23 · 12/23 · 15/23 — unchanged |
| Moonshiner export: positive and negative (`exportTrainingData.test.ts`, `trainingPath.test.ts`) | pass |
| Miranda authorization (236 + 1 skipped); desktop approval / cancellation / dispatch; Brain and Maestro routing; budget and provider | pass |
| tsc all packages + scripts; desktop bundle; renderer and validation scripts | 0 errors |
| contract checker | REVIEW REQUIRED, 15 × Rule 4 + 1 × Rule 5, 0 BLOCKED |
| Timing-sensitive test investigated | `budget.test.ts` "reserves and settles thousands of requests in well under a second" asserts < 1,000 ms for 5,000 reserve+settle. Five isolated runs: 402, 364, 375, 355, 348 ms. It failed once at 1,104 ms only while the full suite ran concurrently with the type checks and evaluation jobs. Stable in isolation and in the sequential suite; bound left unchanged. |

No fixture label was changed to improve a score; both relabels follow a human decision and keep the before/after on record.

## 7. Outstanding release risks

| Item | Classification |
|---|---|
| Human confirmation of E1 and reconsideration of E3 | decision pending |
| Check A (fixed card appearance) and the cancelled-panel re-check | PENDING witness (optional: both fixes are covered by the renderer syntax check and the desktop suite, not by a human eye yet) |
| Runner CLI without a workspace guard (E6 follow-up) | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL for the dev-only CLI; RELEASE BLOCKER if the CLI is distributed |
| Pappy cannot judge substantive documentation wording; such tasks need a human reader or an identifier-only requirement | ACCEPTED LIMITATION (by decision E3) |
| Survivor scan is a lower bound; unrelated short-lived orphans can be flagged; hosts without PowerShell / `ps` get "unknown" | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL |
| External processes that ignored the kill cannot be fenced; an override records the accepted risk | ACCEPTED LIMITATION — AWAITING HUMAN APPROVAL |
| Safe-command allowlist auto-approves by design | ACCEPTED LIMITATION (documented; `requireApprovalForAll` exists) |
| Approve remains the visually prominent button; banner duplicates the start-up warning | POST-RELEASE IMPROVEMENT |
| No real-provider run on this branch; prices known for Anthropic's API only | RELEASE GATE (rehearsal plan in `ORCA_HUMAN_ACCEPTANCE_REPORT` of 2026-10-12 §11, unchanged) |

## 8. Integration assessment (Task 5)

- **Source merge into `main`: CONDITIONAL GO.** Every deterministic safety check passes, the human desktop acceptance is complete except one optional re-inspection, and no verification, authorization, cancellation, workspace-safety or budget defect is open. It becomes **GO** when the human confirms E1 and approves E3; nothing else blocks the merge request. GO is a request for human merge authorization, not a merge.
- **Supervised real-provider rehearsal:** ready to be authorized separately (plan unchanged); not run.
- **Packaging and distribution:** not ready — requires the rehearsal, a packaged build with the checklist run on it, and a decision on the runner CLI.

## 9. Commits (phase 6.6 and closure)

`777f100` scan coalescing · `916ea7f` worker dispatch, override accounting · `d31de5c` staging, accounting · `e36362e` report · `d6871af` recovered protections announced · `1b2b990` E1 export labels · `4a951f1` E3 round one · `79319ba` Stop from the approval card · `f123144` mock harness · `a632931` docs · `71d8e5c` closure docs · `4fa972d` witness log · `5f137c6` E3 round two · `136aaf6` docs · `b6b2319` cancelled-task panel · `dc47c2a` witness log · `5288189` final closure docs (HEAD).

## 10. Exact remaining human decisions

1. **E1:** confirm approval of the honest-failure export correction (evidence §3; `trainingPath.test.ts`).
2. **E3:** approve, reject or require further changes on the two-round correction (evidence §2).
3. **Accept or reject** the limitations marked AWAITING HUMAN APPROVAL in §7, in particular the runner CLI gap.
4. **Optional witness:** the fixed approval card (Check A) and the cancelled-task panel, on the relaunched app.
5. **Separately, later:** authorize the real-provider rehearsal; authorize a packaged build.
