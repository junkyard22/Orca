# Orca 1.7.0 — Worker Execution Protocol Investigation

**Date:** 2026-10-14 · **Branch:** `fix/worker-edit-protocol` (local, from `main` `c0b1092`; not pushed) · **Companion to:** `docs/ORCA_1.7_RELEASE_READINESS.md` (§16 lives on the unmerged `docs/1.7.0-final-report` branch; this record should be linked from it once both are merged).

**Question.** Why did the debugger never modify `src/parse.js` in three live attempts (A1, A2, A3) with `claude-sonnet-4-6`, although it read the file and had a concrete failing test?

**Answer in one line.** Orca forbade it. Every bug-fix worker carried a `no_file_writes` constraint because its objective ended "and run the tests"; Miranda refused all five `write_file` attempts the model made in A2 and A3. Three protocol defects then turned the refused edits into confusion: several tool calls per response executed with invented results kept in history, no statement of where tools run, and the evidence guidance never rendered. Fixed at source level. A separate, newly found **Pappy false rejection** means the corrected worker's genuine fix is still judged FAIL; that is an acceptance-standard decision, left to the human.

---

## 1. Branch and commits

| Commit | Content |
|---|---|
| `0ba3c2c` | fix(desktop): bug-fix workers may write; evidence guidance reaches the worker |
| `5d1ef89` | fix(desktop): worker loop runs one tool call per response and says where it runs |
| `bcb802a` | test(desktop): end-to-end worker edit protocol with real tools, runtime and Pappy (known Pappy gap recorded) |
| this document | docs commit on the same branch |

rc9 (`c0b10927`) is preserved unchanged in `C:\Orca\rc-artifacts\orca-1.7.0-rc9-c0b10927\`.

## 2. Root cause of the missing edits

**Primary (deterministic, blocking): `no_file_writes` on bug-fix workers.** `apps/desktop/src/main.ts` attached `{ rule: "no_file_writes", enforcer: "miranda" }` to a worker packet whenever `isCommandExecutionObjective(objective)` matched — a regex for "run the tests", "npm test", etc. The rehearsal objective "Fix the failing test in src/parse.js and run the tests." matched. The worker's prompt therefore said, a few lines apart, "**ACTION REQUIRED: Call write_file**" and "**Constraints: no_file_writes (miranda)**". The per-worker Miranda gate refused every `write_file`. The model noticed ("The constraint says no_file_writes but I must attempt to write the fix. Let me try write_file.") and was refused again. Phase 5 had already taught *routing* that "fix … then run the tests" is a fix (`requestsChanges`); this second copy of the rule, from Orca 1.2.8, had not been updated.

**Contributing protocol defects (confirmed in the traces):**

1. **Several tool calls per response, all executed, invented results kept.** The prompt says "Only ONE tool_call per response", but the loop executed every parsed call and stored the whole response as the assistant turn. The model wrote up to 22 calls per response, with invented `Result:` blocks between them — including a fabricated `parse.js` defining `parseQueryString`. It then ran `node -e "require('./src/parse').parseQueryString(...)"` against a function that never existed, and the invented content stayed in its context. A response containing calls *and* `FINAL ANSWER` could end the run with an answer written before any result existed (`tools_complete` early exit).
2. **Workspace semantics not stated.** The worker saw only "Workspace: project (C:\…\project)". It read "project" as a folder to enter: `project/src/parse.js` (A1: ENOENT everywhere → loop detection), `cd project && npm test` (failed: no such directory), and `cwd` set to the parent folder (refused by the workspace boundary).
3. **Evidence guidance never rendered.** `verificationGuidance()` ("before changing source, reproduce; fix the root cause; re-run the full suite") was appended to `agentTask.goals`, but packet-based workers render only the packet's inputs. A3's prompt had a single input: the workspace label.
4. **A proposed fix dispatched as a tool.** When the model answered with an inline `FIX:` code block, the code-fence fallback read `function parse(text) { … }` as a call to a tool named `function`.

**Not a cause:** tool availability (`write_file` was offered with a correct schema in all three runs), Miranda base authorization, sandbox, or approvals for writes.

## 3. Evidence from each live trace

| | A1 (rc4, `…_4suwkc`) | A2 (rc8, `…_93b7mn`) | A3 (rc9, `…_y032if`) |
|---|---|---|---|
| Constraint on the worker packet | `no_file_writes` (same objective; never reached a write) | `no_file_writes` | `no_file_writes` |
| `write_file` attempts | in the 2nd response's call list, never executed (loop detection stopped the run first) | **3, all blocked**: `AHP constraint violation: "no_file_writes" (enforcer: miranda)` | **2, both blocked**, same reason |
| Other refusals | — | 2 × `run_command` "Workspace boundary blocked" (cwd = parent folder) | 2 × same |
| Calls per response | 22 and 9 | 7, 10, 6, 8, 5 | 19, 9, 1 (`function`, unknown), 3 |
| Invented results in responses | yes (directory listings, file contents) | yes | yes (`parseQueryString` file content) |
| Path problems | `project/…` → ENOENT ×3 → loop detected | `project/src` resolved (path fix), `cd project` | `cd project`, cwd outside workspace |
| Approvals | — | 7 cards unanswered (human absent) | 2 approved |
| End | loop detected; FAIL | FAIL | budget refused (reservation $0.227 > remaining $0.189 at $0.45); FAIL |

**Correction to earlier reports.** The 2026-10-14 readiness report (§16.4/§16.6) and PROJECT_STATE item 1x said no `write_file` call existed in A2 and that the worker "substitutes `node -e` for `write_file`". Both are wrong: blocked calls are logged as `agent.tool.blocked`, not `agent.tool.call`, and the earlier analysis searched only the latter. The worker chose `write_file` five times; Orca refused it.

## 4. Was the editing tool available to the model?

Yes. `agent.run.start.tools` lists `read_file, write_file, run_command, list_directory, search_files` (plus connector tools) with correct schemas, and the task prompt's "Available Tools" section documents `write_file(path, content)`. Category: **tool selected but refused by Miranda** (constraint gate), not unavailable or mis-advertised.

## 5. Did Miranda block attempted edits?

Yes — all of them (A2: 3, A3: 2), via the per-worker AHP constraint gate enforcing `no_file_writes`. Miranda behaved as configured; the configuration was wrong for a bug fix.

## 6. Workspace and command path semantics (actual)

- File tools resolve relative paths against the workspace root (`resolveWorkspacePath`); since PRs #97/#98 a leading segment equal to the workspace folder's name (or the bare name) resolves to the root when no such subfolder exists.
- `run_command` runs with `cwd` = workspace root when `cwd` is unset; a `cwd` outside the root is refused by the workspace-boundary gate. `cd <workspace-name>` inside the command string fails because the shell is already there. Orca does not rewrite command strings (and should not).

## 7. Why error recovery failed

The real errors were returned (`ENOENT`, `[Exit code 1] The system cannot find the path specified.`, `AHP constraint violation: "no_file_writes"`), but: (a) they arrived after the model had already written the rest of its response on invented results, so most calls in a response were based on fiction; (b) failures of `run_command` did not echo the command or where it ran; (c) the boundary refusal did not name the workspace; (d) the decisive error — the write refusal — had no recovery path, because the constraint was wrong.

## 8. Why repairs did not produce modifications

The repair pass reused the same packet constraints (`sourcePacket.constraints`), so `no_file_writes` persisted; the model's writes were refused again. In A3 the repair ended on the budget reservation ($0.45 task budget, `maxTokens` 8192 per iteration).

## 9. Files changed

- `apps/desktop/src/workerConstraints.ts` (new): `isCommandExecutionObjective` (moved), `workerMustNotWriteFiles(task, objective)` — the constraint applies to pure command runs only; a change request with an explicit change verb may write; `constraintGateFor(packet)` — the per-worker Miranda gate, moved from `main.ts` unchanged.
- `apps/desktop/src/main.ts`: uses `workerMustNotWriteFiles` and `constraintGateFor`; the worker packet carries `verificationGuidance` as goal inputs.
- `apps/desktop/src/agents/ReactAgentAdapter.ts`: `enforceSingleToolCall` (first call only; stored turn cut after it; model told; trace `agent.tool.extra_calls_dropped`; a single call + `FINAL ANSWER` unchanged), workspace section in both prompt forms, `withCommandContext` on failed `run_command` results, workspace root named in boundary refusals, code-fence fallback restricted to JSON tool calls.

Safety unchanged: Miranda still authorizes every tool call; `no_file_writes` still applies to run-and-report requests (including "run the build and lint and tell me what fails", which the task-kind classifier alone would read as a fix); path confinement and approvals untouched; loop detection and repair bounds untouched; Pappy untouched.

## 10. Regression tests added

- `workerConstraints.test.ts` (3): change requests that also run tests may write; pure runs (incl. "tell me what fails", "do not change any files") keep the constraint.
- `workerProtocolUnits.test.ts` (11): single-call enforcement (unit + through the adapter: only the first call runs, invented results and a premature answer cut, note sent); single call + `FINAL ANSWER` unchanged; repeated invalid commands still trip loop detection, each failure carrying command and cwd; code fences not dispatched as tools; boundary refusal names the root; workspace section rendered.
- `workerEditProtocol.test.ts` (4 + 2 known-gap): the production worker loop, real workbench tools on a copy of the rehearsal project, the production constraint gate, the runtime and real Pappy:
  - replays A1–A3's mistakes, then the steps a capable worker takes → edit lands, host run on the final source 5 passed / 0 failed, no refusals, Pappy records test evidence and "reproduced then resolved … passes on the final source";
  - a success claim without an edit → Pappy `contradicted`, FAIL, not eligible, `FIX_SOURCE_CHANGE_MISSING`;
  - "Run the tests and report the failures." → `no_file_writes` kept, the write refused with the reason shown to the model, source unchanged;
  - Stop before the edit → no write, source unchanged, nothing verified;
  - `it.fails` ×2 — **KNOWN GAP**: Pappy verifies the genuine fix (§13). *Resolved in §17: replaced by passing tests.*
- Budget exhaustion during repair is covered by the existing `runtimeBudget.test.ts` ("stops halfway… skips repairs").

**What these tests do not prove:** that a real model will choose the right tools. The scripted model follows the steps a capable worker takes; only a live rehearsal measures the model.

## 11. Deterministic coding-task results

With the corrected protocol, the end-to-end test's worker recovers from every live mistake and lands the fix: `src/parse.js` changed on disk, `node --test` on the final source 5/5, host-recorded and attributed. The adversarial cases hold.

## 12. Full suite results (branch head `bcb802a`)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test` | **1,943 passed · 0 failed · 1 skipped**, plus 2 expected-fail (known gap) — baseline 1,925 + 18 new |
| TypeScript (all packages + scripts) | 0 errors |
| `pnpm contract:check` / `:strict` | CLEAR / exit 0 |
| Desktop bundle | builds; test candidate built (below) |

## 13. Pappy and Moonshiner regression outcomes — and a new Pappy finding

Pappy suites unchanged: 23/23 · 12/23 · 15/23 · **49/49** (FA 0/33, FR 0/11). Moonshiner export tests unchanged and passing.

**New finding (release-blocking, not fixed — needs the human's decision).** With the genuine fix and full host evidence, Pappy returns **FAIL / unverified** on this exact task, for both criteria phrasings Orca produces:

| Criteria | Result |
|---|---|
| user goal "Fix the failing test in src/parse.js and run the tests." | AC1 PARTIAL — "named file(s) changed on disk: src/parse.js, but the final content does not contain failing" |
| Brain's live criteria "The failing test in src/parse.js is identified and fixed" / "Tests are run and all pass after the fix" | AC1 PARTIAL ("final content lacks failing, identified"); AC2 MISSING despite the host-recorded full suite passing on the final source |

Pappy's own verification block in the same result says `testEvidence: true` and "reproduced then resolved: … failed on the task-start source and the full suite (node --test) passes on the final source". Causes: the named-file content rule (documented for content requirements such as "docs/guide.md must document the back-to-back rule") is applied to a bug-fix criterion that names a source file, demanding the criterion's words inside the code; and the "tests are run and all pass" criterion is not linked to the passing host run. Consequence: **the live rehearsal could not have passed even with a perfect worker.** Changing this changes Pappy's acceptance standard; it was not done. The gap is recorded as two `it.fails` tests that will turn red when Pappy verifies the case.

*Update: the human authorized a narrowly scoped correction. It is described in §17; the gap is closed at source level.*

## 14. Remaining limitations

- Model behaviour is unproven until a live run: the fixes remove the contradictions and the invented-results path, but the model must still choose `write_file` and run the tests.
- The shared loop in `agent-loop-core` (used by the runner CLI and a no-tools fallback) still executes every call in a response; it cannot run model tool calls in a desktop task.
- The Debugger role prompt is framed as "fix proposals" with an inline `FIX:` output contract, which conflicts with the write_file mandate. Not changed (not confirmed as a cause once the constraint is gone); watch it in the rehearsal.
- With one call per response a fix takes about 6–8 model calls; at `maxTokens` 8192 each reservation is ≈ $0.15 for `claude-sonnet-4-6`, so a $0.45 task budget is tight.
- `cd <workspace> &&` inside a command string still fails; the worker is now told not to do it.

## 15. Proposed next live rehearsal (not started; needs authorization)

Same provider (Anthropic, workspace-scoped key), same model `claude-sonnet-4-6`, same disposable project and message, the test candidate built from this branch. **Precondition:** decide on the Pappy gap first — otherwise the run can show the worker editing and the tests passing but will end in Pappy FAIL. Proposed hard budget **$0.75** per task and a new aggregate ceiling of **$1.00** for one attempt (expected spend ≈ $0.20–0.35). The human answers each approval card.

## 16. Is the release-blocking defect resolved at source level?

**The worker-side defect: yes**, deterministically demonstrated through the production worker loop, tools, gate and runtime. **The end-to-end outcome: no** — the Pappy false rejection (§13) still turns a genuine fix into FAIL. Orca 1.7.0 remains NO-GO until that decision is made and one live rehearsal shows a verified PASS.

*Update (§17): both are now resolved at source level and shown deterministically. Orca 1.7.0 stays NO-GO until one live rehearsal shows a verified PASS with a real model.*

## Test candidate (local only)

Built from `bcb802a`, clean, `ref fix/worker-edit-protocol`, Electron 41.10.7, **unsigned**; `C:\Orca\worktrees\main-rc\apps\desktop\release\` with a "TEST CANDIDATE — NOT FOR DISTRIBUTION" marker. SHA-256: `Orca 1.7.0.exe` `C6514D924729C32BD5DE842BBBCD2FB3BB0FED62E66D62C033F4176BCCF2BB06`, `Orca Setup 1.7.0.exe` `E0DA55A7076E95AFCBC5D15A358FD8BF0EE9B6276F828628EC9C7F57702219B2`. The asar contains the corrected protocol (workspace section, single-call enforcement, constraint rule, guidance inputs); a live worker prompt in the mock smoke shows the workspace section. Mock smoke: startup, pipeline, Stop → CANCELLED, approval card with Deny default, global Stop with the card open → CANCELLED, no execution. Performance: no measurable change in the mock runs; live runs will make more, shorter model calls (one call per response).

This candidate predates §17 and does not contain the Pappy correction or the batch rule. A rehearsal needs a candidate rebuilt from the branch head.

## 17. Pappy behavioural evidence correction and the batch rule (2026-10-14)

Authorized by the human as a correction to a demonstrated false rejection, not a relaxation of independent verification. Design and outcomes: `ORCA_VERIFICATION_EVIDENCE.md`, "Behavioural criteria for code changes"; corpus: `ORCA_EVIDENCE_CORPUS.md`, "Behavioural evidence correction".

**Pappy.** In a bugfix, feature or refactor task, a criterion naming a changed source file is decided by behavioural receipts on the final source, not by its words appearing in the code. A bug-fix criterion that refers to the defect also needs a resolved reproduction or a regression test. A criterion asking that tests be run and pass is decided by the host's final-suite receipt. A criterion naming a changed document follows E3 in every task kind, which closes a pre-existing false acceptance. Receipts, workspace checks and eligibility rules are unchanged.

**Worker batch rule** (refines §9's single-call rule). Calls written back to back, separated only by whitespace, run as one batch, because nothing between them could be an invented result. The first non-whitespace text after a call ends the batch, and everything from there on is cut and reported to the model once. A block that does not parse, or a code-fence call, means only the first call runs. Invented `Result:` text never reaches the tool record; only the host's real output does. Cancellation is checked before and after every call in a batch.

**Tests added or changed**

- `pappy-core/src/checks/behaviouralCriteria.test.ts` (15): the genuine fix under both criteria phrasings, a regression test, and every adversarial case in the brief.
- `pappy-eval` corpus: 9 fixtures; 58/58, no relabels.
- `workerProtocolUnits.test.ts` (17): batch unit tests, two back-to-back reads with no note, invented `Result:` text never recorded, cancellation mid-batch stops dispatch.
- `workerEditProtocol.test.ts` (7): the two `it.fails` tests became passing tests. The genuine fix is PASS / verified / eligible with every ledger entry PROVED, and the export writes one positive record (score 10, outcome success). The claim without an edit is not exported by PASS, WARN or FAIL exports. A repair pass after a wrong first edit receives Pappy's real findings, with no `no_file_writes`, completes the fix and is verified.

**Results at the branch head**

| Check | Result |
|---|---|
| `pnpm -r --no-bail test` | 1,976 passed · 0 failed · 1 skipped (baseline 1,943) |
| TypeScript (all packages + scripts) | 0 errors |
| `pnpm contract:check` / `:strict` | REVIEW REQUIRED, Rule 4 (Pappy QC touched, as authorized); strict exit 0; nothing BLOCKED |
| Pappy suites | 23/23 · 12/23 · 15/23 (unchanged) · 58/58 (FA 0/39, FR 0/13) |
| Desktop bundle | builds |

**What this does not prove.** The deterministic tests use a scripted model and supply the task specification directly, so Benson and Brain do not run. Brain's live criteria are reproduced verbatim from the A3 trace. Only a live rehearsal shows that a real model chooses the edit and that Brain's criteria for that run fall under these rules.
