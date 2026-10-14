# Desktop validation checklist (phase 6, manual)

A human runs these against the **source** build in an isolated profile with the network-free mock provider. Nothing here approves a dialog automatically; every native dialog is answered by the person running the checklist.

Setup (repo root):

```
pnpm --filter @clawde/desktop build
node scripts/desktop-validation/mock-provider.mjs 3939
node scripts/desktop-validation/launch-isolated.mjs --budget 0.05
```

Record the result of each row in `PROJECT_STATE.md` ("Last verified tests") with the date and the profile path. The profile is disposable; delete it afterwards.

| # | Check | Do | Expect |
|---|---|---|---|
| 1 | Application startup | Launch as above | Window opens; init warnings mention no missing roles; no "fetch failed". Status line shows "$0.0000 of $0.05 confirmed". |
| 2 | Provider configuration | Settings → Providers → Mock | Billing select shows "local"; changing it to "unknown" and saving makes the next run refuse under the hard budget ("billing is not classified…"); set it back to local. |
| 3 | Native approval dialog | Send `Run echo orca-validation and report the output.` | The worker asks to run `echo orca-validation`; the approval dialog appears with the exact command; task state shows "Waiting for your approval." |
| 4 | Approve / Deny | Approve once; repeat the message and Deny | Approve: the command runs, output "orca-validation" appears, Pappy result shown. Deny: the worker reports "denied by user"; no command ran; final state not verified. |
| 5 | Approval timeout | Send the message, do nothing for 60 s | Dialog auto-denies; same outcome as Deny; no second dialog. |
| 6 | Stop during an active request | Send `SLOW tell me a story` then press Stop | Reply "Stopped." at once; "Stopping — waiting for 1 operation…" then "Stopped — all operations settled."; run history shows the run as cancelled; budget shows the request unreconciled or settled, never $0 with a dispatched request. |
| 7 | Stop while approval is pending | Trigger the approval dialog (row 3), press Stop, then click Approve | The command does **not** run; state CANCELLING → CANCELLED; no second dialog. |
| 8 | Task state badges | After rows 4 (approve) and 4 (deny) | Badge row "Task state": "completed and verified" only after Approve with Pappy PASS; "completed, not verified" or "failed" otherwise; never green after Stop. |
| 9 | Brain fallback visibility | Send `BADPLAN run echo orca-validation` | System line "Planning fell back: Brain invalid_plan…"; the task still runs with the original goal; trace shows `brain.route.fallback`. |
| 10 | Budget refusal display | Send `BIG write a very long essay` | Refusal names the limit ($0.05) and Settings → General; no request leaves the mock (its console shows nothing for the big request). With `--budget 0.10` (legacy wording test is unit-tested; here confirm the user-set wording). |
| 11 | Pappy verification result | Row 4 Approve | Pipeline badge shows the verdict and the evidence status; "command verification" criteria are listed and met. |
| 12 | Interrupted-task recovery after restart | Send `SLOW …`, wait for "Stopping…", kill the Electron process from Task Manager, relaunch with the same `--profile` | Init warning: "A previous session ended with task … still running … Up to $… may have been charged"; run history has a `FAIL / interrupted` row; if the warning lists a workspace protection, the banner shows it with the recovery text. |
| 13 | Workspace lock behaviour | Send `SLOW …`, press Stop, immediately send another message; then wait | Second message refused: "The previous task is still stopping…"; after settlement the next message runs. To see the protection banner: start `node -e "setTimeout(()=>{},120000)"` via a worker command (`Run node -e "setTimeout(()=>{},120000)"`), approve, press Stop, wait 10 s → task INTERRUPTED, banner "Workspace … is protected … tool run_command"; when the process ends the banner clears by itself; alternatively click "I accept the risk — override protection": the native dialog is titled "Override workspace protection", says Orca has NOT confirmed the workspace is quiet, lists the unsettled process, and defaults to Cancel; confirming clears the banner with the system line "Workspace protection overridden — recorded as your decision, nothing was verified or stopped". |

What cannot be checked here: real provider behaviour (usage reporting, cache tokens, cancellation billing) — a supervised live run with a small hard budget is listed in `docs/ORCA_PRE_MERGE_VALIDATION.md` §14.
