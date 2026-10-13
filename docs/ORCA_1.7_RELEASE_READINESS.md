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
