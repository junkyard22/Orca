# Orca 1.7.0 — Core Reliability: Release Readiness Report

**Date:** 2026-10-13 · **Machine:** dev desktop (Windows 11, Node 24.11.1, pnpm 10.30.2, Electron 41.10.5, electron-builder 26.15.7) · **By:** Claude Code session under the human's "Final Production Release Preparation" brief.

**Summary.** Orca 1.7.0 is built from local `main` at `cd5b427e` as an unsigned Windows release candidate. The package is clean (bundle + renderer only), the application reports its own version and build, cancelled runs are represented honestly everywhere they are read, a start-up race found by the packaged acceptance is fixed, the full regression is green (1,912 passed), and the candidate passes every acceptance check that automation may perform in isolated profiles against the mock provider. Classification: **SOURCE INTEGRATED** and **RELEASE CANDIDATE VALIDATED — pending the human-only native-dialog checks** (those remain PENDING; nothing was fabricated). The real-provider rehearsal is prepared and **not started**: it requires your authorization (§10). Nothing was pushed, installed or published.

---

## 1. Final branch and commit

| Item | Value |
|---|---|
| Branch / worktree | `main` in `C:\Orca\worktrees\main-rc` (clean tree) |
| Starting point of this phase | `3bec956` (production integration report) |
| Commits added (all local, none pushed) | `6ef0f78` fix(export): runs stopped before completion are never training examples · `0aef6bf` release(desktop): Orca 1.7.0 — version, build identity in the app, honest history for stopped runs, lean asar · `cd5b427` fix(desktop): deliver init-status only once the renderer can receive it · plus the docs commit recorded in PROJECT_STATE |
| Release candidate built from | `cd5b427e27040a54b977e19f691eb5019ad4e459`, `ref: main`, `dirty: false`, built 2026-10-13T16:37:46Z |
| `origin/main` | `7b62cce`, unchanged; local `main` is 62 commits ahead before the docs commit |
| Preserved untouched | `integration/core-reliability` (`9018cb3`), `feature/summit-demo-mode` (`1e87212`), the installed Orca 1.6.0 in `C:\Program Files\Orca` (last written 2026-10-07), `%APPDATA%\Orca`, `C:\Orca\Orca` (`fix/live-demo-verification`, 27 uncommitted files) |

## 2. Version changes

- `apps/desktop/package.json`: `1.6.0` → **`1.7.0`**, description "Orca — AI coding assistant desktop app (1.7.0 Core Reliability)". This is the only production-facing version source: electron-builder names the artifacts from it, stamps the Windows file metadata from it (verified: FileVersion 1.7.0, ProductVersion 1.7.0, ProductName Orca on both executables), and `build-main.mjs` writes it into `build-info.json`. Internal packages stay at their private `1.0.0`.
- **Runtime version reporting (new):** `ipcMain.handle("app:build-info")` reads `dist-main/build-info.json` beside the bundle; the renderer shows "Orca 1.7.0 · build cd5b427e" under the welcome text (tooltip: ref and build time) and sets the window title to "Orca 1.7.0". A build from a modified tree is shown with "(modified source)". Verified in the packaged app: title `Orca 1.7.0`, line `Orca 1.7.0 · build cd5b427e`, tooltip `ref main · built 2026-10-13T16:37:46.853Z`.
- There is no About dialog in the app; the welcome line and the title are the in-app identity. `build-info.json` also sits beside the artifacts.
- **1.6.0 → 1.7.0 compatibility:** verified on synthetic profiles in the previous phase (SQLite 3/3, settings 7/7; `docs/ORCA_PRODUCTION_INTEGRATION_REPORT.md` §7) and again live in this phase: a 1.7.0 profile's Settings save kept all 8 role assignments, the provider list and billing, and changed only the budget the user edited. Providers, model assignments, API keys, custom providers, budgets, run history, MCP configuration and other preferences are not discarded (the loader keeps unknown-to-1.6.0 fields optional; the DB migration adds nullable columns only). No real profile was touched.

## 3. Packaging cleanup results

| | Before (1.6.0-RC @ 9018cb30) | After (1.7.0 @ cd5b427e) |
|---|---|---|
| `app.asar` | 44,260,791 bytes, **2,969 entries** (`node_modules` 2,948 incl. workspace `src/*.ts` and 215 test files) | **11,536,425 bytes, 21 entries** (dist-main: main.js, preload.js, sql-wasm.wasm, build-info.json; renderer: 15 files; package.json) |
| Portable `Orca x.y.z.exe` | 121,128,694 bytes | 116,016,511 bytes |
| Installer `Orca Setup x.y.z.exe` | 121,627,015 bytes | 116,514,909 bytes |
| `node_modules` in package | yes | **none** |
| tests / `.ts` sources / `.map` | 215 / many / 0 | **0 / 0 / 0** |

Change: the workspace packages and `dotenv` moved from `dependencies` to `devDependencies` (esbuild inlines them into `dist-main/main.js` via the alias map; `sql-wasm.wasm` is copied beside it), and `!node_modules/**` was added to `build.files`. Verified module-loading paths: the bundle's only external `require` is `electron`; the remaining literal `require("ajv/dist/runtime/…")` strings are ajv's *standalone code-generation* templates (`.code` fields used only when `opts.code.source` is set, which nothing does) and are not executed at runtime. The packaged app starts, loads providers and tools, opens its database (migrations run at open), runs Brain, workers, Miranda and Pappy — all exercised in §8. Nothing dynamically loads from `node_modules`. The 1.6.0-RC remains for comparison under `C:\Orca\rc-artifacts\orca-1.6.0-rc-9018cb30\`.

Confirmed on the final package: no credentials or secrets (patterns `sk-or-`, `sk-ant-`, `ghp_`, `AKIA`, private-key headers, `C:\Users\<name>`: none), no `.env`/log/db/profile, no mock-provider or validation script, no development documentation, no CLI artifact (`apps/runner` is private and absent).

## 4. Cancellation persistence findings

Persisted convention: a stopped run is `status = FAIL`, `stopped_because = cancelled | interrupted`, and (unless Pappy had judged before the stop) no verdict. Reviewed every consumer; defects found and fixed, invariant documented in `docs/ORCA_TASK_LIFECYCLE.md` §"Persisted form of a stopped run (1.7.0)":

| Consumer | Finding | Action |
|---|---|---|
| Desktop history sidebar / reopened session | read `status` alone: listed stopped runs as failed and said "This run failed — no output was recorded" | **fixed** (`0aef6bf`): reads the pair; stopped runs are listed as stopped and reopen with "This run was stopped / interrupted before it finished — no verdict was recorded" and a CANCELLED / INTERRUPTED outcome panel. Verified in the packaged app (§8). |
| Moonshiner export | filtered by verdict only: a run cancelled after Pappy had judged it could have been exported (positive or negative) | **fixed** (`6ef0f78`): cancelled/interrupted runs are skipped first (`stopped_before_completion:<reason>`), whichever verdict is requested. Regression: `stoppedRuns.test.ts` (6 tests). |
| Pappy | never reads persisted runs; cancellation produces no verdict | none needed |
| Start-up recovery | writes `FAIL` + `interrupted` + `cost_basis upper_bound` | consistent; unchanged |
| `getStats().passRate` | counts PASS verdicts over all runs; a stopped run lowers it like any unjudged run; the app does not use it | documented |
| Retry / repair | nothing retries from persisted status; no repair after cancellation | none needed |
| Future reporting | must read the pair; documented | — |

No historical row was rewritten; the schema is unchanged.

## 5. Complete test results (release commit `cd5b427`, run from the `main` worktree)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test` | **1,912 passed · 0 failed · 1 skipped** (baseline 1,903 + 6 export tests + 3 init-status tests): maestro 75 · dewey 32 · benson 133 · miranda 236 + 1 skipped · workbench 63 · pappy-core 397 · pappy-eval 152 · orca-core 322 · ext-docs 14 · ext-github 18 · ext-web 12 · mcp-client 44 · agent-loop 12 · runner 107 · desktop 295 |
| `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| Desktop build (`build-main.mjs`), renderer `node --check` | OK |
| `pnpm contract:check` | REVIEW REQUIRED: **15 × Rule 4 + 1 × Rule 5, 0 BLOCKED** — exactly the dispositioned findings |
| Pappy suites (run at `0aef6bf`; no Pappy or evidence package changed afterwards) | 23/23 · 12/23 · 15/23 · **49/49** (FA 0/33, FR 0/11) |
| Migration tests on synthetic data | SQLite 3/3, settings 7/7 (previous phase, same migration code) |

Miranda authorization, Moonshiner export, Maestro lifecycle and cancellation, process-survivor, Brain routing and fallback, budget accounting and concurrency, provider compatibility tests are all inside the full suite. No test was suppressed or relabelled.

## 6. Packaged executables — names, locations, hashes

Location: `C:\Orca\worktrees\main-rc\apps\desktop\release\` (gitignored), marker `RC-NOT-FOR-DISTRIBUTION.txt` ("ORCA 1.7.0 — RELEASE CANDIDATE — NOT FOR DISTRIBUTION").

| File | Size | SHA-256 |
|---|---|---|
| `Orca 1.7.0.exe` (portable) | 116,016,511 | `BEFF45597054A9829D94EA29240C90C9948F8EC3CB12D6EA962E6BB173CA21A8` |
| `Orca Setup 1.7.0.exe` (NSIS, per-user, never executed) | 116,514,909 | `146DA57FD4FCCFC177F88A24FDD7E28420580F0F72D310E40ECFE1B9C57F369A` |
| `build-info.json` | 186 | `7A18DCFFC6574D047AD2AC57CD9EA87C637D17ACB7CA1681E2417AD0E020AC02` |

**Signing: UNSIGNED.** `Get-AuthenticodeSignature` → `NotSigned` for the portable, the installer and `win-unpacked\Orca.exe`. electron-builder logs "signing with signtool.exe" regardless; that line is not a signature. No signing identity or credential exists in this environment and none was created. Electron fuses: `onlyLoadAppFromAsar`, `enableEmbeddedAsarIntegrityValidation`.

Superseded builds kept for the audit trail: `C:\Orca\rc-artifacts\orca-1.7.0-rc1-0aef6bf8\` (before the init-status fix) and `orca-1.6.0-rc-9018cb30\`.

## 7. Package size comparison

See §3: asar 44.3 MB → 11.5 MB (−74 %), portable 121.1 MB → 116.0 MB, installer 121.6 MB → 116.5 MB. The executables are dominated by the Electron runtime (~104 MB), which is unchanged.

## 8. Packaged desktop acceptance (release candidate `cd5b427e`, isolated profiles, mock provider, no network, no credentials)

Set-up: portable EXE launched through the isolating launcher (`--user-data-dir`, scratch `USERPROFILE`/`HOME`/`TEMP`; every role on the mock at `127.0.0.1:3939`; observation over the DevTools port with `observe.mjs`, which cannot reach native dialogs and never answered one). Three instances were started **concurrently** (profiles e, f, g) to re-create the start-up race; all three reached "ready" in ≈2 s. Evidence (`rc-e-*`, `rc-f-*`, `rc-g-*` screenshots/transcripts, launcher and mock logs) under `%LOCALAPPDATA%\Temp\orca-audit\phase6\rc\`.

| Check | Result |
|---|---|
| **Basic** — starts; correct version ("Orca 1.7.0 · build cd5b427e", title "Orca 1.7.0"); Settings open and save (budget 0.05 → 0.04 written, roles/providers untouched); providers configured from settings; a normal request runs; Brain plans ("I'm planning the approach", route direct → strong_model); worker receives the assignment; pipeline shows live progress; completed task shows the outcome (Pappy FAIL on the mock's canned reply: 3 issues, 1 repair, honest FAIL) | **PASS** (automation) |
| **Authorization** — approval card appears; tool `run_command` and the exact command visible; workspace identified; **Deny focused (safe default)**; "Always approve" unchecked; timeout → **Denied**, worker reports "not approved, did not run", zero executions, Pappy FAIL; global Stop with a card open dismisses it and cancels (witnessed on the source build 2026-10-13; the same code is in the package) | card rendering, Deny default, timeout: **PASS (automation-observed)**; **Approve / Deny clicks, the "Denied" card and "no late approval revives a cancelled task" in the packaged build: PENDING human** (automation never answers approvals) |
| **Verification** — Pappy rejects the unsupported reply (FAIL with named issues); incomplete requirements stay unverified; a cancelled task shows "Verdict: none — task cancelled before Pappy judged it"; eligibility follows the recorded tags (unit/corpus-tested; mock runs are never eligible) | **PASS**; genuine PASS on a real fix is a live-rehearsal item |
| **Budget** — $0.01 hard limit with a $10/M priced metered provider: **refused before dispatch** ("reserving $0.0326 … would exceed the remaining task budget of $0.0100", 0 tokens, mock received nothing); provider with unknown billing and no price under a hard budget: **refused before dispatch** ("Budget refused_pricing_unknown … classify its billing or set a price"); reported costs match the mock's usage (4,200 in / 840 out → $0 at local billing); a request cancelled after dispatch is kept as **1 unpriced** (unreconciled upper bound) | **PASS** |
| **Recovery** — a protection with a live stand-in process planted in the profile; relaunch: start-up notice + banner name the task and pid; a new request is refused without dispatch ("Not started: the workspace is still protected…"); the process ended → protection lifted by verification in ≤ 2 s ("Workspace released (every process verified gone)"); the override button is shown and was **not pressed** | **PASS** (re-run on the final build `cd5b427e`: notice and banner on relaunch, refusal without dispatch, lifted by verification 4 s after the process ended, protection file back to empty) |
| **History** — the stopped run is listed as stopped and reopens with the stopped message and a CANCELLED panel; failed runs reopen with their FAIL badge | **PASS** |

Defect found by this acceptance and fixed: with three instances starting at once, one window stayed on "starting…" (init-status sent before the renderer's listener existed; re-running init delivered it). Fixed in `cd5b427` (`sendWhenLoaded`), unit-tested, and the rebuilt candidate started all three instances cleanly.

## 9. Pending human checks (packaged 1.7.0 candidate)

Launch (nothing of your real profile is touched; the mock provider must be running on 127.0.0.1:3939):

```
node scripts/desktop-validation/mock-provider.mjs 3939
node %LOCALAPPDATA%\Temp\orca-audit\phase6\rc\launch-packaged.mjs --exe "C:\Orca\worktrees\main-rc\apps\desktop\release\Orca 1.7.0.exe" --profile %LOCALAPPDATA%\Temp\orca-audit\phase6\rc\profile-human
```

| # | What to do | What you should see | Status |
|---|---|---|---|
| H1 | Type `run node -e "console.log('hi')" and report` | A card "Tool call request" with TOOL run_command, the exact command, the WORKSPACE path, "Always approve" unchecked, buttons Stop task / **Deny** (focused) / Approve, a countdown | PENDING |
| H2 | Click **Approve** once (never "Always approve") | The command runs once (a `✓` tool card), the worker reports the output, no second approval is needed for the same call; Pappy judges the result | PENDING |
| H3 | Repeat H1, click **Deny** | A `✗ Denied` card; nothing runs; the worker reports it was not approved | PENDING |
| H4 | Repeat H1, wait ~60 s | The card times out as Denied; nothing runs | PENDING |
| H5 | Repeat H1, press the global red **Stop** while the card is open | The card disappears at once; "Stopped — all operations settled"; the outcome panel says CANCELLED; nothing runs afterwards | PENDING |
| H6 | Repeat H1, press **Stop task** on the card | Same as H5 | PENDING |
| H7 | Stop the app; run `node scripts/desktop-validation/stage-override.mjs --profile <that profile>`; relaunch | The protection banner; click "I accept the risk — override protection" → a native dialog "Override workspace protection" with Cancel as the default; press **Cancel** → "Override cancelled." (do not confirm the override unless you decide to) | PENDING |

## 10. Live rehearsal — readiness and authorization status

**Status: PREPARED, NOT STARTED, NOT AUTHORIZED.** No real-provider request has been made by this work. Anthropic startup credits are not authorization.

Proposed configuration (for your decision; nothing has been configured):

| Item | Proposal |
|---|---|
| Provider / model | Anthropic API, **`claude-sonnet-4-6`** — in Orca's reviewed catalog (prices reviewed 2026-10-12): $3 / $15 per 1M tokens (cache read $0.30, cache write $3.75). If you prefer a newer model that is not in the catalog, a custom price must be entered first; Orca refuses unpriced models under a hard budget and the rehearsal must **not** auto-switch models. |
| Hard budget | **$0.50 per task** (typed by you). Refusal path first with a $0.01 budget on a trivial request (expected: refused before dispatch, $0 spent). |
| Maximum exposure | Per task: ≤ $0.50 reserved upper bound, enforced before each request where the provider honours `max_tokens` and reports usage. Across the plan (one refusal test, one fix task, one cancellation task, possibly one repair pass inside the fix task's budget): **≤ $1.00** plus any charge for a request cancelled after dispatch, which Orca records as an unreconciled upper bound inside the same cap. Limitations: Orca cannot cap what the provider bills beyond what it reports; cache writes are modelled, rate-limit retries are not. |
| Isolation | Fresh disposable profile through the launcher with an Anthropic provider instead of the mock; disposable workspace (a small git repo); no MCP servers; API key typed into Settings by you for the session and removed after. |
| Task | A tiny project with one function containing a known defect and a deterministic failing test (e.g. `parse('')` throws instead of returning 0; `node --test`). Objective: "Fix the failing test in src/parse.js and run the tests." |
| Expected | Brain plans a bug fix (route visible); worker edits `src/parse.js`; Miranda asks approval for `node --test` (you click Approve once); host records the changed file and the test run (exit 0, output) on the final source; Pappy PASS **only** with that evidence (otherwise WARN/FAIL with the stated gap); badge shows eligibility (`eligible` only for a verified PASS); cost line with measured usage and `unreconciled $0`. |
| Cancellation task | "run node -e \"setTimeout(()=>{},60000)\" and report" → approve, press Stop at ~10 s: CANCELLING → CANCELLED (or INTERRUPTED + protection); no request after Stop; the cancelled request shown as an unreconciled upper bound; no VERIFIED claim. |
| Outcomes | PASS / PARTIAL / FAIL as defined in `docs/ORCA_PRODUCTION_INTEGRATION_REPORT.md` §13. If a step fails: stop and report; no paid retries. |

**What you need to approve to start it:** (a) the provider and model above, (b) the $0.50 hard budget and the ≤ $1.00 planned exposure, (c) that paid requests will be made (yes — every Brain, worker, narrator and repair call is charged), (d) that you will enter the API key yourself and answer every approval, (e) the objective. I will not start it without that.

## 11. Remaining defects and limitations

| # | Item | Class |
|---|---|---|
| 1 | Human-only checks H1–H7 on the packaged candidate not yet witnessed | release gate (PENDING) |
| 2 | Live rehearsal not run | release gate (needs authorization) |
| 3 | Binaries unsigned; SmartScreen will warn | distribution decision |
| 4 | Runner CLI has no workspace guard (dev-only, not distributed) | accepted; blocker for any CLI distribution |
| 5 | Limitations carried from phases 2.5–6.5 (lifecycle, survivor scan, lexical relevance, budget) | documented in the release notes |
| 6 | Desktop app not type-checked as a whole | pre-existing |
| 7 | Automated acceptance cannot exercise MCP servers in the packaged app | unobserved; rehearsal or a human check |

No security regression, no verification false acceptance, no data-risking migration, no missing runtime component was found.

## 12. Release notes and upgrade considerations

`docs/RELEASE_NOTES_1.7.0.md` — improvements, known limitations, user-visible behaviour changes, settings/database compatibility, upgrade and rollback procedures, signing status, what is not included (Demo Mode). Upgrade from 1.6.0 keeps the profile; older builds ignore the new fields and columns, so rollback is a reinstall of 1.6.0.

## 13. Final classification

- **SOURCE INTEGRATED — yes.** The reliability source and this release's changes are on local `main` (`cd5b427` + docs), fully tested.
- **RELEASE CANDIDATE VALIDATED — yes for every check automation may perform; the human desktop acceptance (H1–H7) is PENDING.** The candidate is not promoted past this until you witness those.
- **LIVE REHEARSAL VALIDATED — no.** Not authorized, not run.
- **PRODUCTION RELEASE READY — no.** Requires the two gates above, the signing decision, and your review of this report.

Last known-good state preserved: `origin/main` `7b62cce`; `integration/core-reliability` `9018cb3`; the installed Orca 1.6.0 untouched; both superseded candidates kept.

## 14. Exact actions that require your authorization

1. **Witness H1–H7** on the packaged candidate (§9) and tell me the results; I record them, never assume them.
2. **Authorize the live rehearsal** (§10): provider/model, budget, exposure, paid requests, the task — or change any of them.
3. **Decide on signing** (none possible here without an identity) before any distribution.
4. **Push `main`** to GitHub (62+ local commits; not done).
5. **Install** the candidate over Orca 1.6.0 (replaces the installed app; the profile is kept) — not done.
6. **Publish** a release — not done.

---

## 15. Final acceptance session — 2026-10-13 (evening), in progress

Candidate under test at the end of the session: **rc4, Orca 1.7.0 @ `8e4f46b1`** (unsigned; `C:\Orca\worktrees\main-rc\apps\desktop\release\`; SHA-256 portable `11814B3F…0241E`, installer `1B6B0270…2803C`; asar 11,538,184 bytes, 21 entries). Earlier candidates kept under `C:\Orca\rc-artifacts\` (rc3 @ `d535a9c3`, rc2 @ `cd5b427e`, rc1 @ `0aef6bf8`, 1.6.0-rc @ `9018cb30`). Commits added today after `b1a17ad`: `d535a9c` (a failed Anthropic model listing is reported as a fallback, not a listing), `8e4f46b` (the fallback note carries the provider's error message).

### 15.1 H1–H7 on the packaged candidate (rc2 @ `cd5b427e`, isolated profile, mock on 127.0.0.1 — no outbound code path in the mock; all commands `node -e …`, never `echo`)

| # | Expected | Human observation | Host evidence (`profile-human/userData/pipeline-traces/`) | Result |
|---|---|---|---|---|
| H1 | Card shows tool, command, workspace, task; Deny default | Card as expected; Deny focused; "Always approve" unchecked (screenshot) | `run_…_fld7si`: RUNNING → WAITING_FOR_APPROVAL | **PASS** |
| H2 | Approve runs exactly the requested action | Two cards (initial + repair pass), each approved by one click | waits 14.7 s and 13.2 s; one execution each, output `h1-approve`; nothing before approval | **PASS** |
| H3 | Deny prevents execution | Two Denied cards | `run_…_4cdscp`: waits 56.4 s and 1.1 s; "Command execution denied by user"; output empty; nothing in the workspace | **PASS** |
| H4 | Timeout denies without fallback | Untouched | `run_…_1t4u7r`: two waits of exactly 60.0 s; denied; no fallback action | **PASS** |
| H5 | Global red Stop with the card open | CANCELLED panel, "Stopped — all operations settled" | `run_…_r5pswg`: WAITING_FOR_APPROVAL → CANCELLING → CANCELLED in 1 ms; no dispatch after Stop | **PASS** |
| H6 | Card's "Stop task" | First attempt timed out untouched (recorded, not counted); second attempt: "Stopped — not approved", CANCELLED | `run_…_ww6hkt`: stopped 1.7 s after the card; no dispatch after Stop | **PASS** |
| H7 | Override dialog names the risk, needs acknowledgment, Cancel default | Banner read; dialog opened; Cancel pressed → "Override cancelled.", banner stayed | 0 overrides in `workspace-protection.json`; protection lifted by verification 2 s after the stand-in process ended | **PASS** |

Observation: a timed-out approval is recorded with the same "denied by user" text as a click; the trace timing distinguishes them.

### 15.2 Step 2 — packaged mock-provider integration (same profile)

Brain, routing, worker, Miranda before/after gates, budget stages, Pappy (honest FAIL on the mock's canned criteria), repair, cancellation, restart recovery with protection and the history sidebar all have trace evidence from the H runs. Export dry-run on a **copy** of the profile DB: 0 records for PASS, WARN and FAIL; the two cancelled runs skipped as `stopped_before_completion:cancelled`; no training activated. Observations: cancelled runs carry the placeholder summary "Unknown error" in the DB (UI says stopped); repair-exhausted FAIL runs persist the repair loop's summary without Pappy's eligibility tag, so desktop honest failures are not exportable today (conservative; follow-up).

### 15.3 Defect found while preparing the rehearsal — fixed, rebuilt

With an organization-level Anthropic key, Settings → Fetch models showed "11 model(s) loaded" although the listing had failed: the code fell back silently to the built-in list. Fixed in `d535a9c` (+ `8e4f46b`): the result says whether the provider answered; a fallback is shown as "Provider did not confirm its model list (HTTP status: provider reason) … availability and the API key are unverified". With the fix the real reason appeared — *"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"* — and a workspace-scoped key then listed 13 models, including `claude-sonnet-4-6`. Follow-up (product): optional per-provider `anthropic-workspace-id` for organization-level keys. Tests: `modelListing.test.ts` (6). Automated smoke of rc3 passed (startup, pipeline, Stop → CANCELLED, card with Deny default); note: one approval in that smoke window was clicked by the human by mistake, harmlessly (`console.log('rc3')` in the scratch workspace).

### 15.4 Live rehearsal (authorized by the human; Option A, direct Anthropic API)

- Profile: isolated; key typed by the human into Settings, stored encrypted, never read by the agent; every role `claude-sonnet-4-6`; billing metered; catalog price $3 / $15 / $0.30 / $3.75 per 1M, reviewed 2026-10-12, status `known`; `maxRepairPasses 1`; workspace = disposable repo (`parse` throws on empty input; baseline 3 pass / 2 fail).
- Model availability: confirmed by the provider's own listing (13 models, dated IDs present).
- **Refusal check ($0.01):** refused before dispatch — "reserving $0.0220 for claude-sonnet-4-6 (2,211 input-token bound × $3/M + 1,024 max output × $15/M) would exceed the remaining task budget of $0.0100"; $0 spent. **PASS.**
- **Test A** ("Fix the failing test in src/parse.js and run the tests.", budget $0.50): Brain routed direct → debugger with the right done criteria; the worker prefixed every path with the workspace folder name (`project/src/parse.js` → ENOENT), looped on the same three failing reads (`loop_detected`), edited nothing, ran nothing, and in the repair pass claimed "Ran all test suites". **Pappy FAIL** (confidence 0; `FIX_SOURCE_CHANGE_MISSING`, `TOOL_MISSING`, `PROOF_CLAIM_UNVERIFIED` ×3, `REQUIRED_RECEIPT_MISSING` ×5, `CORE_GOAL_MISSING`, `AGENT_LOOP_DETECTED`); not eligible; narrator reported the failure honestly. Workspace unchanged (git clean; tests still 3/2). No approval card arose (no command was requested). **Task outcome FAIL; reliability properties PASS** (no false success, objective preserved, honest accounting).
- **Spending:** task ledger $0.1844 (brain $0.0057, 1,697 in / 43 out; debugger $0.1787, 5,005 in / 10,911 out; unreconciled $0); message-level $0.1865 (narrator's closing call). **Cumulative $0.1865 of the $1.00 ceiling** (tracked from the ledger between tasks; to be compared with the Anthropic console).
- **Defect found (accounting persistence):** the `runs` row stores the last pass only ($0.1349, 3,799 in / 8,235 out) because `costUsd`/tokens come from `persistedMaestroResult.metadata`; the ledger and the UI are correct. Smallest fix: persist the task ledger's final snapshot (`spentUsd`, `unreconciledUsd`, token totals). **Not yet applied** — planned after Test B, followed by the final regression and a rebuild.
- **Observation:** the worker's path handling (workspace-folder prefix, no recovery from ENOENT) is a tooling-usability issue, not a safety one; follow-up: state in tool descriptions that paths are relative to the workspace root and tolerate a leading workspace-folder segment.
- **Test B (cancellation): not yet run — awaiting the human's authorization.** Optional second Test A attempt (~$0.19) within the ceiling: the human's call.

### 15.5 Where this leaves the classification (end of 2026-10-13)

- **RELEASE CANDIDATE VALIDATED — yes** for rc2 @ `cd5b427e` (automated + H1–H7 human acceptance). rc4 @ `8e4f46b1` differs only in the model-listing path and passed the automated smoke; the human checks were not repeated on it.
- **LIVE REHEARSAL VALIDATED — not yet:** refusal and Test A done (Test A: honest FAIL, reliability properties held, task not accomplished); Test B pending; the persisted-cost fix pending.
- **PRODUCTION RELEASE READY — no.**

### 15.6 Next session

1. Authorize and run Test B (cancellation) on rc4; record evidence and cumulative spend. 2. Decide on a second Test A attempt. 3. Apply the persisted-cost fix with a regression test; run the full regression; rebuild (rc5) and re-run the automated smoke. 4. Update §1–§14 of this report with final figures, classify, and decide on push/sign/install/publish.

## 16. Live rehearsals A4 and A5 on the corrected candidate (2026-10-14 / 2026-10-15) — observed results only

Candidate: test candidate built from `fix/worker-edit-protocol` @ `6a9b7a35` (clean, unsigned), `Orca 1.7.0.exe` SHA-256 `0a32dab0d225cb9ededa196c990e0b7fe9f256249df65582903878c8d9ddba21`. Isolated rehearsal profile; Anthropic `claude-sonnet-4-6` for every role; task budget $0.75 (read from the running app); one repair pass; human approvals. Message: "Fix the failing test in src/parse.js and run the tests." Evidence: `orca-audit/phase6/rc/rehearsal/A4/` and `A5/` (traces, transcripts, screenshots, diffs, fingerprints).

### 16.1 A4 (2026-10-14) — FAIL, approvals expired

- The worker edited `src/parse.js` (no approval needed for workspace writes, by design). All three test commands asked for approval; each settled exactly 60.0 s later by the automatic deny — no human was present. No host-recorded test run after the edit.
- Pappy: FAIL / unverified (first pass: `FIX_TESTS_NOT_RERUN`, AC1 partial, AC2 missing); training eligibility needs_human_review, then rejected after the repair pass.
- The edit fixed the defect but changed established behaviour: "007" → 7, "-0" → -0, inexact large integers silently rounded. The original five tests did not cover these.
- Spend: $0.503676 measured (23 requests; brain $0.005736, debugger $0.497940; 0 unreconciled); status bar $0.5057.

### 16.2 Contract tests added before A5

Eight regression tests recording the original behaviour (negative integers, zero, largest safe integer accepted; leading zeros, negative zero, plus sign, decimals/exponents/hex/trailing characters, inexact integers rejected) were committed in a fresh disposable copy (`project-A5`). The suite is now **13 tests**: original source 11 pass / 2 fail (the two defect tests); the A4 edit 10 / 3; a minimal correct fix 13 / 13.

### 16.3 A5 (2026-10-15) — FAIL, verification blocked by operator-introduced processes

- **Execution.** Brain routed to the debugger. The worker ran `npm test` (approved by the human after 4.0 s; reproduction), read `src/parse.js`, wrote a three-line fix (empty / whitespace-only input returns 0; nothing else changed), and ran `npm test` again (approved after 2.3 s): **host-recorded 13 passed / 0 failed on the final source.** All four approval cards were answered by the human within 7.0 s (trace timings); none timed out or was denied.
- **Pappy, first pass:** all three acceptance criteria marked proved ("root cause identified", "failing test fixed in src/parse.js", "tests are run and all pass"); `test_evidence=true`. **Verdict FAIL** on one HIGH issue, `EVIDENCE_PARTIAL`: the survivor scan reported `sleep.exe` processes "orphan of: npm test" that might still be writing, so the workspace inventory was marked partial.
- **Cause of those processes:** the operator's monitoring loop (Git Bash, `sleep 2` every two seconds) started short-lived `sleep.exe` processes during the command windows. The Windows survivor scan reports any process created during a command whose parent has exited as a suspected orphan (documented in `processIdentity.ts` as a known false-positive class). The project's test script is `node --test`, which starts no `sleep`. Pappy's refusal was correct for the evidence it was given; the evidence was contaminated by the rehearsal's own instrumentation.
- **Repair pass:** given only the `EVIDENCE_PARTIAL` finding, the worker re-ran the tests three times (13 / 13 each, approved), rewrote `src/parse.js` with byte-identical content, and stopped at `max_iterations` with no answer. QC was blocked ("output text is empty"); the first-pass FAIL stands. Training eligibility: needs_human_review. The workspace stays **protected** (three flagged pids, all since exited); the protection was not released.
- **Final source:** SHA-256 `4ebafafa…1bd3`, equal to both writes and to the state the host tests ran on; independent post-hoc `node --test` 13 / 13 (not host-recorded). Differences from the original are limited to empty, whitespace-only and tab/newline input.
- **Spend:** task ledger $0.349968 measured (16 requests; brain 1 / $0.005916; debugger 15 / $0.344052 — first pass 5 / $0.084549, repair pass 10 / $0.259503; 59,206 in / 11,490 out; 0 unreconciled, 0 unpriced, 0 refused). Persisted `runs.cost_usd` $0.349968 (matches the ledger). Status bar $0.3518 — $0.0018 charged after the task, most likely the closing explanation (not attributed by the trace). Remaining task budget $0.4000. Aggregate for A5 $0.3518 of the newly approved $1.00.

### 16.4 Where this leaves the classification

- **Live-model coding success — not established.** A5 shows a real model making a correct, contract-preserving edit and the host recording 13 / 13 on the final source, and Pappy proving all three criteria — but the run's verdict is FAIL, and a PASS has not been observed.
- **Safety and authorization controls held:** every command needed and received a human approval; nothing executed without it; Pappy refused verification on incomplete evidence; the budget held; accounting matched across ledger, UI and persisted row.
- **Open items before production approval:** (1) one clean rehearsal with no operator processes started during the run; (2) a design decision on the survivor-scan false positive (machine-wide orphan attribution on Windows), which can also be tripped by ordinary user activity; (3) a repair pass that receives only a non-code finding spends its iterations and ends with no answer (QC blocked) — worth a follow-up.
- **PRODUCTION RELEASE READY — no.**
