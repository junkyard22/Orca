# ORCA 1.6.1 supervised Live AI rehearsal — FAIL

The single rehearsal did not reproduce or verify the bug. The worker genuinely read the isolated demo and wrote a minimal source correction, but changed the source before requesting tests. Both `npm test` calls were denied; neither executed. Pappy correctly returned FAIL. The run was aborted and staging closed. No full-run retry was started.

Run ID: `run_1791481269839_hskqtl`.

Source: `recovery/summit-demo-mode-1.6` at `33d02633b8e490c8cda8c20bcd98e7a34e23b403`. The recovery worktree remains clean at this commit. No application source was edited, rebuilt, merged, pushed, or repackaged during this rehearsal.

Executable: `C:\Orca\.claude\worktrees\summit-recovery\apps\desktop\release\Orca-Summit-Staging-1.6.1\win-unpacked\Orca Summit Staging.exe`.

Profile: its sibling `profile` directory. Effective workspace: `profile\orca-demo\workspace`. Saved workspace is empty; Demo Mode correctly overrides it to this isolated workspace, confirmed by runtime context and file-write receipts.

## Preflight and supervision

Staging identifies itself as Orca Summit Staging 1.6.1 and uses the isolated profile for userData and sessionData. The Anthropic provider key was configured and compared without disclosure. Debugger was assigned through the normal settings UI to existing provider `prov_d833`, model `claude-sonnet-5-5`. GitHub MCP and Desktop Commander were disabled through staging settings. Original demo files were reset through Reset Demo and their hashes matched the packaged buggy baseline, including the original failing test. Demo Mode remained active, strict execution-time authorization remained enabled, and “Always approve” stayed unchecked.

The presenter explicitly confirmed “Ready—check models, then run once.” The subsequent authenticated catalog check through staging's Fetch models UI returned 13 account model IDs, including all three active Claude models. Live initialization then succeeded. No paid request preceded this confirmation.

The automation launch used `windowsHide:true` and did not verify a visible, foreground staging window with the presenter. The presenter subsequently reported “I don't see the rehearsal?” This was an operator/automation supervision failure; the absence of an approval must not be attributed to an intentional presenter refusal. A CDP renderer screenshot proves that the interface rendered, but does not establish that the presenter could see the native window.

## Exact timeline

Times below are UTC on 2026-10-08; subtract four hours for Eastern Daylight Time.

| Time | Observed event |
| --- | --- |
| 17:36:51.135 | Profile, settings and buggy baseline checks recorded. |
| 17:38:20.547 | Explicit presenter readiness recorded. |
| 17:38:21.125 | Authenticated catalog returned 13 models; required IDs present. |
| 17:38:44.858 | Live AI runtime initialized successfully. |
| 17:41:09.785 | Original Find & Fix preset clicked once. |
| 17:41:09.839 | Runtime task created. |
| 17:41:12.708 | Brain returned a valid direct Debugger route with four criteria. |
| 17:41:13.957 | Worker successfully read ISSUE.md. |
| 17:41:15.293–17:41:16.527 | Worker listed workspace and src directory. |
| 17:41:18.168 | Worker read original src/bookings.js. |
| 17:41:22.386 | Worker wrote src/bookings.js, before any test run. |
| 17:41:23.727 | First npm test approval requested; dialog appeared at 17:41:24.844. |
| 17:42:23.733 | Approval timed out; tool result recorded denial, with empty output. |
| 17:42:30.229 | Initial worker completed with an explicitly unverified result. |
| 17:42:30.264 | Pappy returned FAIL, confidence 0%, five HIGH and two LOW issues. |
| 17:42:30.271 | Orca automatically began internal repair pass 1. |
| 17:42:33.271–17:42:36.893 | Repair worker reread the issue and already-modified source. |
| 17:42:38.823 | Second npm test approval requested. |
| 17:42:38.914 | Operator clicked Stop, but the modal intercepted the click; busy remained true. |
| 17:43:16.292 | Operator explicitly clicked Deny on the second pending command, to cancel the run. |
| 17:43:16.407–17:43:16.408 | Stop clicked after dismissal; worker stopped and runtime recorded ABORTED. |
| 17:43:17.368 | UI displayed Stopped; no completed repair verification. |
| 17:43:29.649 | Staging closed; production-preservation checks recorded. |
| 17:45:20.417 | Independent process check confirmed staging closed and no MCP candidates. |

The runtime duration is **126.569 seconds**. Automated internal repair began before the operator could halt the run; it was not a separately launched demonstration. The operator did not stop at the earliest failure: the source-before-tests violation was discovered from the saved receipts, and the approval failure was followed by automatic repair before successful cancellation. This limitation is recorded rather than presenting the run as compliant with the requested stop timing.

## Models and provider assignments

All configured active roles use existing Anthropic provider `prov_d833`, base URL `https://api.anthropic.com/v1`. No key values are included here.

| Role | Model | Observed use |
| --- | --- | --- |
| Brain | claude-opus-5-5 | Real routing request succeeded; no planning fallback. |
| Debugger | claude-sonnet-5-5 | Initial worker and automatic repair. Selection trace records debugger_primary. |
| Reviewer | claude-opus-5-5 | Configured, but no independent reviewer model request recorded. |
| Utility / strong_model | claude-sonnet-5-5 | Configured; no separate call recorded. |
| Narrator / cheap_model | claude-haiku-5-5 | Configured; standard progress copy and aborted response observed, no model call recorded. |

Optional planner_deep/reader/vision are unassigned. OpenRouter `prov_edd8` remains configured but is not assigned to an active role in this run. Inactive legacy coder_strong/coder_cheap entries remain stale and are ignored by the current role list; they were not changed.

Brain preserved the original preset's requirements: identify the root cause, make a minimal source change, leave tests unchanged, run the suite and confirm resolution. It did not add the supervision requirement to reproduce the original failure before writing. The original preset and its acceptance criteria were not altered for the rehearsal.

## Genuine work, tests and source difference

Receipts record successful reads/listing and a successful write of `src/bookings.js`. Only this demo source file changed. Tests, ISSUE.md, package.json and README.md match their original hashes. The exact content comparison proves that the two comparison operators on one line are the entire change:

```diff
-  return first.start <= second.end && second.start <= first.end;
+  return first.start < second.end && second.start < first.end;
```

This matches the documented half-open interval rule and is a plausible minimal correction. It remains unverified by execution.

| Test phase | Required result | Actual evidence |
| --- | --- | --- |
| Original suite before source modification | 7 passing, 1 failing | Not executed; the source was changed first. |
| Full suite after last source change | 8 passing, 0 failing | Not executed; both npm test requests were denied. |

Actual passing/failing counts are **unknown**, not zero. No test output exists. No shell test was run outside the app to substitute for missing worker evidence. The modified demo is preserved with before/after snapshots and source.diff; it has not been reset after the run.

## Pappy's actual findings

Initial verdict: **FAIL**, confidence **0%**, five HIGH and two LOW findings. Review metadata: `review_independence=not_applicable`, `review_fallback=false`. The packaged desktop creates a Pappy port without supplying an LLM reviewer. These findings are genuine independent rule checks over worker evidence; this run does not prove that a separate reviewer model performed semantic verification.

| Severity | Code | Finding |
| --- | --- | --- |
| HIGH | TOOL_FAILURE | run_command failed; downstream verification cannot be trusted. |
| HIGH | FIX_TEST_RESULT_UNREADABLE | No recognizable final test summary. |
| HIGH | REQUIRED_RECEIPT_MISSING (AC1) | Missing structured root-cause receipt. |
| HIGH | REQUIRED_RECEIPT_MISSING (AC3) | Missing passing-suite receipt. |
| HIGH | REQUIRED_RECEIPT_MISSING (AC4) | Missing confirmed-resolution receipt. |
| LOW | COMPLETENESS_GOAL_COVERAGE | Lexical coverage measured at 45%. |
| LOW | UNSAFE_FUNCTIONAL_PATTERN | Flagged `exec(` as potentially unsafe. |

The unsafe-pattern finding refers to the existing `TIME_PATTERN.exec(...)` regular-expression call, which the worker did not change. The actual one-line diff contains no new exec/eval/shell construct. This is a diagnostic false positive. The worker's natural-language response does explain the root cause, while Pappy reports the criterion-specific structured receipt missing. Neither observation cancels the decisive missing test evidence. Pappy did not approve incomplete work and its verdict was not overridden. No completed Pappy verdict exists for repair pass 1.

## Permissions, compatibility and cost

Both command attempts reached the normal presenter approval mechanism. The first timed out; the second was explicitly denied by the operator to cancel. No command was auto-approved, no “Always approve” selection was made, and no successful run_command receipt exists. Successful operations stayed inside the demo workspace. There were no observed GitHub writes, external repository operations, Desktop Commander calls, or out-of-workspace file operations. No execution-time authorization bypass was observed.

Live startup registered **14 tools, zero from MCP**. A flawed regex in the helper's initial process sampler produced errors and null MCP classifications, so those samples are not reliable evidence of continuous process absence. Independent corrected read-only checks found no actual MCP server process, and the final corrected check found no staging, Docker/npx, GitHub MCP or Desktop Commander process. The transcript's intermediate query matched its own PowerShell command text; that entry was not an MCP process. Absence throughout every instant was not independently sampled.

No Anthropic HTTP/API compatibility error was recorded. Brain and Debugger returned genuine results using the configured models. The preflight correction omitting unsupported enable_thinking remains in the unchanged packaged application; this run does not establish every optional Anthropic API feature's behavior. The abort-related worker error was `Stopped.`, not an API compatibility error. Worker format warnings about missing Thought blocks were nonblocking and tool parsing continued.

The trace records **14 completed LLM gate checks and one additional started call interrupted during cancellation**: one Brain result, seven initial worker results and six repair worker results. These are logical call observations, not audited upstream billing records. Token counts and billed cost were not retained, so expenditure is **not measurable from this evidence**. It must not be reported as $0. The settings budget is $3, but every recorded before_llm_call gate shows `budgetUsed=0` and `budgetLimit=Infinity` (serialized as null). The runtime passes a budget to repair checks, but this trace does not prove a functioning $3 ceiling or accurate spend tracking. Cost accounting and limit propagation need investigation before another paid rehearsal.

## Pipeline and final response

Plan succeeded; initial work produced a real file change but failed required verification. Pappy rejected the result; repair pass 1 began and was aborted. Final runtime status is ABORTED, last Pappy verdict FAIL. The screenshot shows PLAN checked, BUILD failed, VERIFY paused and DONE pending, with Stopped outcome. The tracker retains a re-verifying entry created around cancellation; that is not a completed successful verification. The final user-facing response was **“Stopped.”** and the outcome card said **“The run was stopped before it finished.”** No successful Benson completion narrative was produced.

## Preservation, preflight count discrepancy and next action

Rehearsal before/after hashes confirm production settings, encrypted-key metadata, auth and Dewey context unchanged. The earlier protected-file inventory contains 46 records; rechecking all 46 found no changes, including the original Summit kit/patch files. Four production-profile/context files were also checked separately; these inventories overlap and are not added into a new unique-file total. Executable and app.asar hashes still match the built artifact manifest. Recovery branch and all commits remain preserved; main remains at `0058052a28d5ee28ec01fc4aeac130fccacc69f6`. Only staging settings, staging run/context artifacts, the isolated demo correction and this separate evidence directory were written.

The earlier **1,676** figure describes the reported full-workspace run. The **849 passed, 1 skipped** preflight result covers six selected regression scopes: Desktop 307, Miranda 163, MCP client 44, ORCA core 248, Workbench 55 and Dewey 32. Those sum to 849. Other workspace packages/suites were not included in that targeted preflight command. Thus the figures have different scopes and do not establish a loss of 827 passing tests. An original full-workspace log was not located, so an exact historical package-by-package reconciliation is not independently verified. No regression suite was rerun during this rehearsal because application source did not change; the demo tests did not execute.

Recommended next action, requiring separate authorization: investigate and correct reproduce-before-edit enforcement, stop-on-denial/cancellation behavior and spend tracking in source, with meaningful regression coverage. Review Pappy's unchanged-RegExp false positive and receipt mapping separately without relaxing its evidence requirements. Before any separately authorized paid retry, launch staging visibly, have the presenter confirm the actual window and approval controls, reset the demo through Reset Demo, and verify the original file hashes. Then require the real 7/1 baseline receipt before any write and the full 8/0 post-edit receipt. This build is **not yet demonstrated ready for a trustworthy supervised Find & Fix completion**.

Evidence files here: preflight.json, account-model-catalog.json, timeline.jsonl, run-events.redacted.json, run-analysis.redacted.md, receipts.redacted.json, workspace-comparison.json, workspace-before/, workspace-after/, source.diff, test-execution.json, outcome.png, production-preservation.json, kit-preservation.json, artifact-preservation.json and final-process-check.json. The local encrypted settings snapshot is retained only as a protected staging audit aid; it is not included in the report or shared receipt exports.

No further API calls, demonstration attempts, source corrections, rebuilds, installers, kit replacements, publication, pushes or merges were performed after stopping.
