# ORCA 1.6.1 Live rehearsal remediation

Validated locally on 2026-10-08. Fixes and this report are committed together on
`recovery/summit-demo-mode-1.6`, starting from
`33d02633b8e490c8cda8c20bcd98e7a34e23b403`. All earlier recovery commits remain
ancestors. No additional Live AI run, authenticated catalog request, or paid
API request was made during this remediation.

## Root causes and corrections

### Budget enforcement

The rehearsal's saved budget was $3. Settings loading and `effectiveSettings`
preserved it, and desktop runtime initialization passed it as `budgetUsd`.
However, desktop `runGatedLLMCall` supplied default gate values of zero spent
and an infinite limit. The shared loop also used a neutral zero/infinity
context. Those trace values described the actual gate inputs, rather than a
settings serialization error.

The old runtime budget check governed repairs after the initial worker run.
It depended on `metadata.costUsd`, which was absent and consequently treated
as zero. There was no reliable initial-request spending restriction and no
reservation for in-flight requests. The rehearsal's actual billed spending
cannot be established from its saved evidence; this change does not recover
missing historical usage or undo charges.

Transport adapters could return provider usage, but the direct LLM service
discarded it when returning only text. Agent response traces also omitted
usage, and streaming without a usage chunk invented completion counts from
SSE chunks and a zero prompt count. Neither value is suitable for billing.

An `ExecutionBudget` now spans the complete desktop message through
`AsyncLocalStorage`. Every desktop provider adapter requires that scope.
Planning, worker iterations, synthesis, response presentation, optional
narrator copy, repair attempts, and fallback adapters share its ledger. There
are no automatic background narrator requests at initialization. Miranda
gate contexts and repair checks read the same spent and reserved exposure.

Before transport dispatch, the ledger atomically reserves a conservative
maximum: the reviewed model's full input context at its input tariff plus
the explicitly bounded output at its output tariff. Concurrent requests
cannot spend the same available reservation. This deliberately avoids treating
a tokenizer heuristic as a certified input ceiling. Successful responses
settle the reservation using validated integer input/output/total token
counts. Missing, inconsistent, truncated, unexpected-model, failed, or
cancelled in-flight responses retain the maximum as uncertain expenditure
and block subsequent calls, including fallbacks. Abort before dispatch is
checked separately. Estimates are conservative upper costs, not invoices.

Reviewed prices currently cover direct Anthropic `claude-opus-5-5`,
`claude-sonnet-5-5`, and `claude-haiku-5-5` at
`https://api.anthropic.com/v1`. Reservations use a 1M input bound and the
request's output ceiling; Haiku uses its higher prompt tariff. The reviewed
table expires on 2026-11-07. Unknown models, endpoints, metering, invalid
budgets/output limits, and expired prices fail closed for positive budgets.
This includes Ollama: its provider label alone cannot establish billing.
The existing explicit $0/unlimited setting remains available and is recorded
as `limitUsd: null`; it must not be mistaken for a spending guarantee.
Prices and context assumptions were checked against
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Anthropic's documented OpenAI compatibility API exposes input/output/total
usage and supports stream usage options. Budgeted streaming requests demand
usage, require terminal completion, and never retry without usage options.
Missing usage stays unknown. Completion and streaming usage now survive the
direct service and appear in traces. Runtime metadata retains totals through
verification; a redacted `execution-audits/execution-*.json` in the application
profile retains the complete message's final ledger, including later response
presentation, approval events, demo evidence, and cancellation reason.
The renderer displays the final estimated upper expenditure.
These paths were tested with mocked responses, not a paid compatibility call.
See [Anthropic OpenAI compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk).

### Reproduction before editing

The original preset asked for a correction and verification but did not
require reproduction first. The worker's write was therefore authorized by
the old tool boundary before any test evidence existed.

The original Summit Find & Fix preset now activates a demo-specific contract
at the executor boundary for the entire message, including repairs. It requires
original regular files and baseline hashes before any model request. Tool
operations are serialized. Source writes are refused until actual `npm test`
execution returns exit code 1, the original eight test names, seven passes,
and the one named ISSUE.md failure. Denied/timed-out commands have no process
exit receipt and cannot establish a baseline.

The contract records that baseline output and failing name, allows corrections
only through `write_file` to `src/bookings.js`, and protects tests, scripts,
README, and ISSUE.md. Shell tools permit only exact unfiltered `npm test`;
inspection uses file tools. Final verification requires exit code 0, all
original names, eight passes, and the original failing test now passing.
Every subsequent source write invalidates that verification. Incomplete
evidence cannot produce a successful message result. Other presets and
unrelated tasks do not inherit this specific contract.

Pappy still owns quality verification. Its rules, fixtures, verdict semantics,
required receipts, and rejection behavior are unchanged. Only its existing
test-output parsers were exported for the execution guard. Budget and
cancellation stops do not turn Pappy FAIL into WARN or PASS.

### Presenter supervision and cancellation

The prior launch hid the application and used renderer/CDP control without
confirming a visible native window. Renderer approval timeout returned a
generic denial, allowing the worker and automatic repairs to continue. The
approval overlay intercepted the main Stop control. Main-process cancellation
also raced the task promise, potentially releasing the run lock while stale
work was still unwinding.

Summit Live Demo now requires a visible, focused application, refuses attached
debugging/remote-debugging automation, and requires a native presenter
readiness confirmation before model dispatch. The presenter must initiate the
run from the visible app. Programmatic visibility checks alone are not proof
that the presenter can see it.

Per-call decisions are owned by main-process native dialogs, default to Deny,
and provide Stop run. Renderer approval IPC and session-wide auto-approval were
removed. Renderer code can observe pending/status events and request Stop;
it cannot grant approval. An authoritative 60-second timeout closes the native
dialog, records an explicit failure, aborts the run, and ignores late approval.
Unavailable or denied approval also stops execution. The pending overlay and
Escape support Stop, and the native Stop choice records presenter cancellation.
Electron documents cancellable asynchronous dialogs via `AbortSignal`:
[Electron dialog API](https://www.electronjs.org/docs/latest/api/dialog#dialogshowmessageboxwindow-options).

Stop aborts the whole request scope, releases pending/queued approvals, blocks
new model requests and file/tool dispatch, and stops repairs and write rescue.
Shared-loop requests carry the signal and check it after model/tool completion.
Checks after workspace evidence collection, Pappy evaluation, and asynchronous
trace persistence prevent stale success publication. Existing workbench
process-tree termination remains in use. The task lock stays held until the
task unwinds, with a second check after asynchronous initialization to reject
concurrent message dispatch. Settings, execution mode, and Reset Demo cannot
change while a run is active. Cancellation reasons survive in traces/audits.

## Files changed

All paths below are relative to the recovery worktree; 35 files changed.

| Area | Files |
|---|---|
| Desktop execution guards | `apps/desktop/src/executionBudget.ts`, `demoFixContract.ts`, `presenterApproval.ts`, `executionAudit.ts` in the same directory |
| Desktop wiring | `apps/desktop/src/main.ts`, `llmGate.ts`, `providerAdapter.ts`, `agents/ReactAgentAdapter.ts` |
| Presenter UI | `apps/desktop/renderer/app.js`, `apps/desktop/renderer/index.html`, `apps/desktop/src/preload.ts` |
| Desktop declarations | `apps/desktop/src/types/miranda-core.d.ts`, `orca-core.d.ts` |
| Provider usage | `packages/miranda-core/src/llm/types.ts`, `usage.ts`, `openaiCompat.ts`; `packages/orca-core/src/adapters/directLLM.ts` |
| Runtime ledger/cancellation wiring | `packages/orca-core/src/types.ts`, `runtime.ts`, `repairLoop.ts`, `index.ts` |
| Parser exports only | `packages/pappy-core/src/index.ts` |
| Shared execution loop | `packages/agent-loop-core/src/loop.ts` |
| Actual command exit receipts | `packages/workbench-core/src/tools/runCommandTool.ts`, `types.ts` |
| Desktop regressions | `apps/desktop/src/executionBudget.test.ts`, `demoFixContract.test.ts`, `presenterApproval.test.ts`, `preloadApproval.test.ts`, `executionAudit.test.ts` |
| Shared regressions | `packages/agent-loop-core/src/loop.test.ts`, `packages/miranda-core/src/llm/openaiCompat.test.ts`, `packages/orca-core/src/runtime.stress.test.ts`, `packages/orca-core/src/cancellation.test.ts` |
| Report | `docs/ORCA_1_6_1_LIVE_REMEDIATION.md` |

## Validation

| Check | Result |
|---|---|
| Final full workspace suite (`pnpm -r test`) | 1,751 passed, 95 test files; 1 paid integration test skipped; exit 0 |
| Existing desktop authorization tests | 75 passed in the targeted run and included in the full suite |
| Pappy core regression suite | 368 passed |
| Pappy evaluation harness unit tests | 100 passed |
| Shared-loop suite | 16 passed, including model/tool/approval cancellation and finite ledger context |
| Orca runtime suite | 256 passed, including cancellation at each requested stage, late persistence, and ledger-based repair stops |
| Temporary real demo execution | Original 7/1, minimal correction, final 8/0; original test source unchanged |
| Native approval manager tests | Timeout, late approval, hidden/unavailable window, Stop, queue cancellation, and actual non-execution of a marker-writing command passed |
| Renderer approval surface | Mocked Electron preload exposes status and Stop, no approval capability |
| Audit persistence | Token totals retained, configured/pattern credentials redacted, short values cannot corrupt JSON |
| Modified TypeScript libraries | Miranda, Orca, shared loop, workbench compiled successfully |
| Desktop compile and renderer syntax | Main/preload bundles and `node --check` passed; development output only |
| `git diff --check` | Passed |
| Strict contract check against remediation base | Exit 0; one REVIEW REQUIRED marker for internal `gate_blocked` handling; no BLOCKED finding |

The contract marker was inspected: shared-loop `gate_blocked` is mapped to the
existing internal agent `error` state rather than falsely reporting `done`.
It is not a new user-facing status or a transfer of authority. The user's
explicit remediation and commit authorization covers these execution fixes;
no merge or release was performed. The broader branch comparison also flags
already-preserved Pappy remediation, which was not changed by this task.

The optional DashScope integration key was removed only from child test-shell
environment, so no paid test ran and user credentials/settings were untouched.
No new tests invoke a real model provider.

### Pappy corpus results that remain unresolved

| Judge | Result | Cheat catch | False accept |
|---|---|---|---|
| Reference | 23/23 passed | 100% | 0% |
| Raw real Pappy | 14/23 passed, 9 failed; exit 1 | 100% | 0% |
| Pappy plus hardening | 14/23 passed, 9 failed; exit 1 | 100% | 0% |

Raw failures: clean_success-002/003, scope_drift-001/002,
partial_success-001/002/003, accepted_but_not_trainable-001/002.
Hardening failures replace the two scope_drift failures with
honest_failure-001/002. Both modes report a 57.1% false-reject rate.
The harness mapping drops richer test/diff evidence and has different verdict
and training-eligibility expectations. These failures are not a green corpus
result. The Pappy evaluator, checks, fixtures, and corpus implementation are
identical to the starting commit; they were not loosened to satisfy the corpus.

Complete local logs are under
`apps/desktop/release/remediation-1.6.1/`: `workspace-tests-final.log`,
`pappy-reference.log`, `pappy-raw.log`, `pappy-hardening.log`,
`contract-check.log`, `preservation.json`, and `kit-preservation.json`.

## Preservation and remaining risks

- `main` remains `0058052a28d5ee28ec01fc4aeac130fccacc69f6`.
  Original kit inventory: 46 files checked, zero changed. Production settings,
  authentication, Local State, and user context match the saved preservation
  hashes. Existing staging executable and app.asar also match their hashes.
- Existing staging remains built from `33d02633...` and does not contain these
  fixes. Only ignored library/development bundles were compiled. No installer,
  installed application, Summit kit, or staging package was rebuilt/replaced.
  The failed rehearsal's demo workspace and evidence were preserved.
- Under the unchanged $3 cap, the configured Opus Brain cannot reserve its
  full input bound (input alone is $4), so execution safely stops before a
  request. A separately approved staging configuration/build would need a
  priced model that fits the cap, or a tighter certified input bound. No role,
  budget, credential, or model setting was changed here.
- Unknown pricing, provider aliases, unexpected response IDs, incomplete usage,
  and expired tariffs deliberately stop constrained runs. Live compatibility
  and real invoice reconciliation remain untested without separate permission.
- Native UI behavior was compiled and tested through a mocked host. Presenter
  visibility and physical approval dialogs still need manual validation in a
  newly built staging app. Removing approval IPC prevents self-approval through
  application automation; it does not sandbox arbitrary OS automation running
  with the user's desktop privileges.
- Cancellation cannot reverse charges or edits already completed. In-flight
  provider charges remain reserved/accounted, and supported command processes
  are terminated. Tools that ignore cancellation cannot be made interruptible
  by an application-level signal; further dispatch is blocked.
- The real-Pappy corpus failures remain open. Pappy was not weakened.

Stop point: fixes committed locally; no push, merge, publishing, installer, or
another Live AI rehearsal. The existing staging application is not ready to
rehearse these fixes until a separate build and presenter-visible validation.
