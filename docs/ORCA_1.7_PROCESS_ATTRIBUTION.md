# Orca 1.7.0 — Process attribution and repair classification (after live rehearsal A5)

Branch `fix/process-attribution` (from `fix/worker-edit-protocol` @ `f0c257d`). Local only; not pushed.

## 1. What A5 showed

Live rehearsal A5 (2026-10-15, `claude-sonnet-4-6`, human approvals): the worker made a genuine three-line fix to `src/parse.js`; the host recorded `npm test` 13 passed / 0 failed on the final source; Pappy marked all three criteria proved. Pappy still returned **FAIL** on one HIGH issue, `EVIDENCE_PARTIAL`: "2 process(es) started by the task may still be writing: pid 18980 (sleep.exe (orphan of: npm test)), pid 19692 (sleep.exe (orphan of: npm test))". The repair pass that followed re-ran the tests three times (13/13 each), had its honest "no code change required" answer rejected by the worker's file-save rule, rewrote `src/parse.js` with byte-identical content and stopped at `max_iterations` with no answer; QC was blocked and the first FAIL stood. A third `sleep.exe` (pid 17020) was recorded during the repair pass, and the workspace was protected at the end of the task.

A5 remains a failed acceptance run. Nothing here changes its recorded verdict.

## 2. Why the three processes were recorded

| Question | Finding |
|---|---|
| Which processes | pids 18980, 19692 (first pass), 17020 (repair pass); all `sleep.exe`. |
| What tied them to `npm test` | Timing only. The Windows scan (`processIdentity.ts`) reported any process created after the command was spawned (minus 2 s of slack) whose parent pid no longer existed, labelled "orphan of: <command>". |
| Were they descendants | No evidence that they were, and strong evidence that they were not: the project's test script is `node --test` (no `sleep`); the operator's monitoring loop ran `sleep 2` in Git Bash every two seconds throughout the run; Git Bash starts every external program under a short-lived fork helper that has already exited, so every such `sleep.exe` has a dead parent. |
| Reproduction | Orca's real `run_command` ran `npm test` on a copy of the A5 project 8 times next to an unrelated Git Bash `while true; do sleep 2; done`: **8 / 8** runs reported a `sleep.exe` "orphan of: npm test", every one with a dead parent. The same 8 runs without the loop: **0 / 8**. |
| Does the loop explain all three | Yes in kind (all three were `sleep.exe` from the same time window); the specific processes exited seconds later and Windows keeps no history, so their individual parentage cannot be re-established after the fact. |
| Parent exit / pid reuse | Parent exit is the mechanism (the dead fork helper). Pid reuse played no part; the 2 s creation-time allowance widened the window in which an unrelated process could qualify. |
| Why the evidence was partial | The runtime counted every recorded survivor as "may still be writing" **without re-checking whether it was still running**. The sleeps (2 s each) had exited before Pappy judged the work (≥ 5 s later). The workspace guard did re-probe them at the end of the task and released the protection by verification about a second later (no override). |

So two defects combined: attribution by timing alone, and stale survivor records feeding the evidence.

## 3. Corrections

**Attribution (workbench-core `processIdentity.ts`, `runCommandTool.ts`).** Every reported process now carries `ownership`:

| Ownership | Meaning | Handling |
|---|---|---|
| `confirmed` | reached from the command's root through recorded parent links (POSIX: still in its process group) | kept until verified gone; named "descendant of: <command>" |
| `suspected` | ancestry unprovable, but its command line names the workspace | kept until verified gone |
| `unknown` | ancestry unprovable; only timing ties it to the command | kept until verified gone; named "ownership unknown: created while <command> ran" — never "of: <command>" |
| (unrelated) | created before the command (Windows: precise creation times, 250 ms allowance instead of 2 s), in another Windows session, or under a live parent outside the command's tree | not reported |

`suspected` and `unknown` are still protected: from one process snapshot an unrelated dead-parent process cannot be told from a detached grandchild whose intermediate exited, and Orca must not assume the safe answer.

**Re-verification (orca-core `lifecycle.ts`, `runtime.ts`; desktop `main.ts`).** The runtime takes an optional `processProbe` (desktop: `probeProcess`, pid plus creation time, so a reused pid counts as gone). Before the workspace evidence is taken it waits up to 10 s for recorded processes to exit, releases those verified gone, and only then takes the inventory — which therefore includes anything they wrote. Still running or not verifiable ("unknown") keeps the evidence partial, and the reason now distinguishes "started by the task" from "unknown ownership". The same probe runs once more before the workspace is protected at the end of a task. Without a probe nothing changes.

**Repair classification (orca-core `repairClassification.ts`, `repairLoop.ts`).** Each issue is classified as `code_defect`, `missing_evidence`, `authorization` (a tool failure whose recorded error says the call was not approved) or `evidence_integrity` (`EVIDENCE_PARTIAL`). When every blocking (HIGH/CRITICAL) issue is authorization or evidence integrity, no worker repair pass is dispatched (`repair.skipped` trace) and Pappy's FAIL stands, reported for a person to act on. Any code defect or missing evidence keeps the repair pass with unchanged bounds; unrecognised codes count as code defects.

Unchanged: Pappy (including `EVIDENCE_PARTIAL`), Miranda permissions and gates, approvals, the workspace guard's release rules, repair bounds.

## 4. Tests

- `workbench-core/survivorAttribution.test.ts` (11, 1 opt-in): an unrelated Git Bash `sleep.exe` is "ownership unknown", never the command's; an unrelated application under a live parent is not reported; created before the command (precise times) or in another session is not reported; a genuine child still running is confirmed; a detached grandchild is confirmed / suspected / unknown depending on what is recorded, always reported; a reused pid is not walked into; missing creation time or session is not read as safety; a process that exited before inspection is not reported; POSIX group members confirmed, reparented processes unknown; opt-in real Git Bash loop next to Orca's `run_command` (`ORCA_REAL_PROCESS_TESTS=1`).
- `orca-core/processAttribution.test.ts` (14): an unrelated survivor gone before the evidence → not partial, verified, nothing protected; one that exits during the bounded wait → released; still running → `EVIDENCE_PARTIAL` named as unknown ownership, workspace protected; confirmed descendant still running → named as the task's; probe "unknown" keeps it; no probe → unchanged; lifecycle re-verification (release only on "gone", reused pid, throwing probe); restart with an unknown-ownership process recorded (kept while alive, released when gone, ownership persisted); classification; A5 in miniature (no repair pass, FAIL stands); a genuine code defect still gets its repair pass.
- `desktop/workerEditProtocol.test.ts` (+3, 1 opt-in), the parse.js task with the production worker loop, real tools and real Pappy: an unrelated process that exits before the evidence → **PASS / verified / eligible**, every criterion proved, nothing protected; one still running → FAIL on `EVIDENCE_PARTIAL`, no repair worker, one write only, workspace protected; opt-in real processes (an unrelated dead-parent `node.exe` started during `node --test`): reported as unknown ownership, released after it exited, PASS.
- `survivingProcesses.test.ts`: label expectation updated (the genuine detached grandchild is still required to be reported).

Real-process tests are opt-in because a live stray process is exactly what other test files' real scans would — correctly — report when run in parallel.

## 5. Remaining limitations

- On Windows, a long-lived unrelated process with an exited parent created while an Orca command runs still makes the evidence partial and protects the workspace until it exits. Telling it apart from a detached grandchild needs a process-tree boundary Orca does not have today (a per-command Job Object without breakaway, which requires a native helper; libuv's own job allows silent breakaway). Recommended follow-up.
- A scan that cannot run is recorded as a task note; it does not make the evidence partial (pre-existing behaviour, unchanged).
- A repair pass dispatched for missing evidence (for example, tests not re-run) is still subject to the worker's file-save rule, which can push a needless identical rewrite; not changed here.
- `EVIDENCE_PARTIAL`'s fix hint ("narrow the workspace root or raise the evidence limits") does not fit the process case; Pappy's text was left unchanged.
