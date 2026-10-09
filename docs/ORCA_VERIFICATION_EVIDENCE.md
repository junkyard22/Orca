# Orca verification evidence — design (core reliability, phase 2)

**Status:** implemented on `integration/core-reliability` (2026-10-09). Not merged.

## Why

Pappy judged work from the worker's own account: `outputText` (worker-authored), `filesChanged[].diff` (the content the worker said it wrote), and the existence of tool events. Rewriting a file with identical contents counted as a change, deleting a failing test counted as resolving it, and any successful tool call could "corroborate" an unrelated claim. The Summit rehearsal and the audit (`ORCA-CORE-RELIABILITY-AUDIT.md`) reproduced all three on production.

Two earlier implementations existed: 1.6.1's content snapshots with defect-fix rules, and the parallel branch's hash snapshots with criterion receipts (`ORCA_PARALLEL_WORK_COMPARISON.md`). This design takes the hash inventory, the test-run bracketing and the criterion-level receipts from the parallel line, and the test-content capture, the explicit test-integrity issues and the repair-pass receipt carry-over from 1.6.1. Neither was merged as-is.

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
  checks/workspaceVerification.ts ─ task-aware checks on the evidence
  pappy.ts ledger ──────────────── per-criterion receipt with evidence *strength*
  pappy.ts verdict ─────────────── unchanged rules (HARD_FAIL codes; HIGH/CRITICAL → FAIL; MEDIUM → WARN)
  pappy.ts verification ────────── evidence status (separate axis)
  pappy.ts eligibility ─────────── evidence-integrity gate (separate axis)
  pappy.ts confidence ──────────── unchanged heuristic, labelled `confidenceBasis: "heuristic"`
```

### Evidence the worker cannot author

| Fact | Source |
|---|---|
| A file really changed / was added / deleted | hash inventory diff (`changes[]`) |
| An identical rewrite is not a change | same hash → absent from `changes[]`; reported write → `NO_OP_WRITE` |
| Existing tests were weakened or deleted | `before`/`after` content of test files (`testShape()`), `TEST_FILE_DELETED`, `TEST_FILES_MODIFIED_WEAKENED`, `TEST_EDIT_PROHIBITED` |
| A test command really ran, and on which source | host-observed `testRuns[]` with `sourceState: baseline | final | intermediate` |
| Its outcome | parsed runner summary (`parseTestCounts`), `ok`, exit code — never the `ok` flag alone |
| The evidence is complete | `partial`/`available` flags; limits mark the inventory partial instead of truncating silently |

### Task kinds and what each must show

| Kind | Required | Not required |
|---|---|---|
| bugfix | real source change; full-suite run on the final source, passing; reproduction before the first source change *when the user asked for the problem to be verified as resolved* | reproduction otherwise (LOW note) |
| refactor | real source change; full-suite run on the final source, passing; suite not shrunk | — |
| feature | real source change; full-suite run on the final source when the project has tests | — |
| docs | a documentation change | tests; source changes are flagged MEDIUM |
| inspect | nothing changed | file changes are flagged MEDIUM |
| other | universal checks only | — |

Universal: tests intact, user restrictions (`forbidDeletes`, "do not modify the tests"), unrequested test/build configuration or lockfile changes (MEDIUM), reported no-op writes (LOW). Tests are expected when the request mentions them or the project declares a test command and code changed; a project without a test command is verified by the on-disk change only and is never training-eligible.

### Four states, kept apart

| Evidence status | Meaning | Effect |
|---|---|---|
| `contradicted` | evidence shows the work is wrong | HIGH/CRITICAL → FAIL; wording "Verification failed" |
| `unverified` | plausibly correct, not independently shown | HIGH → FAIL; wording **"Not verified (insufficient evidence)"** |
| `uninterpretable` | evidence present but unreadable | HIGH → FAIL; wording **"Not verified (evidence could not be interpreted)"** |
| `verified` | independent evidence supports the objective | PASS possible |
| `unavailable` | runtime could not capture evidence | HIGH for change tasks → FAIL |
| `not_applicable` | caller supplied no workspace evidence | legacy verdict rules; never training-eligible |

Mandatory evidence never becomes a warning-only success: insufficient required evidence is HIGH, not MEDIUM.

### Receipt strength (per acceptance criterion)

`direct` (the response text itself, for criteria about the response) › `independent` (runtime snapshot / host-recorded run) › `corroborated` (host-recorded tool output names the criterion's terms) › `self_reported` (worker text or reported diff only) › `none`.

When the runtime supplied workspace evidence, a required criterion whose only support is `self_reported` becomes `UNVERIFIED` (`REQUIRED_EVIDENCE_INSUFFICIENT`, HIGH). A successful tool call never corroborates an unrelated claim once runtime evidence exists. A "File must be…" criterion needs the file to differ on disk. A criterion that names a workspace file the runtime saw change gets an `independent` receipt that says the file changed, not that its content was judged.

### Training eligibility (Moonshiner)

Order: never-trainable codes → contradicted evidence + an account that presents the work as done → review codes → **no host evidence → never eligible** (PASS: `accepted_but_not_trainable`; else `needs_human_review`) → FAIL with insufficient evidence → `needs_human_review` → pattern codes → WARN → review → PASS eligible only when `verified` **and** a host-recorded test run passed. Honest failures the evidence confirms stay eligible.

### Confidence

Unchanged formula, unchanged number, now documented and labelled `confidenceBasis: "heuristic"`. It feeds nothing. The desktop no longer fabricates a value when Pappy did not run, and shows the number as "score N% (heuristic)" rather than "Confidence".

## Cost

Baseline inventory: one `git ls-files` (or walk) plus a hash of every file ≤ 25 MB, bounded at 60,000 files / 2 GB hashed (beyond that, `partial`). Refresh: a stat per file, re-hashing only files whose size or mtime changed. Fingerprints are taken synchronously when a test command's result is observed, so they cannot race the worker's next write. `captureMs` is reported in the evidence.

## Limitations

- A criterion the ledger cannot anchor (no backticked/camelCase/snake_case symbol, no named file, not about the output) is still `MISSING` — a pre-existing limitation, now visible as such.
- Reproduction is required only when the user asked for the problem to be verified as resolved; otherwise it is noted.
- Projects without a test command are verified by the on-disk change only.
- The eval corpus (`packages/pappy-eval`) supplies no workspace evidence, so its verdict metrics are unchanged while its training-eligibility expectations for evidence-less runs no longer match (closed loophole, reported, not redefined).
