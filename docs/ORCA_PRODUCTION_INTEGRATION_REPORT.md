# Orca — Production Integration & Release Candidate Report

**Date:** 2026-10-13 · **Machine:** dev desktop (Windows 11, Node 24.11.1, pnpm 10.30.2) · **By:** Claude Code session, authorized by the human's "Production Integration & Release Candidate" brief.

**Outcome in one line:** the core-reliability work is fast-forward merged into **local `main`** (`9018cb3`), every post-merge check from `main` matches the pre-merge baseline, an **unsigned local release candidate** (Orca 1.6.0 @ `9018cb30`) is built and smoke-tested against the mock provider in an isolated profile, and the classification is **SOURCE INTEGRATED** — not RELEASE CANDIDATE VALIDATED, because the native-desktop checks that need a human remain PENDING and the candidate does not contain the Summit Demo Mode that the installed Orca runs. Nothing was pushed, installed, published, or run against a real provider.

---

## 1. Original and final commit hashes

| Reference | Commit | Note |
|---|---|---|
| `origin/main` (production baseline, fetched again before merging: 0 new commits) | `7b62cce` | unchanged by this work; **not pushed to** |
| local `main` before integration | `310d837` | 10 commits behind `origin/main`; checked out in no worktree |
| integration HEAD named in the brief | `5602027` | final acceptance closure |
| integration HEAD actually merged (adds one docs commit recording the human's E1–E6 decisions and the accepted CLI limitation) | **`9018cb3`** | `integration/core-reliability`, clean tree |
| local `main` after integration | **`9018cb3`** | identical to the integration HEAD; 57 ahead of `origin/main`, 0 behind |
| release candidate built from | `9018cb30e857e2b8c7191cef58b3719b470c063b`, `ref: main`, `dirty: false` | `build-info.json` inside the asar and beside the artifacts |
| this report and the PROJECT_STATE update | committed separately on `main` after the merge; hash recorded in §1a below and in PROJECT_STATE | docs only |

### 1a. Documentation commits after the merge

| Commit | Content |
|---|---|
| `58b9a7d` | this report + `PROJECT_STATE.md` (recorded by the next commit, which changes only this row) |

## 2. Source merge strategy and result

**Pre-merge inspection (all clean):**

- Worktrees: `C:\Orca\Orca` (`fix/live-demo-verification`, 27 uncommitted files — untouched before and after, verified), `core-reliability` (integration branch), `integration-1.6.1-clean`, `remediation-1.6.1`, `audit-main` (detached `7b62cce`), `.kilo/worktrees/tropical-walkover` (detached `7b62cce`). `main` was checked out nowhere.
- Ancestry: `310d837` and `7b62cce` are both ancestors of `9018cb3` → fast-forward possible; no merge commit, no conflict resolution.
- Upstream: `git fetch origin` brought 0 new commits.
- Diff `origin/main..integration` (57 commits): source, tests, fixtures, docs, validation scripts only; `pnpm-lock.yaml` untouched (package.json changes are scripts only); no `release/`, `dist`, `.exe`, `.asar`, `.env`, key/certificate, log, Summit/staging asset or personal path; the only "secret-looking" string is the test literal `sk-ant-secret-key`.
- Database migration: idempotent `ALTER TABLE runs ADD COLUMN cost_unreconciled_usd REAL` / `cost_basis TEXT` at open (plus the pre-existing idempotent adds and legacy role renames). Settings migration: `resolveBudgetSource` labels the historical $0.10 as `legacy_default`; new optional `providers[].billing`, `pricing[]`, `budgetSource`. Both exercised on synthetic data in §7.

**Merge:** `git fetch --no-tags . integration/core-reliability:main` from the integration worktree. A non-forced refspec makes Git itself refuse anything that is not a fast-forward.

```
From .
   310d837..9018cb3  integration/core-reliability -> main
main@{0}: fetch --no-tags . integration/core-reliability:main: fast-forward
```

**After integration:** `main` = `9018cb3` = integration HEAD; `310d837` and `origin/main` are ancestors of the new `main` (history intact); first-parent history is the reviewed commit sequence; working tree clean; `integration/core-reliability` retained at `9018cb3` for audit and rollback; **no push** (`main...origin/main [ahead 57]`). A new worktree `C:\Orca\worktrees\main-rc` was created on `main` for the post-merge validation and the build; `pnpm install --frozen-lockfile` completed from the unchanged lockfile (10.7 s).

## 3. Contract exception decisions (human, 2026-10-13)

| Exception | Decision | Where recorded |
|---|---|---|
| E1 — honest-failure training export: negative outcome (`score 0`, `outcome: honest_failure`), no positive-set contamination | **APPROVED** | `docs/ORCA_HUMAN_ACCEPTANCE_REPORT.md` §3, `9018cb3` |
| E2 — independent workspace verification and evidence downgrades | **APPROVED** | same |
| E3 — substantive documentation claims are not verified by identifier presence or lexical matching alone (two rounds; human review when semantic evidence is unavailable is intended) | **APPROVED** | same |
| E4 — completeness heuristic corrections | **APPROVED** | same |
| E5 — honest partial test results stay distinguishable from false success claims | **APPROVED** | same |
| E6 — the runner's budgeted adapter behaviour | **APPROVED for Rule 5 only** | same |

The approvals rest on the documented implementation, regression evidence and review process; they do not authorize weakening the implementation, and nothing was weakened. The ten previously documented false positives (one test file, nine fixtures) remain reported; the contract checker is unchanged and still prints `REVIEW REQUIRED` by design.

## 4. Accepted limitations

- **Runner CLI has no workspace guard** — accepted as a desktop-only integration limitation (PROJECT_STATE item 1p) on three conditions, each verified on `main`: (1) the desktop never delegates write-capable execution to the CLI path — `apps/desktop/src/main.ts` imports `createOrcaRuntime` from `@clawde/orca-core` and no desktop main-process source references `child_process`, `spawn`, `tracer.js`, `apps/runner` or `@clawde/runner`; (2) the CLI is not distributed — `@clawde/runner` is `private`, is absent from the packaged asar (checked by listing; the only `runner.*` inside is workbench-core's tool runner) and from the `electron-builder` `files`; (3) the gap is a **blocker before any future CLI distribution**.
- **Pappy's substantive documentation checks may require human review** (WARN / unverified / needs_human_review) when semantic evidence is unavailable — intentional and conservative (items 1q, 1r).
- The limitations carried from phases 5–6.5 (items 1k–1o) are unchanged.

## 5. Pre-merge test results (integration HEAD `5602027`, same tree as `9018cb3` apart from two docs)

| Check | Result |
|---|---|
| `pnpm -r --no-bail test` | **1,903 passed · 0 failed · 1 skipped** (= baseline) |
| `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| desktop source build (`build-main.mjs`) | OK (built dirty only because the doc edits were uncommitted at the time) |
| `pnpm contract:check` | REVIEW REQUIRED: 15 × Rule 4 + 1 × Rule 5 (all dispositioned, §3); **0 BLOCKED** |
| Pappy suites (`pappy:eval`, `raw-real-pappy`, `pappy-plus-hardening`, `evidence`) | 23/23 · 12/23 · 15/23 · **49/49** (FA 0/33, FR 0/11) |

Miranda security, Moonshiner eligibility/export, budget and provider compatibility, lifecycle/cancellation, workspace protection and orphan-process, desktop approval/recovery and Brain/Maestro routing tests are all inside the full suite above (miranda-core 236 + 1 skipped, orca-core 316, workbench-core 63, pappy-core 397, pappy-eval 152, desktop 292, maestro-core 75, benson-core 133, runner 107).

## 6. Post-merge test results (local `main` `9018cb3`, run from `C:\Orca\worktrees\main-rc`)

| Check | Result |
|---|---|
| `pnpm -r build` | 15 packages built, 0 errors |
| `pnpm -r --no-bail test` | **1,903 passed · 0 failed · 1 skipped** — dewey 32 · maestro 75 · benson 133 · miranda 236 + 1 skipped · workbench 63 · pappy-core 397 · pappy-eval 152 · orca-core 316 · ext-web 12 · ext-docs 14 · ext-github 18 · mcp-client 44 · agent-loop 12 · runner 107 · desktop 292 |
| `pnpm -r exec tsc --noEmit`, `pnpm typecheck:scripts` | 0 errors |
| `pnpm contract:check` | REVIEW REQUIRED: 15 × Rule 4 + 1 × Rule 5; 0 BLOCKED (identical to pre-merge) |
| Pappy suites | 23/23 · 12/23 · 15/23 · 49/49 (FA 0/33, FR 0/11) — identical |
| desktop packaging (`pnpm --filter @clawde/desktop dist`) | OK (§8) |

Moving the code into `main` changed nothing: the merged tree is byte-identical to the integration tree (fast-forward), and every figure above equals the integration-branch figure. Provider model configuration, runtime initialization, lifecycle, Miranda authorization, Pappy verification, Moonshiner eligibility, budget enforcement, approval dialogs and workspace protections are covered by the same tests with the same results; the desktop runs the guarded in-process runtime (`runtime.ts`: `WorkspaceProtectedError` before baseline, `guardDispatch` around `ctx.llm`).

## 7. Database and settings compatibility (synthetic data; the user's live profile was not touched)

Two temporary vitest files were written on `main`, run, and removed again before the build (so the build's `dirty` flag stayed false). Copies are kept outside the repository under `%LOCALAPPDATA%\Temp\orca-audit\phase6\rc\` (`synthetic-db-migration.test.ts.txt`, `synthetic-settings-migration.test.ts.txt`); they are candidates for a follow-up branch, not part of this merge.

**SQLite (`SqliteStore` + `runMigrations`) — 3/3 passed**

| Starting database | Result |
|---|---|
| `runs` as created by the 1.6.0 schema (with `repair_passes`, `brain_decision`, `error_message`, `ahp_packet_graph`; **without** `cost_unreconciled_usd` / `cost_basis`), 3 rows with roles `coder_strong`, `coder_cheap`, `reader`, plus thoughts / tool_events / files_changed rows | opened without error; all 3 rows readable; `coder_strong` → `strong_model`, `coder_cheap` → `cheap_model`, `reader` kept; old costs intact; new fields `undefined` on old rows; thoughts/tool events readable; a new run saved with `costUnreconciledUsd 0.01`, `costBasis "upper_bound"`, `stoppedBecause "interrupted"` round-trips; file persisted with both new columns; a second open re-runs the migrations harmlessly (4 rows, stats correct) |
| the **original** schema (no `repair_passes` … `ahp_packet_graph` either) | same result; every later column added |
| a database already on the merged schema | left alone: no duplicate columns, rows intact |

**Settings (`loadSettings` / `saveSettings`) — 7/7 passed**

| Starting file | Result |
|---|---|
| 1.6.0 provider/role file with the historical `budgetUsd: 0.10`, no `billing`, `budgetSource` or `pricing` | roles (model assignments) identical in and out; providers kept with keys recovered; `billing` left `undefined` (not classified behind the user's back); budget **0.10 kept** and labelled `legacy_default`; `pricing` undefined; other fields intact |
| same file with a user-typed budget (0.02, 0.75, 5, 0) | value and `"user"` label kept exactly (0 = no hard limit) |
| same file with no budget field | 0.10, `legacy_default` — never a larger number |
| legacy flat file (`provider` / `apiKey`) | migrated to a provider + roles; budget rule applied; key recovered; `workspaceRoot` kept |
| load → save → load of a migrated file | stable: on-disk `budgetSource: legacy_default`, `budgetUsd 0.10`, roles unchanged; second load equals the first |
| a file written by the merged build (`billing`, `pricing`, `budgetSource: user`) | round-trips unchanged |
| no file | defaults; no providers invented; 0.10 `legacy_default` |

No user model assignment or budget preference is modified silently by the migration.

## 8. Release-candidate build — status and location

| Item | Value |
|---|---|
| Command | `pnpm --filter @clawde/desktop dist` (→ `build-main.mjs` esbuild bundle, then `electron-builder --win --x64`) from `C:\Orca\worktrees\main-rc`, clean tree |
| Started / finished | 2026-10-13 15:18:44Z / 15:20:44Z |
| Tooling | electron-builder 26.15.7, Electron 41.10.5, NSIS + portable targets, fuses `onlyLoadAppFromAsar` + `enableEmbeddedAsarIntegrityValidation` |
| Location (clearly labelled, gitignored) | `C:\Orca\worktrees\main-rc\apps\desktop\release\` with a marker file `RC-NOT-FOR-DISTRIBUTION.txt` |
| `Orca 1.6.0.exe` (portable) | 121,128,694 bytes · SHA-256 `FDE8534B1D6CE3DF8CEF40FA358255E2FE357FFEF9B78FB72FF8040A05274F6D` |
| `Orca Setup 1.6.0.exe` (NSIS, per-user, not run) | 121,627,015 bytes · SHA-256 `3CF3CA406B989D2CA18B47710A47685EE19374A34B5AB51380C9320CAC515998` |
| `build-info.json` (also inside the asar at `dist-main/build-info.json`, identical) | `{"version":"1.6.0","commit":"9018cb30…","commitShort":"9018cb30","ref":"main","dirty":false,"builtAt":"2026-10-13T15:18:45.750Z"}` |
| Code signing | **unsigned** — `Get-AuthenticodeSignature` reports `NotSigned` for the portable, the installer and `win-unpacked\Orca.exe`; no `CSC_*`/`WIN_CSC_*` variables, no certificate in the config. (electron-builder prints "signing with signtool.exe" anyway; that line is misleading, the signature state above is the fact.) No signing identity or credential was requested or created. |
| Included files | `resources/app.asar` 44,260,791 bytes (2,969 entries: `dist-main/` main.js 1,655,562 bytes, preload.js, sql-wasm.wasm, build-info.json; `renderer/` 19 files; `node_modules/` 2,948 entries), `elevate.exe` (electron-builder's NSIS helper), `orca-settings.example.json`, `orca.ico` |
| Credentials / private logs | none: main.js scanned for `sk-or-`, `sk-ant-`, `ghp_`, `AKIA` and `C:\Users\<name>` patterns — no match; no `.env`, `.log`, `.db`, `orca-settings.json`, key or certificate file in the asar |
| CLI artifact | none: `apps/runner` / `tracer.js` absent from the package; the runner is `private` and not in `files` |
| Installed Orca preserved | `C:\Program Files\Orca\Orca.exe` and `resources\app.asar` unchanged (last written 2026-10-07 17:02Z, before and after); `%APPDATA%\Orca`, `%APPDATA%\@clawde\desktop` and the real `~/.orca` untouched (newest files 2026-10-07); the NSIS installer was never executed |

**Finding (packaging hygiene, not security):** because `@clawde/orca-core` and `@clawde/miranda-core` are runtime `dependencies` of the desktop package, electron-builder copied the workspace packages — including their `src/*.ts` and **215 test files** — into the asar next to the esbuild bundle that already inlines them. Nothing sensitive is in them (they are the public source), but they add size and ship test code. Recommended follow-up: mark those packages as `devDependencies` of the desktop or exclude `node_modules/@clawde/**/src` and `**/*.test.ts` in `build.files`.

**Finding (release scope):** the installed Orca is `1.6.0 @ 1e872123` from `feature/summit-demo-mode`, whose 8 Demo Mode commits (`7c6491c`…`1e87212`) are **not in `main`**. This release candidate therefore has no Summit Demo Mode. Installing it over the installed app would remove Demo Mode. That is a product decision for the human before any release, not a defect of the merge (the integration branch was source-only by design).

## 9. Packaged smoke-test results (release candidate, isolated profile, mock provider)

**Set-up.** `Orca 1.6.0.exe` (portable) launched through `launch-packaged.mjs` (kept under `%LOCALAPPDATA%\Temp\orca-audit\phase6\rc\`; same isolation as `scripts/desktop-validation/launch-isolated.mjs` but for the EXE): `--user-data-dir` = `…\rc\profile-a\userData`, scratch `USERPROFILE`/`HOME`, scratch `TEMP` (the portable EXE unpacked into the profile, verified by the running process path), `ELECTRON_RUN_AS_NODE` removed, every role on the mock provider at `127.0.0.1:3939` (`billing: local`), hard budget $0.05, workspace with one README. Observation through the DevTools port with `observe.mjs`, which cannot reach native dialogs and never answered one. Screenshots `rc-a-01…09*.png` and transcripts `rc-a-0*-text.json` are kept beside the launcher.

| § 7 item | Result | Evidence |
|---|---|---|
| Application startup | **PASS** | window "ready", workspace loaded, renderer served from the RC's asar (`file:///…/resources/app.asar/renderer/index.html`) |
| Provider configuration | **PASS** | settings file read; "By provider: Mock (local, no network)" in the outcome panel; mock log shows the requests |
| Normal user request | **PASS** | "Summarize README.md in this workspace in one sentence." ran the whole pipeline in 0.99 s |
| Brain planning | **PASS** | status "I'm planning the approach."; route direct → `strong_model` |
| Worker execution | **PASS** | worker turn, Miranda `before_qc`/`after_qc` ALLOWED, 4,200 in / 840 out tokens accounted |
| Native approval presentation | **rendered (automation)** — `#tool-approval-dialog` visible (`display: flex`, `checkVisibility() = true`): "Tool call request 54 s", tool `run_command`, args, **Workspace** line, "Always approve run_command this session" unchecked, buttons **Stop task / Deny / Approve** with **Deny focused**; screenshot `rc-a-05-approval-card.png` | **human visual check PENDING** |
| Approve and Deny | **NOT EXERCISED** in the packaged build (no automation of approvals by rule) | **PENDING human** (witnessed on the source build on 2026-10-13: six individual Approve clicks, Deny, timeout) |
| Approval timeout | **PASS (automation)** — nobody answered; the card timed out; the worker reported "The command was not approved, so it did not run"; zero executions; Pappy FAIL; task settled after 108 s | human visual of the "Denied" card PENDING |
| Global Stop | **PASS** — Stop pressed 3 s into a `SLOW` task during planning | "Stopping…" → "Stopped — all operations settled." → "Stopped." |
| Task cancellation and settlement | **PASS** — badge **CANCELLED**, "Verdict: none — task cancelled before Pappy judged it", Task state cancelled, no error row (the `b6b2319` fix, now seen in the packaged build); status "blocked after Stop"; the cancelled planning request accounted as **1 unpriced** (cancelled after dispatch, upper bound; $0 for a local provider) | `rc-a-04-stop-text.json`, `rc-a-04-stopped.png` |
| Workspace protection | **PASS** — a protection with a live stand-in process was staged in the profile (`stage-override.mjs`); on relaunch the banner and the recovery warning appeared ("Unknown is not safe…"); a new request was refused **without any dispatch** ("Not started: the workspace is still protected by an earlier task"); after the process was ended, the 5 s re-verification lifted it in ≤ 2 s ("Workspace released (every process verified gone)") and the file returned to `protections: []`. The override button was shown and **not pressed** | `rc-a-07…09*` |
| Pappy's evidence-based results | **PASS** — the mock's canned reply does not satisfy the summary goal: FAIL, 3 issues (`COMPLETENESS_GOAL_COVERAGE` …), heuristic score 55 %, one repair pass, honest FAIL in the panel; no verified claim anywhere | `rc-a-02-smoke.png` |
| Budget enforcement | **PARTIAL** — accounting shown and persisted (status line "$0.0000 of $0.05 confirmed", by role, by provider, remaining, unpriced request after Stop; `cost_basis = measured` in the runs table); a **hard-budget refusal was not exercised** in the packaged build (needs `--billing metered --price`) | PENDING (deterministic; can be automated without dialogs) |
| Restart and interruption recovery | **PASS** — see Workspace protection: relaunch of the same profile re-probed the recorded process (pid + creation time) and reported it | `rc-a-07-restart-text.json` |
| UI status and cost reporting | **PASS** — status line, outcome panel, Dewey brief, Miranda checkpoints, repaired issues, cost lines all rendered | screenshots |

**Persisted by the packaged app inside the profile only:** `orca-runs.db` (schema with `cost_unreconciled_usd` / `cost_basis`; 3 rows: two FAIL runs with `cost_basis measured`, one cancelled run with `stopped_because cancelled`), `budget-journal.json`, `workspace-protection.json`, `orca-settings.json` (unchanged by the app), scratch `home\.orca\userContext.json`. Nothing under the real user profile changed (§8).

**Observations (not blockers):** (a) the cancelled run is stored with `status = FAIL` and `stopped_because = cancelled` while the UI correctly says CANCELLED — the persisted status vocabulary has no cancelled value; a follow-up could add one. (b) A request refused for a protected workspace is shown as a Narrator "Could not complete" trace panel plus the warning line; accurate, but the panel wording could say "not started". (c) See §8 for the asar contents and the misleading signtool log line.

## 10. Security and verification status

- **No regression.** Every Miranda, workspace-guard, lifecycle, dispatch-guard, process-identity, Pappy, evidence-corpus and Moonshiner-export test passes on `main` with the pre-merge figures; the contract checker reports the same 16 findings, 0 BLOCKED.
- **Live in the packaged build:** approval card with Stop reachable, Deny default; cancellation that waits for settlement; workspace protection that survives a restart, refuses work and lifts only by verification (override offered, not taken); Pappy refusing to verify unsupported claims.
- **Not weakened:** Miranda gates, Pappy verdict rules, Moonshiner eligibility (PASS-only default export, FAIL export explicit and labelled negative), and the workspace guard are as reviewed; no fixture was relabelled in this phase.
- **Open by design:** the limitations in §4.

## 11. Budget and provider readiness

- Price catalog: Anthropic prices reviewed **2026-10-12** (`ANTHROPIC_PRICES_REVIEWED`), e.g. `claude-sonnet-4-6` $3 / $15 per 1M tokens (cache read $0.30, write $3.75), `claude-opus-4-8` $5 / $25, `claude-haiku-4-5` $1 / $5; `claude-haiku-5-5` is listed with a note. Prices are known only for Anthropic's own API; any other endpoint needs `billing: metered` and a custom price under a hard budget, or it is refused as unpriced.
- Budget behaviour verified by tests and, in the packaged build, by the accounting lines and the unpriced-after-cancel count; a refusal is unit-tested and was seen on the source build in phase 6.5, not yet in the packaged build (§9).
- Ledger is per process; a stream without usage stops a hard-budget task after one request; cache writes are modelled for Anthropic (item 1k).
- No real-provider request has been made on this code; promotional credits are not spending authorization.

## 12. Remaining defects and uncertainties

| # | Item | Class |
|---|---|---|
| 1 | Native approval card, Approve, Deny, timeout "Denied" card and the override dialog in the **packaged** build not yet seen by a human (source build: all witnessed) | PENDING human — gate for RELEASE CANDIDATE VALIDATED |
| 2 | Hard-budget refusal not exercised in the packaged build | PENDING deterministic check (no dialog needed) |
| 3 | The candidate has **no Summit Demo Mode**; the installed app has it (8 commits on `feature/summit-demo-mode`, not in `main`) | product decision before any install/release |
| 4 | Asar carries workspace `src/` and test files (size/hygiene) | follow-up packaging change |
| 5 | Cancelled runs persisted with `status FAIL` + `stopped_because cancelled` | follow-up (UI is correct) |
| 6 | No live-provider run; MCP-server behaviour in the packaged app unobserved | release gate (§13) |
| 7 | Candidate is unsigned; a signed build needs a signing identity that does not exist in this environment | stop-and-ask before distribution |
| 8 | Limitations carried from phases 2.5–6.5 (PROJECT_STATE items 1i–1r) | documented |

## 13. Controlled live-rehearsal instructions (packaged application + Anthropic API) — plan only, NOT executed, NOT authorized by this report

1. **Authorization.** The human explicitly authorizes the spend and starts the run themselves; nothing in this report or in the existence of credits is that authorization.
2. **Build.** The release candidate of §8 (`Orca 1.6.0.exe`, SHA-256 `FDE8…B8E5`), launched with `launch-packaged.mjs --exe … --profile <new disposable dir>` so settings, runs DB, journal, protection file and `~/.orca` are scratch. No MCP servers; no GitHub token.
3. **Provider and model.** One Anthropic provider (`type: anthropic`, `billing: metered`), model **`claude-sonnet-4-6`** (in the reviewed catalog at $3 / $15 per 1M; reviewed 2026-10-12). Before any task: Settings → fetch models confirms the ID is served; if the human prefers a model that is not in the catalog (e.g. a Claude 5 model), enter a custom price first — an unpriced model under a hard budget is refused by design. API key typed by the human into Settings for the session and removed afterwards (never stored by the plan or in any file).
4. **Budget.** Hard task budget **$0.50**, typed by the human (source `user`). First exercise the refusal path once with a **$0.01** budget on a trivial request (expected: budget stop before the call, "unpriced"/"refused" label, $0 spent), then raise to $0.50.
5. **Workspace.** A disposable copy of a small real project with **one known failing test** (e.g. the `find-fix` booking fixture from the evidence corpus copied as a git repo, `git init` + commit so Pappy's baseline is clean).
6. **Task 1 — genuine fix.** "Fix the failing test in <file> and run the tests." Expected: Brain plans (route visible), worker reads, edits, runs `node --test` → **native approval card** (human clicks Approve once; never "Always approve"); host-recorded behavioural verification (tool receipt with exit code and output on the final source); Pappy PASS only if the full suite passed on the final source, else WARN/FAIL with the stated evidence gap; Moonshiner eligibility shown in the badge (`eligible` only for PASS with verified evidence); cost line with measured usage, `unreconciled $0`.
7. **Task 2 — cancellation.** "run node -e \"setTimeout(()=>{},60000)\" and report" → approve the command, press the global red Stop at ~10 s. Expected: CANCELLING → CANCELLED (kill confirmed) or INTERRUPTED + workspace protection with the pid; no model call after Stop (trace), the cancelled request shown as an unreconciled upper bound; the next message refused until settled.
8. **Task 3 — Stop during an approval.** Trigger an approval, press "Stop task" on the card (and, in a second attempt, the global Stop with the card open): nothing runs, state cancelled, card dismissed.
9. **Recovery.** Close the app during a streaming reply (Task Manager), relaunch the same profile: init warning lists the exposure; nothing resumes; any protection is re-probed.
10. **Reconciliation.** Compare the status line and the runs table with the provider's usage page: measured usage must match within the provider's rounding; every cancelled request must appear as unreconciled.
11. **Evidence to keep.** `pipeline-traces/`, `orca-runs.db`, `budget-journal.json`, `workspace-protection.json`, screenshots of every dialog and panel, the provider usage page.
12. **Outcomes.** **PASS:** every step as expected and the invoice matches the ledger. **PARTIAL:** a deviation without a safety consequence (a label, a wording). **FAIL:** any request after Stop, any unverified run shown as verified, any approval taken without a click, any spend over the hard budget, any workspace write after INTERRUPTED without protection, any Moonshiner-eligible label on an unverified run.

## 14. Rollback procedure

- **Source (local `main`).** Nothing was pushed, so `origin/main` (`7b62cce`) is unaffected. To undo the local integration: `git branch -f main 310d837` from a worktree that does not have `main` checked out (or remove `C:\Orca\worktrees\main-rc` first). This moves a pointer only; every commit stays on `integration/core-reliability` (`9018cb3`) and in the reflog (`main@{1}` = `310d837`). Do not use `reset --hard` or force operations.
- **Profiles.** Older code ignores the extra `runs` columns and the new settings fields; `budget-journal.json` and `workspace-protection.json` are inert for older code. No user profile was migrated by this work (only scratch profiles).
- **Release candidate.** Delete `C:\Orca\worktrees\main-rc\apps\desktop\release\` (gitignored) and the scratch profiles under `%LOCALAPPDATA%\Temp\orca-audit\phase6\rc\`. The installed Orca was never modified, so there is nothing to restore.
- **Documentation.** This report and the PROJECT_STATE update are separate docs commits on `main` (§1a); revert them with `git revert` if the integration is rolled back.

## 15. Final release-readiness classification

**SOURCE INTEGRATED.** The validated reliability changes are merged into local `main` by fast-forward, every post-merge check from `main` passes with the pre-merge figures, and the migrations are verified on synthetic data.

**Not RELEASE CANDIDATE VALIDATED.** A local packaged candidate exists and passes every deterministic and isolated-profile check that automation may perform (startup, pipeline, Stop/settlement, restart recovery with a protected workspace, Pappy honesty, accounting), but the native-desktop checks that only a human may perform (approval card, Approve, Deny, timeout card, override dialog — in the packaged build) are PENDING, the packaged hard-budget refusal is unexercised, and the candidate lacks the Summit Demo Mode the installed application has — a product decision is needed before it could replace that application.

**Not PRODUCTION RELEASE READY.** The live-provider rehearsal (§13) has not been authorized or run; the candidate is unsigned.

**Last known-good state preserved:** `origin/main` `7b62cce` untouched; `integration/core-reliability` at `9018cb3`; local `main` at `9018cb3` + docs; installed Orca untouched; release candidate kept under its labelled folder.

**Not done, by instruction:** push, install, publish, replace the installed Orca, modify credentials, spend API credits, answer a native dialog, override a protection, enable Moonshiner training, distribute the CLI, any destructive Git operation, any silent change to model assignments or budgets.
