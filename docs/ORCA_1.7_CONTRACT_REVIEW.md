# Orca 1.7.0 — Contract Review for the Release PR

Branch `fix/release-stabilization-1.7.0` against `origin/main` (`c0b1092`). `pnpm contract:check:strict` exits 0 with **REVIEW REQUIRED**. It reports 13 findings: Rule 6 for one file and Rule 4 for twelve. It also lists 59 changed files. This document records each finding and each behaviour-relevant change outside the checker's patterns. The checker itself is unchanged, and no finding was silenced.

**Disposition key:**
- **Approved earlier:** the human approved this exception in a previous decision, which is cited.
- **Authorized by brief:** the change was asked for in the stabilization or final-review brief. It still needs the reviewer's approval at merge.
- **For review:** a new item awaiting the human decision.

## Rule 6 — system contract documents

| | |
|---|---|
| **File** | `docs/ORCA_SYSTEM_CONTRACT.md` (+2 paragraphs, no deletions) |
| **Behaviour** | It adds two rules. **The approval rule:** one answer settles one pending request, for the running task, the tool, the exact command and the task's workspace. An early answer is not counted. There is no session or persisted approval. **The acceptance-contract rule:** one contract per task, made of the user's goals plus related Brain criteria; unrelated criteria are advisory. |
| **Why flagged** | Any change to a contract document is Rule 6. |
| **Weakens a guarantee?** | No. Both rules add obligations that did not exist. No existing rule is removed or reworded. |
| **Tests** | `apps/desktop/src/approvalBroker.test.ts` (12) and `packages/orca-core/src/acceptanceContract.test.ts` (7) enforce the stated behaviour. |
| **Limitations** | The text describes the desktop host. The runner CLI has no approval UI. |
| **Disposition** | Authorized by brief. **For review:** the wording now matches the final-review corrections (workspace binding, early click pending, advisory criteria). |

## Rule 4 — Pappy QC behaviour

### 4a. Code-change criteria decided by host behavioural evidence

| | |
|---|---|
| **Files** | `packages/pappy-core/src/pappy.ts` (`9c59dce`); `checks/behaviouralCriteria.test.ts`; `checks/__fixtures__/parse-fix/*` (real `parse.js` before and after a fix, plus test outputs) |
| **Behaviour** | For a code-change task, a criterion is proved by a host-recorded test or validation run on the final source that exercises it. The criterion's words no longer have to appear inside the changed file. |
| **Why flagged** | Pappy verdict logic and fixtures. |
| **Weakens a guarantee?** | No. A3's genuine fix was falsely rejected, and the proof now comes from stronger evidence. Weakened tests, stale runs and subsets are still refused (fixtures `parse.test.weakened`, `base_subset`). Documentation criteria keep the E3 rules in every task kind, which closes a false acceptance that predates this branch. |
| **Tests** | `behaviouralCriteria.test.ts`, `fileMismatch.test.ts`. Evidence corpus 60/60 (0 of 40 false acceptances, 0 of 14 false rejections). |
| **Limitations** | It depends on the host's own record. A run the host did not observe proves nothing. |
| **Disposition** | **Approved earlier.** The human approved this as a narrowly scoped Rule 4 exception (Decision 1, after the Pappy behavioural-evidence correction). |

### 4b. A bug-fix criterion that names no file

| | |
|---|---|
| **Files** | `packages/pappy-core/src/pappy.ts` (`3d144b5`); `checks/filelessDefectCriterion.test.ts`. `packages/pappy-eval/src/evidence/fixtures.ts` gains 2 fixtures, additions only. |
| **Behaviour** | A criterion such as "The failing test is fixed" refers to a defect and states it is resolved, but names no file. It is proved only when all of these hold: a source change exists; there is a reproduction or `regression_test` receipt; that receipt ran on the final source fingerprint; and the run passes. |
| **Why flagged** | Pappy verdict logic. |
| **Weakens a guarantee?** | No. Before this change such a criterion could never be proved, which caused A7's first FAIL. The new rule requires *more* than the anchored rule: a reproduction, not just any test run. Without a source change it stays unproved. A stale fingerprint, an unrelated or partial run, or no reproduction keeps it MISSING (negative fixture `parse-insufficient-a7-contract-fileless-no-reproduction`). Documentation criteria are unaffected. Moonshiner eligibility still depends on a PASS that is verified on the first attempt. |
| **Tests** | `filelessDefectCriterion.test.ts` (7: positive, no source change, stale fingerprint, unrelated test, partial suite, docs unaffected, no reproduction); corpus fixtures, one positive and one negative. |
| **Limitations** | The defect is recognised by phrasing patterns (`REFERS_TO_DEFECT` / `DEFECT_RESOLVED`). A criterion phrased unusually stays unproved, which errs toward FAIL. |
| **Disposition** | Authorized by the stabilization brief. **For review:** this is a new Rule 4 change made after Decision 1. It needs the reviewer's explicit approval at merge. |

### Rule 4 confirmations

- **Pappy FAIL is never overridden.** The only added verdict assignment outside Pappy is Miranda's constraint gate, which sets an AHP packet's verdict. It was moved unchanged from `main.ts` to `workerConstraints.ts`.
- **Miranda's `afterQC` is unchanged.** No `miranda-core` file changes on this branch.
- **The repair classification** (`orca-core/repairClassification.ts`) does not dispatch a worker repair for a FAIL that only incomplete evidence or a refused approval caused. The verdict stays FAIL, and the run is reported as not verified.

## Outside the checker's patterns (behaviour-relevant)

### Acceptance contract — `packages/orca-core/src/acceptanceContract.ts`, `helpers.ts`, `runtime.ts`, `repairLoop.ts`, `types.ts`

| | |
|---|---|
| **Behaviour** | One contract per task, fixed after the first pass: the user's goals first and never dropped, then the Brain criteria that relate to the request. Every verdict (initial, audit, repair) and the repair spec use it. **Final-review correction (`bbb4ee8`):** a Brain criterion that shares no file, distinctive term or verification activity with the request is recorded as `advisoryCriteria` and is not judged. |
| **Why reviewed** | It changes which goals Pappy judges (the brief's item A). |
| **Weakens a guarantee?** | No. User requirements can no longer be displaced: before this branch, Brain's criteria *replaced* the user's goals on the first pass. The relevance filter applies only to Brain additions, never to user goals. |
| **Tests** | `acceptanceContract.test.ts` (7): authority of user goals; advisory filtering; Pappy sees only the user goal when Brain invents an unrelated one; one contract across passes; Brain fallback; cancellation. |
| **Limitations** | Relevance is lexical. A relevant Brain criterion with no shared term becomes advisory (traced). The user's goal is still judged, so this cannot turn a FAIL into a PASS for the user's own requirement. |
| **Disposition** | Authorized by brief. **For review.** |

### Approval broker — `apps/desktop/src/approvalBroker.ts`, `main.ts`, `preload.ts`, `renderer/app.js`, `renderer/index.html`

| | |
|---|---|
| **Behaviour** | **Before:** the renderer's "Always approve run_command this session" list answered later cards itself, which happened in A7. **Now:** the main process owns every request. An approval is accepted only when all of these hold: the id is pending; the task that asked is still running; the tool and exact command match what the card showed; the workspace matches the one captured at task start (`ee1e100`); and the approval arrives no sooner than 400 ms. An earlier approval is **not counted and the request stays pending** (`ee1e100`). Deny, timeout (60 s), Stop and restart settle as not approved. The checkbox and the session list are gone. There is no persisted approval state and no other answer path: one `approveToolCall` call site, guarded by a test. |
| **Why reviewed** | It changes the authorization model (the brief's item C). |
| **Weakens a guarantee?** | No, it is strictly stronger. The timing rule is a backstop only. The binding to one pending request is the authorization, and the backend enforces it whatever the renderer sends. |
| **Tests** | `approvalBroker.test.ts` (12): exact command; early click stays pending; fast human click succeeds; workspace mismatch refused; deny and timeout; Stop and late approval; task not running; restart; tool binding; settlement reporting; two static renderer guards. |
| **Limitations** | The renderer is trusted application code. A compromised renderer could wait 400 ms and echo the card's values. Distinguishing a human from compromised app code needs OS-level UI and is out of scope. The workspace is captured when the task starts, so changing settings mid-task does not move the task. |
| **Disposition** | Authorized by brief. **For review.** |

### Host record, provenance and narration — `packages/orca-core/src/hostRecord.ts`, `apps/desktop/src/narrationReview.ts`, `packages/claire-core/*`

| | |
|---|---|
| **Behaviour** | Repair passes receive the host's record of earlier passes. Final text and Claire's reply are checked sentence by sentence. A statement that the change came from outside, was already present or came from an earlier session, when the host recorded it in this task, gets one appended correction. Quoted text is excluded. When the evidence is incomplete, nothing is attributed. |
| **Why reviewed** | It changes user-facing narration (the brief's item D). |
| **Weakens a guarantee?** | No. The change only adds corrections; it never removes or rewrites user-visible text, and it never invents an origin. |
| **Tests** | `hostRecord.test.ts` (17); `workerEditProtocol.test.ts` (narration cases). |
| **Limitations** | It recognises common phrasings only. |
| **Disposition** | Authorized by brief. |

### Worker protocol, survivor attribution, redirection parsing

These come from `fix/worker-edit-protocol` and `fix/process-attribution`, both already reviewed. Pushing and opening a PR were approved earlier (Decision 2), and they are carried here unchanged. **Disposition:** approved earlier.

## Summary for the reviewer

No finding weakens Miranda, Pappy or Moonshiner. Two Rule 4 items need the reviewer's explicit merge approval:

- **4a**, already approved;
- **4b**, new.

There is also the Rule 6 wording. The contract, broker and provenance changes are disclosed above. No new contract exception was created during this final review: `bbb4ee8` and `ee1e100` touch no checker-flagged file other than the Rule 6 doc wording.
