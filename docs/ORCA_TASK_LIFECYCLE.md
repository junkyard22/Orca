# Orca task lifecycle and cancellation (core reliability, phase 5)

**Status:** implemented on `integration/core-reliability` (2026-10-12). Not merged.

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

## Parallel execution and ownership

Workers still run in parallel (`Promise.all` in the desktop's decompose path). Every operation is registered under the task id and kind; evidence collected for Pappy while any operation other than verification is still active is marked `partial` with the operations named, so Pappy treats it as insufficient evidence (`EVIDENCE_PARTIAL`, HIGH) instead of judging a moving workspace. Conflicting writes between two workers are not serialised (that would remove the parallelism the brief preserves); they are visible in the evidence (both appear in `changes[]`) and in the per-worker tool events, and the acceptance criteria decide.

## Brain fallback

`brainRoute` distinguishes `invalid_plan` (validation failed after the repair attempt), `provider_failed`, `timed_out`, `no_decision`; a cancelled Brain rethrows (no fallback). The fallback route preserves the user's goals as the acceptance criteria and picks a worker by the kind of work (`fallbackExecutionRole`: debugger for a defect, strong model for feature/refactor/docs, reader for inspection, Narrator only for conversational work). The reason is traced (`brain.route.fallback`) and emitted (`brain:fallback`) to the UI. Command verification applies only when running commands *is* the request (`requestsChanges` false).

## Recovery

The budget journal records in-flight snapshots; on the next start each unresolved task is reported in the init warnings **and** saved to the run history as `FAIL / interrupted` with the unreconciled exposure. Nothing is resumed and no paid request is repeated. Orphaned child processes started by a crashed Orca are outside its control; the warning says the workspace should be checked.

## Tests

`packages/orca-core/src/lifecycle.test.ts` (transitions, terminal immutability, drain/interrupt, tracking), `runtimeCancellation.test.ts` (Stop during worker/approval/repair/model request, late callbacks, double Stop, COMPLETED vs FAILED, partial evidence), `apps/desktop/src/taskSession.test.ts` (the `Promise.race` reproduction and its fix, watchdog, double Stop, sequencing), `routingPolicy.test.ts` (objective preservation, fallback roles).

## Limitations

- An MCP tool that ignores the abort signal cannot be interrupted; it is tracked and reported, not killed.
- The desktop watchdog releases the lock after 30 s of unsettled operations; the UI says so, and the next task runs in a workspace that may still change.
- Lifecycle tracking is in-process; a crash leaves only the journal's budget snapshot (no per-operation record).
- Targeted evidence collection (asking a worker for one missing receipt instead of a full repair) is a recommendation, not implemented: Pappy's `evidenceRequests` already name the exact evidence; the repair loop could send only those as the repair instruction when the only unmet criteria are insufficient-evidence findings (not contradictions), keeping the original task, criteria and budget. That needs a design review of the repair prompt contract and Maestro's AHP packets.
