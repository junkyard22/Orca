# Orca verification evidence — design (core reliability, phases 2 and 2.5)

**Status:** implemented on `integration/core-reliability` (phase 2: 2026-10-09; phase 2.5 behavioural verification: 2026-10-12). Not merged.

## Why

Pappy judged work from the worker's own account: `outputText` (worker-authored), `filesChanged[].diff` (the content the worker said it wrote), and the existence of tool events. Rewriting a file with identical contents counted as a change, deleting a failing test counted as resolving it, and any successful tool call could "corroborate" an unrelated claim. The Summit rehearsal and the audit (`ORCA-CORE-RELIABILITY-AUDIT.md`) reproduced all three on production.

Phase 2 replaced the account with runtime evidence. Phase 3's investigation then showed the remaining gap: a change that the runtime *confirmed* was being labelled "verified" — a bug fix, feature or refactor with no test command passed on the on-disk change alone, a feature passed on a suite that never ran the new code, a documentation change passed on the file having changed. Phase 2.5 closes that gap with one principle: **Pappy establishes what the evidence proves — not what the worker claims, what files changed, or what commands executed.** A confirmed file modification proves a file changed. It does not prove a bug is fixed, a feature works or a refactor preserved behaviour.

Two earlier implementations existed: 1.6.1's content snapshots with defect-fix rules, and the parallel branch's hash snapshots with criterion receipts (`ORCA_PARALLEL_WORK_COMPARISON.md`). This design takes the hash inventory, the test-run bracketing and the criterion-level receipts from the parallel line, and the test-content capture, the explicit test-integrity issues, the repair-pass receipt carry-over and the "Alternative verification:" convention from 1.6.1. Neither was merged as-is.

## Architecture

```
runtime (orca-core/src/workspaceEvidence.ts)
  task start ──► inventory: path → {size, mtime, sha256, kind, content for test/config files}
                 (git ls-files honours ignores; else a walk skipping node_modules/dist/…)
  every trace ──► tool.result for a test command ──► fingerprint non-test source NOW (sync)
  each QC    ──► refresh inventory (re-hash only files whose size/mtime changed)
                 ──► WorkspaceEvidence { changes[], testRuns[ sourceState ], testCommand, partial?, captureMs }
                 + priorToolEvents (receipts of earlier passes)
pappy-core
  checks/workspaceVerification.ts ─ task-aware checks on the evidence → issues + behavioural receipts
  checks/evidenceTerms.ts ───────── ties a receipt to a requirement by what it names
  pappy.ts ledger ──────────────── per-criterion receipt with evidence strength and an assessment
  pappy.ts verdict ─────────────── unchanged rules (HARD_FAIL codes; HIGH/CRITICAL → FAIL; MEDIUM → WARN)
  pappy.ts verification ────────── evidence status (separate axis)
  pappy.ts eligibility ─────────── evidence-integrity gate (separate axis)
  pappy.ts evidenceRequests ────── what is still missing, per requirement (descriptive only)
  pappy.ts confidence ──────────── unchanged heuristic, labelled `confidenceBasis: "heuristic"`
orca-core/src/adapters/pappyPort.ts ─ writes eligibility, evidence status and test-evidence tags into the persisted summary
orca-core/src/export/exportTrainingData.ts ─ requires those tags itself before exporting
```

### Evidence the worker cannot author

| Fact | Source |
|---|---|
| A file really changed / was added / deleted | hash inventory diff (`changes[]`) |
| An identical rewrite is not a change | same hash → absent from `changes[]`; reported write → `NO_OP_WRITE` |
| Existing tests were weakened or deleted | `before`/`after` content of test files (`testShape()`), `TEST_FILE_DELETED`, `TEST_FILES_MODIFIED_WEAKENED`, `TEST_EDIT_PROHIBITED` |
| A test command really ran, and on which source | host-observed `testRuns[]` with `sourceState: baseline | final | intermediate` |
| Its outcome | parsed runner summary (`parseTestCounts`), `ok`, exit code — never the `ok` flag alone |
| A non-test command ran after the last change, and what it printed | host-recorded tool events in order, with `_outputForProof` / `_exitCodeForProof` |
| The final content of a changed document | `after` content of changed docs files |
| The evidence is complete | `partial`/`available` flags; limits mark the inventory partial instead of truncating silently |

### Behavioural receipts

For code work the workspace checks produce **behavioural receipts** — what the host recorded on the final source that shows behaviour, not just a change:

| Receipt | What it is | Speaks for |
|---|---|---|
| `reproduction` | a run on the task-start source showed failures that the final full run passes; or a documented command that gave a different/failing result before the source changed and passes after | the whole task |
| `regression_test` | a test file added on disk (or an existing one with more cases/assertions, never fewer) that the final suite executed | the criteria it names |
| `full_suite` | the full suite passing on the final source, count not dropped | the whole task for bug fixes and refactors; only the criteria it names for features |
| `validation_command` | an "Alternative verification: …" / "Verified by: …" line in the account naming a command that ran after the last change, exited 0, produced output, and whose output is about the request (names its identifiers or ≥ 2 of its distinctive terms; file names do not count) | the whole task |
| `build_check` | a build or type check (`tsc`, `npm run build`, `cargo check`, `go vet`, `mypy`, …) after the last change, exit 0 | the whole task, for a refactor in a project with no tests; `REFACTOR_RUNTIME_EQUIVALENCE_NOT_SHOWN` (LOW) records that runtime behaviour was not tested |
| `final_content` | a changed document whose final content covers the request's terms | the whole task (docs) |

A receipt is **relevant** to a criterion when it covers the task or its text (command, output, content of the tests that ran) names the criterion's identifiers or its distinctive words (`evidenceTerms.ts`). An unrelated successful command never corroborates a behavioural claim.

### Task kinds and what each must show

| Kind | Required | Not required / notes |
|---|---|---|
| bugfix | real source change; **and** behavioural evidence the defect is resolved: reproduction + passing full suite (when the user asked for the problem to be verified as resolved), a passing full suite on the final source (otherwise; `FIX_REPRODUCTION_MISSING` LOW), or — only when the project has no test command and the request does not ask for tests — a documented, recorded, relevant alternative verification (`FIX_BEHAVIOUR_EVIDENCE_MISSING` otherwise) | a source edit alone never satisfies the behavioural requirement |
| refactor | real source change; full suite passing on the final source, suite not shrunk; without a test command: a build/type check or documented equivalence check after the change (`REFACTOR_BEHAVIOUR_EVIDENCE_MISSING` otherwise) | a type check never stands in for a suite the project has or the request names |
| feature | real source change; full suite passing on the final source when the project has tests; **and** something that exercises the requested functionality — a test naming it (added or in the final suite's output) or a documented validation command (`FEATURE_BEHAVIOUR_EVIDENCE_MISSING` otherwise) | the presence of a function, class, file or keyword is not proof the feature works |
| docs | a documentation change whose **final content** covers the request's distinctive terms (`DOCS_CONTENT_MISSING`, `DOCS_CONTENT_UNREADABLE`) | tests; source changes are flagged MEDIUM |
| inspect | nothing modified; the response's claims must have receipts | a real modification is `contradicted` (`INSPECT_UNREQUESTED_CHANGE`, HIGH) |
| other | universal checks only | — |

Universal: tests intact, user restrictions (`forbidDeletes`, "do not modify the tests" — a prohibition, which does not count as a request for a test run), unrequested test/build configuration or lockfile changes (MEDIUM), reported no-op writes (LOW). Tests are expected when the request mentions them (outside a prohibition) or the project declares a test command and code changed.

### Four states, kept apart

| Evidence status | Meaning | Effect |
|---|---|---|
| `contradicted` | evidence shows the work is wrong | HIGH/CRITICAL → FAIL; wording "Verification failed" |
| `unverified` | plausibly correct, not independently shown | HIGH → FAIL; wording **"Not verified (insufficient evidence)"** |
| `uninterpretable` | evidence present but unreadable | HIGH → FAIL; wording **"Not verified (evidence could not be interpreted)"** |
| `verified` | independent evidence supports the objective | PASS possible |
| `unavailable` | runtime could not capture evidence | HIGH for change tasks → FAIL |
| `not_applicable` | caller supplied no workspace evidence | legacy verdict rules; never training-eligible |

Mandatory evidence never becomes a warning-only success: insufficient required evidence is HIGH, not MEDIUM. The absence of a requested term in a document's final content is treated as insufficient proof (keyword matching is not proof of incorrectness); a failing test on the final source is a contradiction.

### Criterion ledger (per acceptance criterion)

Strength: `direct` (the response text itself, for criteria about the response) › `independent` (runtime snapshot / host-recorded run) › `corroborated` (host-recorded tool output names the criterion's terms) › `self_reported` (worker text or reported diff only) › `none`.

With workspace evidence, every required criterion carries an **assessment**: what it requires, what observable evidence would satisfy it, which runtime evidence supports it, whether that is relevant and sufficient, what contradicts it, and what is still needed. Rules:

- a required criterion whose only support is `self_reported` → `UNVERIFIED` (`REQUIRED_EVIDENCE_INSUFFICIENT`, HIGH);
- a code-behaviour criterion (a symbol, an implementation, tests, a parameter) is `PROVED` only when its implementation is on disk **and** a relevant behavioural receipt exists; an implementation with no receipt → `PARTIAL` (`RECEIPT_PARTIAL`, **HIGH** when workspace evidence was supplied; MEDIUM for legacy callers);
- a "File must be…" criterion needs the file to differ on disk; a criterion naming a document needs the document's final content to carry the criterion's terms (`PARTIAL` with `contradictedBy` otherwise);
- a `PARTIAL`, `MISSING` or `UNVERIFIED` required criterion, or a claim in the account with no receipt, keeps the status at `unverified`;
- once the runtime's own evidence has proved every goal-derived criterion with an independent, corroborated or direct receipt, the keyword stand-ins (`COMPLETENESS_GOAL_COVERAGE`, `COMPLETENESS_MISSING_DOMAIN_TERMS`) are dropped; legacy callers keep them.

### Evidence requests

`PappyResult.evidenceRequests` lists, per unmet requirement, what the evidence already establishes, what is missing and the action that would supply it (for example: "criterion symbol(s) cancelBooking present in files the runtime saw change. Required evidence is missing: a test or validation run on the final source that exercises cancelBooking. Provide it and report the observed result."). It is descriptive: Pappy runs nothing, fabricates no receipt and starts no repair. The runtime records it in the `qc.run.result` trace. Using it for targeted evidence collection instead of a full repair pass is a future orchestration design, not part of this phase.

### Training eligibility (Moonshiner)

Order: never-trainable codes → **contradicted evidence: excluded by default** — an account that acknowledges the failure without presenting the work as done stays `eligible` (honest failure); one that acknowledges it and also claims success, or says nothing either way, or is empty → `needs_human_review`; one that presents the work as done → `rejected` (no keyword list is needed to keep a fabricated run out) → review codes → **no host evidence → never eligible** (PASS: `accepted_but_not_trainable`; else `needs_human_review`) → FAIL with insufficient or unreadable evidence → `needs_human_review` → pattern codes → WARN → review → PASS eligible only when `verified` **and** a host-recorded full test run passed on the final source. A run verified by an alternative command or a build check is accepted but not trainable.

The export (`exportTrainingData.ts`) enforces this independently of Pappy's word: a run is exported only when its persisted summary carries `training_eligibility=eligible` **and** `evidence=verified|contradicted`. No tag, an older tag format, a run that skipped Pappy ("ok"), or evidence that was absent, unavailable, insufficient or unreadable is skipped with a named reason. The default export takes PASS runs only, so an honest failure (FAIL + eligible) is excluded unless FAIL runs are requested. Automated retraining is not wired.

### Worker guidance

The desktop appends verification goals to the worker's prompt per task kind (`apps/desktop/src/verificationGuidance.ts`): reproduce, re-run the suite, or document "Alternative verification: <command>" for bug fixes; add a test with assertions or a documented validation for features; run the suite before and after (or a build/type check) for refactors; write the content into the document for docs. Goals only — acceptance criteria and AHP packets are unchanged, and Pappy judges the evidence regardless.

### Confidence

Unchanged formula, unchanged number, documented and labelled `confidenceBasis: "heuristic"`. It feeds nothing.

## Cost

Baseline inventory: one `git ls-files` (or walk) plus a hash of every file ≤ 25 MB, bounded at 60,000 files / 2 GB hashed (beyond that, `partial`). Refresh: a stat per file, re-hashing only files whose size or mtime changed. Fingerprints are taken synchronously when a test command's result is observed; non-test commands are not fingerprinted — a validation command is placed by its position after the last recorded mutation. Phase 2.5 adds no workspace rescans; its checks read the evidence already captured. On this repository (423 files): baseline 184 ms, stat-only refresh 76 ms, fingerprint 73 ms, collect 70 ms; Pappy's evaluation itself averages 0.6 ms per run over the 45 evidence fixtures.

## Limitations

- Relevance is lexical: a receipt is tied to a criterion by the identifiers and distinctive words it names. A validation command whose output is about the request but uses none of its words will be judged irrelevant (and the request will say so); a test named after the criterion but asserting something else will be accepted as relevant if its assertions pass — the suite's own correctness is not judged.
- A documented alternative verification is checked for recording, timing, exit status, output and relevance, not for sufficiency in any semantic sense; a run verified this way is never training material.
- Documentation is checked for the request's distinctive terms in the final content; paraphrases are missed (reported as insufficient evidence, never as a contradiction).
- A criterion the ledger cannot anchor (no symbol, no named file, not about the output) is still `MISSING` — a pre-existing limitation, now visible as such.
- Non-test commands carry no host source-state fingerprint; their placement relies on the ordered tool trace.
- The eval corpus (`packages/pappy-eval`) supplies no workspace evidence, so its verdict metrics are unchanged while its training-eligibility expectations for evidence-less runs no longer match (closed loophole, reported, not redefined).

## Candidate evidence (phase 6.6, contract decision E3)

Lexical matching of a named file's final content is **candidate evidence**, not proof, for requirements that need semantic judgment. The ledger keeps two paths apart:

- **Identifier-anchored requirement** ("docs/booking.md must document `overlaps` …"): the changed file's final content must carry every identifier named — a checkable receipt; `PROVED`, strength independent.
- **Prose requirement** ("docs/booking.md must document the back-to-back booking rule"): word overlap (`textCoversRequirement`, ≥ 60 % of the distinctive words) only shows the document is *about* the requirement. The receipt is `PARTIAL` with `candidate: "lexical"`, the issue is `RECEIPT_LEXICAL_CANDIDATE` (MEDIUM, "needs human review"), the verdict is WARN unless something else fails, the verification status is `unverified`, and training eligibility is `needs_human_review`. A document that uses the requirement's words and says the opposite reaches exactly the same state — never `verified`.

Nothing here automates a VERIFIED outcome; the way to a verified documentation task is an identifier-anchored requirement, a documented validation command, or a human reading. Tests: `workspaceVerification.test.ts` ("documentation is verified against the final content on disk …", adversarial and anchored cases), corpus fixtures `docs-genuine` (relabelled), `docs-adversarial-matching-terms`, `docs-anchored-genuine`.

## Training path for honest failures (phase 6.6, contract decision E1)

Demonstrated end to end (`packages/orca-core/src/export/trainingPath.test.ts`, through the production Pappy port and the real export): an honestly reported failure that the evidence contradicts is verdict FAIL, evidence `contradicted`, eligibility `eligible` (the honesty rule). Every `contradicted` downgrade in `workspaceVerification.ts` travels with a HIGH or CRITICAL issue, so a contradicted run can never be PASS. The export's default is the positive set (`verdict: 'PASS'`), from which the run is excluded by its verdict before any tag is read; a FAIL export is an explicit request, and its records are now labelled as negative examples — `score: 0` (previously the WARN score 7 by fallthrough) and `metadata.outcome: "honest_failure"` — with no PASS-tagged Brain record beside them.

## Identifier presence is not a claim (final acceptance, E3 second round, 2026-10-13)

The reviewer's adversarial case — "Document that `budgetedAdapter` refuses unpriced models under a hard budget" against a document saying it *permits* them — was PROVED / PASS / verified through the symbol-presence path (the identifier appeared in a file the runtime saw change), as were a missing behaviour, a wrong number, a misleading negation and an unrelated description. Training was protected only because documentation tasks carry no test evidence.

Rule (`requireSubstantiveEvidence`, `pappy.ts`): a receipt proved only by an identifier's presence satisfies the criterion when the criterion asks for nothing but the mention ("docs/x.md must mention `foo`" — after removing identifiers and mention-words, no distinctive term remains). When the criterion makes a substantive claim about the identifier, presence is candidate evidence: PARTIAL with `candidate: "lexical"`, `RECEIPT_LEXICAL_CANDIDATE` (MEDIUM), WARN / `unverified` / `needs_human_review`, with the explanation "presence of `foo` cannot show that what is said about it (…) is present and correct". A host-recorded run on the final source that covers the criterion verifies the *behaviour*; the receipt stays a candidate and its note says the wording still needs a reader. Code-behaviour criteria of code-change tasks are governed by the behavioural rule and are untouched.

Outcomes (all through the real Pappy and, for the opposite claim, the real export):

| Document | Criterion | Verdict | Evidence | Eligibility | Positive export |
|---|---|---|---|---|---|
| opposite claim ("permits") | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded (also from a WARN export) |
| missing behaviour | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded |
| wrong number ($5.00 for $0.50) | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded |
| misleading negation ("does not refuse") | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded |
| unrelated description | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded |
| genuinely correct wording | PARTIAL, candidate | WARN | unverified | needs_human_review | excluded — no keyword rule can tell it from the others; a human reading or an identifier-only requirement is the way to verified |
| mention-only requirement, identifier present | PROVED | PASS | verified | accepted_but_not_trainable | excluded (not trainable: no test evidence) |
| bug fix proved by a full suite on the final source | PROVED | PASS | verified | eligible | unchanged |

Residual ambiguity, stated: Pappy cannot tell a correct substantive documentation statement from an incorrect one; it now says so instead of guessing. Tests: `workspaceVerification.test.ts` "identifier presence is not a claim" (4), `trainingPath.test.ts` (adversarial export), corpus `docs-anchored-genuine` (relabelled), `docs-anchored-opposite-claim`, `docs-mention-only-genuine`.
