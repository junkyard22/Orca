# Orca 1.7.0 — Evidence and repair integrity (after live rehearsal A6)

Branch `fix/process-attribution` (on top of `5f3afc4`). Local only; not pushed. A6's recorded verdict stays **WARN**; nothing here changes it.

## 1. What A6 showed

A6 (2026-10-15, `claude-sonnet-4-6`, human approvals) completed the parse.js task. The first pass fixed `src/parse.js` but answered without re-running the tests; Pappy correctly asked for verification. The repair pass ran `node --test test/parse.test.js` and `npm test 2>&1` on the final source — host-recorded 13 passed / 0 failed, evidence verified — but the final verdict was **WARN**, and the final message told the user that "the fix was already in place — someone had corrected parse.js in a prior session".

## 2. The phantom file "&1"

**Path of the command.** The worker emitted `run_command {"command":"npm test 2>&1"}` → workbench `runCommandTool` evaluated the command policy (`sandbox.ts`) and requested approval → Miranda's tool gate allowed it → the command ran under `cmd.exe` (`spawn(…, { shell: true })` on Windows) → **`detectFileChanges` (`runCommandTool.ts`) matched `2>&1` with the pattern `(\d*>)\s*(['"\`])?(.+?)…` and recorded a new file "&1"**, appended to the tool output as `<!-- Files changed: [{"path":"&1","changeType":"A"}] -->` → the desktop worker read that marker into the pass's reported `filesChanged` → Pappy compared the reported files with the host snapshot.

**One defective layer.** Only the file-effect detection was wrong. The approval pattern (`hasWriteRedirection`) already skipped `2>&1`; the host inventory (authoritative) never contained "&1"; Pappy reported what it was given.

**All three A6 issues came from it.** MEDIUM `COMPLETENESS_EMPTY_DIFF` ("&1" created with no diff) and LOW `NO_OP_WRITE` ("&1" reported but unchanged on disk) are about the phantom directly. LOW `COMPLETENESS_FILE_MISMATCH` ("Task implies work in: testing, assertion") fired because the repair pass's only reported file was "&1", which has none of the extensions the rule accepts as evidence; a pass that changes nothing reports no files and the rule does not run, and a real `src/parse.js` change counts as evidence through `.js`. The rule was correct and is unchanged; `pappy-core/checks/fileMismatch.test.ts` pins this.

**Correction (`workbench-core/tools/shellRedirection.ts`).** Redirections are parsed as the shell that runs them reads them: `cmd` (Windows run_command), POSIX `sh` (elsewhere), and PowerShell; inline scripts handed to nested shells (`bash -c`, `sh -c`, Git Bash, `cmd /c`, `powershell -Command`) are parsed with their own rules. Each redirection is a `file`, a `device` (`nul`, `/dev/null`, `$null`, …), a `descriptor` duplicate (`2>&1`, `1>&2`, `*>&1`) or `unresolved` (run-time targets such as `$VAR`/`%VAR%`/globs, process substitution, a missing target, PowerShell file-writing cmdlets, an unparseable command). Quoted text is an argument; escapes (`^`, `\`, backtick) are honoured; here-document bodies are data.

- File-effect detection reports only `file` targets — never a descriptor, a device, or an unresolved target (no filename is invented; the host's before/after inventory decides what changed).
- The approval rule keeps the earlier pattern and adds the parser's findings (`file`, `unresolved`, a device other than a discarded error stream): it can only become stricter. It now also requires approval for `&>file`, `>& file`, run-time targets and writes inside nested-shell scripts, which the earlier pattern missed.
- Unchanged: Miranda's gates, the denied-command patterns, path confinement (`cwd` within the workspace), approvals.

## 3. Repair memory

**What the A6 repair worker received:** the original objective and guidance (including "before changing any source code, run the full test suite…"), Pappy's four issues, "Re-run the original task", and the header "ACTION REQUIRED: Call write_file…" (the worker's file-save rule reads "Fix … src/parse.js" as a save request). **Not received:** that this task's first pass had already changed `src/parse.js`, which tests had run on which source, or that only verification was outstanding. Provenance was lost in `repairLoop.ts`, which built the repair task from Pappy's issues alone. The worker found the fix on disk and inferred a prior session.

**Correction (`orca-core/hostRecord.ts`, `repairLoop.ts`, `runtime.ts`).** The runtime keeps a per-pass log of host-recorded tool events and the workspace evidence the last verdict used. Before a repair pass it builds a compact host record — each changed file with the pass whose recorded write touched it ("changed by this task in the first pass"), contested writes, and changes with no recorded write ("origin unknown"); each test run with its source state and counts ("`npm test` on the task-start source: failed (11 passed, 2 failed)"; "No test has run on the current source") — plus what is outstanding by issue class. When only missing evidence is outstanding and the task's own change is on disk, the repair worker is told to run the tests on the current source, keep the change, not rewrite it, and not describe it as pre-existing; the task carries `sourceChangeRequired: false`, and the desktop worker then omits the write demand and the "call write_file" nudge (`AgentAdapter.ts`, `ReactAgentAdapter.ts`, `workerConstraints.ts`, `main.ts`). Otherwise the usual rule applies. Retry bounds, Miranda and Pappy are unchanged.

## 4. The final account

The false statement passed from the repair worker's final answer to `result.userFacingText`, and Claire (narrator model) re-voiced it: she was given only the worker's text. Causes: missing repair context, the worker's own inference, and a narrator relying on worker text instead of host evidence.

**Correction.** The runtime checks the final explanation against the host record (`correctProvenance`): a claim that the change pre-existed or came from someone or somewhere else, a claim that the last pass made an earlier pass's change, a claim of a change when none was recorded, or a claim about who made a change of unknown origin — each is corrected by appending "Correction from Orca's records: …" built from the record (once), recorded as `provenance.corrected` and on the result (`provenance`, `hostRecord`). Claire receives the record as "Recorded facts" that override the result text on who changed what and which tests ran, and her reply passes through the same check (`narrationReview.ts`) before the user sees it. Attribution is never invented: without a record nothing is claimed; an unattributed change is "origin unknown".

## 5. Validation

Deterministic only; no paid request.

- `workbench-core/shellRedirection.test.ts` (53): `2>&1`/`1>&2` in cmd, POSIX and PowerShell; stdout, stderr, append, combined (`&>`, `&>>`, `>&`, `*>`); quoted and escaped redirection characters; null devices; here-documents; cmd's `&` separator; nested Git Bash / sh / cmd / PowerShell scripts; descriptor plus file in one command; ten malformed or run-time cases (never safe, never a filename); the approval rule (never weaker, now stricter for `&>`/`>&`); real `run_command` runs on this machine's shell (no "&1"; genuine redirect files reported and present on disk).
- `orca-core/hostRecord.test.ts` (12): attribution by pass, pre-existing changes, external and contested changes, no record, test-count parsing; provenance cases (A6's claim, a repair pass claiming an earlier edit, an accurate account, a failed task with no change, unknown origin); A6 in miniature through the runtime and real Pappy.
- `claire-core/claire.test.ts` (3): facts reach the narrator; the reply is reviewed; nothing added without a record.
- `pappy-core/checks/fileMismatch.test.ts` (4): the LOW rule's trigger in A6 and that it still fires on unrelated changes.
- `desktop/workerEditProtocol.test.ts` (+3), the A6 replay with the production worker loop, real tools, the project's 13-test suite, the runtime, real Pappy and Claire: initial tests 11/2 → authorized fix → pass 1 ends without a re-run → Pappy FAIL (missing evidence) → the repair worker gets the host record and no write demand → `npm test 2>&1` 13/13 on the final source → no "&1" anywhere → final source equals the tested state → all criteria PROVED → **PASS / verified / eligible**; a repair worker's "prior session" claim is corrected in the result and in Claire's reply; the untested first pass alone is still refused. Moonshiner: the default first-attempt-only export skips the repaired run (`too_many_repairs`, unchanged safeguard); an export allowing one repair exports it as a positive example.

Full regression: 2,077 passed · 0 failed · 3 skipped (baseline 2,002 · 0 · 3). TypeScript 0 errors. Pappy suites 23/23 · 12/23 · 15/23 · corpus 58/58 (0/39 false acceptances, 0/13 false rejections) — unchanged. Strict contract check: REVIEW REQUIRED, Rule 4 (previously approved Pappy files plus the new Pappy test file); exit 0. Desktop bundle builds.

## 6. Limitations

- The parser covers the syntax Orca's workers use in practice; exotic constructs (`exec` redirections, `{fd}>` named descriptors, cmd `for` bodies) may be reported as plain files or unresolved — never as safe without approval, but possibly as a reported file the host then shows unchanged.
- PowerShell file-writing cmdlets are flagged as unresolved, not resolved to their target path.
- The provenance check recognises common phrasings; an unusual wording of a false origin claim can pass unnoticed (the narrator still receives the facts).
- The first pass's habit of answering without re-running the tests is model behaviour; Orca now handles it with one cheap repair, but does not prevent it.
- A Windows long-lived unrelated process with an exited parent still makes evidence partial (see `ORCA_1.7_PROCESS_ATTRIBUTION.md`).
