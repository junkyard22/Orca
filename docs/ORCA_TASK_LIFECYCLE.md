# Orca task lifecycle and cancellation (core reliability, phases 5–6)

**Status:** implemented on `integration/core-reliability` (2026-10-12; phase 6 corrections the same day). Not merged. The phase 6 pre-merge validation of this design is in `docs/ORCA_PRE_MERGE_VALIDATION.md`.

A task is not safely stopped because the interface says "Stopped." Four things are kept apart: *requesting* cancellation, *preventing* further dispatch, *draining* active work, and *confirming* that everything settled.

## What was wrong

`chat:send` in the desktop awaited `Promise.race([taskPromise, abortPromise])`. Pressing Stop resolved `abortPromise` at once, the handler returned, and its `finally` released the task lock (`activeAbortController = null`) while the task's model streams, tool processes, MCP calls, Pappy evaluation and repair passes were still running. Consequences:

- a new message could start while the previous task's worker was still executing tools in the same workspace;
- `requestToolApproval` had no notion of which task was asking, so a stopped task's late tool call could open a new approval dialog during the next task, and a stale approval response resolved whatever entry carried its id;
- the runtime itself could not stop early: it awaited `maestro.run` to completion, so a worker blocked in a non-cancellable MCP call held the task until that call returned, with no record of what was still running;
- a cancelled task was never persisted and emitted nothing that said whether its operations had settled;
- Brain's own abort was caught as a generic error and turned into a deterministic fallback — a cancelled plan became a running worker;
- a request to *fix* code that also said "run the tests" was routed to command verification, replacing the user's acceptance criteria.

## States

`orca-core/src/lifecycle.ts` — `TaskLifecycle`, owned by the runtime (Maestro's side of the contract), exposed to adapters as `ctx.lifecycle`, observable as `task:state` events and `task.state` trace entries.

| State | Meaning |
|---|---|
| CREATED | task accepted, nothing dispatched |
| PLANNING | Brain routing (the desktop Maestro reports it) |
| RUNNING | a Maestro pass is executing |
| WAITING_FOR_APPROVAL | a tool approval dialog is open (wrapped `requestToolApproval`) |
| VERIFYING | Pappy is evaluating the pass |
| REPAIRING | a repair pass was started |
| CANCELLING | cancellation requested; no new model or tool dispatch; active operations tracked |
| CANCELLED | cancellation requested and every tracked operation settled |
| COMPLETED | the task succeeded **and** QC did not fail |
| FAILED | the task ended without success (QC FAIL, budget stop, error) |
| INTERRUPTED | cancellation requested but operations never settled within the drain timeout (named in the snapshot), or the process died (journal) |

Transitions are checked against an explicit table; a terminal state is never left, and once cancellation is requested only CANCELLING/CANCELLED/INTERRUPTED may follow. Every refused transition is recorded in `ignoredAfterEnd`, so a late "COMPLETED" after a Stop is visible as ignored, not applied.

## Operations

`lifecycle.begin(kind, label)` / `track(kind, label, fn)` register the work acting for a task: tool runs (the runtime's tool service and the desktop agent), approval waits, and — through the budget ledger's open reservations — model requests. `mayDispatch` is false once cancellation was requested: the runtime's tool service answers `ok:false, "not run: the task is cancelling"`, the budgeted adapter releases a reservation and throws AbortError before dispatch, the desktop agent's loop stops at the next check, approvals resolve `false`.

## Cancellation path

1. **Request.** The desktop `task:abort` denies pending approvals, calls `taskSessions.cancel()`, which aborts the session's `AbortSignal`; the runtime's abort listener moves the lifecycle to CANCELLING immediately.
2. **Prevent.** No further model or tool dispatch (above). A late model response cannot start a tool (the agent checks the signal after each call; the tool service refuses). A late approval response authorizes nothing (`tool:approve` resolves `approved && session.state === "running"`).
3. **Drain.** The runtime stops awaiting the Maestro pass (`untilAborted`) and waits up to `drainTimeoutMs` (10 s) for tracked operations to end. Commands are killed by `run_command`'s own abort handling; model requests reject on their signal; MCP calls that ignore the signal are simply waited for.
4. **Confirm.** All settled → CANCELLED; the run is persisted with `stoppedBecause: "cancelled"`, the budget ledger shows any dispatched-but-unmeasured request as unreconciled. Not settled → INTERRUPTED with the operations named; `stoppedBecause: "interrupted"`.
5. **Lock.** The desktop `TaskSessionManager` holds the lock until the task promise settles; `chat:send` replies right away ("Stopped.", `cancelling: true`), a new message is refused with "The previous task is still stopping" until settlement, and a 30 s watchdog marks the session interrupted, releases the lock and reports it so the user is not locked out by an operation Orca cannot interrupt — with the explicit warning that the workspace may still change.

Verification cannot be reached after cancellation: the runtime throws before QC and the repair loop checks the signal before each pass; a verdict already produced is kept but the lifecycle ends CANCELLED, never COMPLETED. The budget ledger's `markUnreconciled` is called when a request's outcome is unknown and a late settlement cannot reconcile it.

## Workspace safety is not task state (phase 6)

Phase 6 reproduced the loophole the phase 5 limitations named: a tool that ignores the abort signal keeps running after the runtime gives up draining (10 s) and returns INTERRUPTED; the desktop session then settled and released the lock, so a second task could start in a workspace the first task's worker was still writing to. A second, quieter loophole sat in `run_command`: after Stop it rejected 750 ms after requesting the kill whether or not the child had exited, so a process tree that survived `taskkill` was reported as settled.

Five things are now kept apart, and each has its own record:

| Concern | Where it lives | What it answers |
|---|---|---|
| Task execution state | `TaskLifecycle.current` | What is the task doing; is it over |
| Active operations | `TaskLifecycle.activeOperations()` | What is still running in this process for the task |
| Unsettled resources | `TaskLifecycle.unsettledResources()` | Which child processes were not confirmed stopped (pid, command, start time, creation-time identity) |
| Workspace protection | `WorkspaceGuard` (`orca-core/src/workspaceGuard.ts`) | May another task own this workspace root |
| Pending authorization | desktop `pendingApprovals` + session binding | Whose approval dialog is open, and whether its answer can still authorize anything |

**Residues.** `run_command` now only treats the child's `close` as confirmation. If the kill is not confirmed within 750 ms it rejects with an `AbortError` that carries `unsettledResource` (pid, trimmed command, spawn time, and the process creation time captured at that moment through `workbench-core/src/tools/processIdentity.ts`). `TaskLifecycle.track` records that resource: the operation has ended, the task has not settled. CANCELLING with every operation ended but a resource outstanding becomes INTERRUPTED, never CANCELLED; `drain` resolves false at once in that case; `lifecycle.quiet` is true only when both lists are empty. A late `end()` after a terminal state is still applied to the operation list (and recorded as "settled after INTERRUPTED") so the workspace can be declared quiet later.

**Protection.** When a task ends INTERRUPTED — after Stop, or because a pass returned while a fire-and-forget operation was still running and it never settled — the runtime protects the workspace root with the guard: the record names the task, the unsettled operations and the unconfirmed processes, and follows the lifecycle. The next `executeTask` for that root throws `WorkspaceProtectedError` before the evidence baseline, before Benson, before any model call; the desktop's `send-message` asks the guard first and returns the same text, and the renderer shows it as a banner. Protection is released by exactly three things:

1. *settlement* — the lifecycle reports the operations ended and no resource is left;
2. *verification* — every recorded process is probed (`probeProcess`: pid existence, then creation-time comparison, so a reused pid with a different identity counts as gone; `unknown` is never treated as gone);
3. *user release* — the user, shown the list and a native confirmation dialog ("I have checked — release"), takes responsibility. Recorded with `by: "user"` and the reason.

There is no timeout and no automatic reset. Protection is persisted (`workspace-protection.json` under userData, atomic rename) and re-read at start-up: in-process operations of a dead Orca are gone by definition (noted, with the warning that their last writes may be partial), child processes are re-probed, and anything still alive keeps the workspace protected with the recovery text in the init warnings.

**Desktop watchdog.** The 30 s session watchdog still releases the *lock* (the user must not be shut out of the app), but it now also records a host-level protection for the workspace ("task runtime never settled after Stop"); when the runtime finally settles, `onLateSettlement` lifts that record, leaving any record the runtime itself made for unconfirmed processes.

**Late dispatch.** `ctx.llm` is wrapped by `dispatchGuard.ts`: after cancellation or completion a late worker callback's `complete`/`stream` rejects with `AbortError`, as a late tool call, approval, repair or transition already did. The wrapper makes no model call of its own; the gated service it forwards to is unchanged (see the Rule 2 note in the validation report).

## Parallel execution and ownership

Workers still run in parallel (`Promise.all` in the desktop's decompose path). Every operation is registered under the task id and kind; evidence collected for Pappy while any operation other than verification is still active is marked `partial` with the operations named, so Pappy treats it as insufficient evidence (`EVIDENCE_PARTIAL`, HIGH) instead of judging a moving workspace.

Phase 6 adds attribution and conflict detection instead of serialisation. The evidence collector reads every `agent.tool.call` / `tool.call` trace for a writing tool (`write_file`, `edit_*`, `*patch*`, `create_*`, connector editors named like them) and records the path and the worker (`role`, else `subagentId`, else "worker") against the current Maestro pass (`maestro.run.start` / `repair.start` boundaries). Each changed path in the evidence carries `writers[]`; a path written by two different workers in the same pass is listed in `contested[]`. Pappy (`CONFLICTING_WRITES`, MEDIUM, "Proof") downgrades the verification status to `unverified` for a change-kind task with a contested path: the final content may have lost one worker's change, so what the tests proved cannot be credited to either. Sequential writes across passes (a repair after a rejection) are attribution only. A test run is still tied to the source state it ran on (`baseline` / `intermediate` / `final`), so a passing run followed by another source change is never final evidence.

## Brain fallback

`brainRoute` distinguishes `invalid_plan` (validation failed after the repair attempt), `provider_failed`, `timed_out`, `no_decision`; a cancelled Brain rethrows (no fallback). The fallback route preserves the user's goals as the acceptance criteria and picks a worker by the kind of work (`fallbackExecutionRole`: debugger for a defect, strong model for feature/refactor/docs, reader for inspection, Narrator only for conversational work). The reason is traced (`brain.route.fallback`) and emitted (`brain:fallback`) to the UI. Command verification applies only when running commands *is* the request (`requestsChanges` false).

Phase 6 corrected one unintended effect of using Pappy's task classifier for routing: Pappy's `inspect` kind groups information *gathering* (review, audit, "explain how X in src/ works") with *restating* information already in hand ("summarize the facts", "report on the findings for the user"), because for verification both leave the workspace unchanged. For routing they differ: gathering needs the reader, who can open files; restating is a response, which is Narrator's job. `restatesKnownInformation` decides by the object of the request — a response-shaped verb whose object is prior information or the user, with nothing in the workspace named — not by particular phrasings. "Summarize the facts" → Narrator again; "Explain the architecture", "Summarize the findings about src/parse.js" → reader.

## Recovery

The budget journal records in-flight snapshots; on the next start each unresolved task is reported in the init warnings **and** saved to the run history as `FAIL / interrupted` with the unreconciled exposure. Nothing is resumed and no paid request is repeated. Child processes started by a crashed Orca whose kill was never confirmed are recorded in the workspace protection file with pid and creation time; at start-up they are probed, and the workspace stays protected while one is alive (see above). Pending approvals die with the process and cannot be answered later; a new session's approvals are bound to that session.

## Tests

`packages/orca-core/src/lifecycle.test.ts` (transitions, terminal immutability, drain/interrupt, tracking), `runtimeCancellation.test.ts` (Stop during worker/approval/repair/model request, late callbacks, double Stop, COMPLETED vs FAILED, partial evidence), `workspaceGuard.test.ts` (protect/refuse/settle, process verification and pid reuse, user release, persistence across a restart, `settle()`, residues in the lifecycle), `runtimeWorkspaceSafety.test.ts` (Task B refused while Task A still writes; protection lifts on settlement; stray operations drained or INTERRUPTED+protected; late model/tool/approval/transition all refused; verdict unchanged), `evidenceStability.test.ts` (intermediate vs final test runs, writer attribution, contested writes, sequential passes), `packages/workbench-core/src/tools/runCommandCancellation.test.ts` (confirmed kill vs unconfirmed kill with the process named), `processIdentity.test.ts` (real disposable processes: alive → gone, identity mismatch), `packages/pappy-core/src/checks/workspaceVerification.test.ts` (contested → unverified, attribution alone changes nothing), `apps/desktop/src/taskSession.test.ts` (the `Promise.race` reproduction and its fix, watchdog, double Stop, sequencing), `workspaceSafety.test.ts` (the end-to-end Task A / Task B scenario, watchdog protection and late settlement, user release), `routingPolicy.test.ts` (objective preservation, fallback roles, gathering vs restating).

## Limitations

- An MCP tool that ignores the abort signal cannot be interrupted; it is tracked and reported, not killed. In-process (MCP, model stream, file write) operations cannot outlive Orca; only child processes can, and only those are probed after a restart.
- Process identity is best effort: the creation time is read with PowerShell (`Get-CimInstance Win32_Process`) or `ps -o lstart=`; where that fails, the probe falls back to pid existence, which errs on the side of "alive" (protection stays, the user is asked to check).
- A command tool that spawns grandchildren outside the killed process tree, or an MCP server that runs its own commands, leaves processes Orca never saw; they are not in the record and the recovery text tells the user to check.
- The desktop watchdog still releases the *lock* after 30 s so the app stays usable; the *workspace* stays protected until the runtime settles or the user releases it.
- Conflicting writes are detected (same path, two workers, one pass), not prevented; the pass is still judged, as `unverified`.
- Lifecycle operation tracking is in-process; a crash leaves the journal's budget snapshot and the protection file (processes only), not a per-operation record.
- Targeted evidence collection (asking a worker for one missing receipt instead of a full repair) is a recommendation, not implemented: Pappy's `evidenceRequests` already name the exact evidence; the repair loop could send only those as the repair instruction when the only unmet criteria are insufficient-evidence findings (not contradictions), keeping the original task, criteria and budget. That needs a design review of the repair prompt contract and Maestro's AHP packets.

## Phase 6.5 — final safety validation corrections (2026-10-12)

Full report: `docs/ORCA_FINAL_SAFETY_VALIDATION.md`. What changed in the design after validating phases 1–6 together:

**A parent's exit is not its children's.** Reproduced with real disposable processes: a command's shell exits while a detached grandchild keeps running; phase 6 reported the task CANCELLED/COMPLETED and the workspace quiet. Now, after every command's shell exits, `run_command` looks up what it left behind (`findSurvivingDescendants`, one enumeration off the tool's critical path) and hands the result to the lifecycle as a non-enumerable `pendingResources` promise on the result or error. The lifecycle tracks that scan as an operation of kind `scan` (the task is not quiet until it answers), records every survivor as an unsettled resource, and notes a scan that could not run ("unknown", never "none"). On Windows the tree is rebuilt from `ParentProcessId` (kept after the parent dies) and filtered by creation time; a chain through a dead intermediate (`cmd → node → grandchild`) cannot be walked, so a process created during the command whose parent is gone is reported as a *suspected* descendant ("orphan", with its executable name) — conservative, and said so in the reason. On POSIX the root's process group is used. Evidence collection waits up to 3 s for pending scans and marks the evidence partial while a survivor is alive.

**Protection on success, too.** A task that ends COMPLETED or FAILED with a process it started still running leaves the workspace protected ("ended completed, but a process it started is still running"); only an interrupted task is INTERRUPTED. The desktop re-verifies protected roots every 5 s so the banner lifts by itself once the process exits — by verification, never by timeout.

**Override, not release.** The user action is `override(root, { reason, acknowledged: true })`: it verifies nothing and stops nothing, bumps the root's generation (a fence: records under the old generation are stale), and keeps the protection as it stood in an audit log (`overrides[]`, persisted, last 50) so the interruption evidence travels with the decision. The desktop dialog is titled "Override workspace protection", says Orca has NOT confirmed the workspace is quiet, names what is unsettled, defaults to Cancel, and its only affirmative button reads "I accept the risk — override". Nothing in the override touches Miranda: a stale task's lifecycle still refuses dispatch, approvals stay session-bound, and the next task is gated as any other. The known limit: an external process that ignored the kill is not fenced by anything Orca does; the override records that the user accepts exactly that.

**Cancellation keeps its identity.** Observed live: Stop during Brain planning surfaced as "provider_failed" and triggered a fallback, because the transport reported the abort as its own error type and the budgeted adapter rethrew it as-is. The adapter now surfaces an `AbortError` (with the transport's error as `cause`) whenever the request's signal is aborted, and the Brain classifier treats any error raised under an aborted signal as cancellation. A budget refusal of the planning call is likewise not a fallback: the task stops with the budget reason.

**Contested writes, refined.** Harmless collaboration and unresolved conflicting evidence are told apart by what the conflict touches and what proves the final state: a contested path the objective does not rest on is a LOW note; a contested source path whose final state a host-recorded run on the final source vouches for is verified as a result but `attributionUnresolved` (never a training candidate); a contested source path with no such run is `unverified` (MEDIUM), and a criterion proved only by that file's content becomes PARTIAL — mandatory evidence not met.

**Truthful status.** The badge's "Task state" row falls back to the last `task:state` event when the task ended before a summary existed; "stopped by budget" reads "blocked after Stop" when the user cancelled.

Additional tests: `survivingProcesses.test.ts` (real grandchild), `recoveryWarnings.test.ts` (8 start-up cases through the real journal and guard), `brainFallback.test.ts` (every Brain failure, cancellation, budget refusal, objective preservation), `dispatchGuard.test.ts`, `integrationStress.test.ts` (the whole runtime with the real ledger, evidence collector and Pappy), budgetHardening "cancellation identity", workspaceVerification "contested writes" (4 cases).

Limitations added: the survivor scan is a lower bound (processes that left the group or were started by something else are not found) and can report unrelated short-lived orphans created during the command window (released by verification within seconds); under heavy host load the scan may exceed its 3 s budget and report "unknown"; starting a long-lived server from a task protects the workspace until it exits or the user overrides.

## Phase 6.6 — human acceptance corrections (2026-10-13)

- **Stop was unreachable while an approval was pending** (found by the presenter): the approval modal covered the window, so the only exits were Approve, Deny or the 60 s auto-deny. The card now carries a "Stop task" action (stops the task; the request is left unanswered and the main process denies every pending approval on abort), closes itself on `task:state` CANCELLING / CANCELLED / INTERRUPTED, gives keyboard focus to Deny (Enter denies), and shows the workspace folder. Witnessed afterwards: WAITING_FOR_APPROVAL → CANCELLING → CANCELLED with no execution and no further model call.
- A protection that survives a restart is announced like a new one, so the desktop's 5-second re-verification covers it (`workspaceGuard.recover()` emits `protected`).
- Survivor scans requested within 150 ms share one enumeration taken after the window closes (same guarantee; see `survivor-scan-bench.mjs`).
- Known, not fixed: the fallback badge labels a cancelled task "Verdict FAIL / ERROR Stopped." beside "Task state cancelled"; the safe-command allowlist (`echo` and other read-only commands) auto-approves by design, so an approval check must use a non-allowlisted command.
