# Orca 1.7.0 — Core Reliability

**Coding You Can Trust.**

Release candidate built 2026-10-13 from `main` at `cd5b427e` (Windows x64, unsigned). Status at the time of writing: release candidate, **not yet released** — see `docs/ORCA_1.7_RELEASE_READINESS.md` for the gates that remain.

Orca 1.7.0 is the result of the core-reliability remediation (phases 1–6.6). It does not add new agents or new tools. It makes the agents that exist operate inside a system with meaningful authorization, measurable spending, reliable lifecycle control and independent verification.

## What changed for you

### Verification is evidence-backed (Pappy)
- A task is "verified" only when Orca's host saw the evidence itself: the files that changed, the commands that ran, their exit codes and output, on the final state of the source. A model saying "done" or "all tests pass" is not evidence.
- Code changes with no test run fail with a specific evidence request instead of passing as "verified". A feature needs a test or a documented validation that exercises it.
- Documentation claims are not proved by the presence of an identifier or by matching words. A substantive claim about a function that the document does not demonstrably support is **WARN / unverified / needs human review**, even when the document happens to be right. Mention-only requirements ("mention X in the README") can still be verified.
- Two workers writing the same file in one pass is detected: harmless overlaps are noted, unresolved attribution makes the run unverified and never trainable, real conflicts downgrade the verdict.
- Honest reports of failure are kept distinguishable from false success claims.

### Permission enforcement at execution time (Miranda)
- Every tool call is authorized when it is about to run, not when it was planned. Approvals are bound to the task and session that asked; a stale approval cannot start work for a cancelled task.
- The approval card shows the tool, the exact command or arguments, and the **workspace** it will run in. **Deny is the default** (focused). "Always approve this tool for the session" is an explicit opt-in. A card that is not answered times out as **Denied**.
- **Stop is always reachable:** the card carries its own "Stop task" action, and the global Stop works while a card is open; the card is dismissed and nothing runs.
- MCP tools whose names carry no recognised verb now ask for approval on every call.

### Accurate budgeting
- A hard per-task budget in Settings is enforced **before** each model request: Orca reserves an upper bound (input-token bound × price + max output × price) and refuses the request when the reservation would exceed what is left. The refusal is shown with the arithmetic.
- Every endpoint has a billing classification: **local** (no external fee), **metered** (needs a known or custom price), **unknown**. A model with no known price under a hard budget is **refused**, with instructions to classify the provider or enter a price. A custom endpoint on localhost is no longer assumed free.
- Costs are shown as **confirmed** (measured usage × price) separately from **unreconciled** upper bounds for requests whose billing outcome is unknown (for example a request cancelled after dispatch). Cancelling never erases an unresolved cost. Cache reads and writes are modelled for Anthropic.
- The historical default budget of $0.10 in older settings files is kept and enforced, labelled as the historical default at start-up until you save a budget of your own. Nothing is raised or removed silently.
- **Limits:** the cap is enforced where the provider honours `max_tokens` and reports usage; overruns are recorded and stop the task rather than being prevented. Prices are known for Anthropic's own API; other providers need a custom price. Orca cannot guarantee what a provider bills beyond what it reports.

### Safer cancellation and clear execution states
- Tasks have explicit states (planning, running, waiting for approval, verifying, repairing, **cancelling**, **cancelled**, **interrupted**, completed, failed). "Stopped" is shown only after every operation has settled; "Stopped — all operations settled" means exactly that.
- After Stop, no further model request or tool call is dispatched; late responses cannot start new actions; repair loops do not restart cancelled work. The next message is refused until the stopped task has settled.
- A stopped task has **no verdict**: the outcome panel says CANCELLED or INTERRUPTED ("none — task cancelled before Pappy judged it"), not FAIL. The history sidebar lists it as stopped, and reopening it says it was stopped, not that it failed.

### Workspace protection and interruption recovery
- A command that could not be confirmed stopped (kill unconfirmed), or that left a surviving child or orphan process, **protects the workspace**: no new task runs there until the process is verified gone (Orca re-checks every 5 seconds, by process id *and* creation time) or you explicitly override.
- The protection survives a restart: on launch Orca re-probes the recorded processes and shows a notice with the steps to take. A start-up notice also lists budget reservations a previous process never reconciled, recorded as interrupted runs with their possible charge.
- **Override is a recorded decision:** the native dialog says that it verifies nothing and stops nothing; Cancel is the default; the override is written to an audit log.

### Routing and fallback (Brain)
- The original objective is preserved through planning, routing and repair: "fix … then run the tests" keeps the fix as the objective; a request cannot be silently turned into a command-only verification task.
- Brain failures are named for what they are — invalid plan, provider failure, timeout, cancelled, budget refused — and a deterministic fallback picks a worker by the kind of work (debugger / strong model / reader), never a non-editing role for a code change. A cancelled planning call is a cancellation, not a fallback.

### Provider compatibility
- Streaming, tool-call and usage reporting differences across providers are handled uniformly; a stream that reports no usage stops a hard-budget task after one request rather than guessing.

### Training-data integrity (Moonshiner)
- Only runs that Pappy judged against host evidence can be exported as positive examples; eligibility and evidence tags are written into the run summary and checked at export.
- FAIL runs are exported only on explicit request, as negative examples with score 0 and outcome `honest_failure`; no Brain routing record accompanies them.
- Runs stopped before completion (cancelled or interrupted) are never exported, as positive or negative examples.
- No automated training is activated by Orca.

### The application itself
- Orca now says which build it is: the welcome screen and window title show "Orca 1.7.0 · build <commit>", and a build from a modified source tree is marked as such. `build-info.json` (version, commit, ref, clean/dirty, build time) ships inside the package.
- The package is lean: the application archive carries only the compiled bundle and renderer (11.5 MB instead of 44 MB); no sources, tests or source maps are shipped.
- Start-up fix: the window could stay on "starting…" when the first paint happened before the page's scripts had run; the initialization status is now delivered once the page has loaded.

## Known limitations
- Process tracking is best effort: identity uses PowerShell `Get-CimInstance` / `ps`; processes that left the process group or were started by an MCP server are not seen; the survivor scan can flag an unrelated short-lived process started during a command (released within seconds by verification).
- An MCP tool that ignores the abort signal is tracked and reported, not killed; lifecycle tracking is in-process (a crash leaves the journal and the protection file to be recovered at the next start).
- Relevance checks are lexical; a documented verification is checked for recording, timing, exit status, output and relevance, not semantic sufficiency; documentation paraphrases are reported as insufficient, never as contradicted.
- Budget: see the limits above. The ledger is per process.
- The runner CLI (`apps/runner`, development only, not distributed) has no workspace guard; this is a blocker before any CLI distribution.
- The desktop app is not type-checked as a whole (`apps/desktop` has no tsconfig); its logic modules are unit-tested.
- Passing tests, evaluation corpora and the mock-provider acceptance show that the checked behaviours hold; they do not prove that every possible task is safe.

## Settings and database compatibility (upgrading from 1.6.0)
- `orca-settings.json` is read as before. Providers, model assignments, API keys (encrypted with `safeStorage` where available), custom providers, MCP configuration, workspace root and other preferences are kept exactly. New optional fields appear when you save: `providers[].billing`, `pricing[]`, `budgetSource`. A budget other than the historical default is treated as yours; the historical $0.10 (or a missing budget) is kept and labelled `legacy_default`.
- `orca-runs.db` gains two nullable columns (`cost_unreconciled_usd`, `cost_basis`) by an idempotent `ALTER TABLE` at open; legacy role names `coder_strong` / `coder_cheap` are renamed to `strong_model` / `cheap_model` in existing rows. Run history, thoughts, tool events and files remain readable. Verified on synthetic 1.6.0-era and original-schema databases.
- New files in the profile: `budget-journal.json`, `workspace-protection.json`, `pipeline-traces/`.
- Older builds ignore the new fields and columns, so a downgrade does not lose data.

## Upgrade procedure (when a release is authorized)
1. Close Orca 1.6.0 (it hides to the tray; use Quit).
2. Back up `%APPDATA%\Orca` (settings, run history) — optional but recommended.
3. Run `Orca Setup 1.7.0.exe` (per-user NSIS installer; it replaces the installed application and keeps the profile) **or** run the portable `Orca 1.7.0.exe` without installing.
4. On first start, read the start-up notices: a historical-default budget, unclassified provider billing, and any recovered protection are reported there.
5. Review Settings → budget and each provider's billing; set a custom price for any metered provider that is not Anthropic.

## Rollback
- Reinstall `Orca Setup 1.6.0.exe` (or restore the backed-up application folder). The profile written by 1.7.0 remains usable by 1.6.0: the extra columns, fields and files are ignored.
- Nothing in the profile is rewritten destructively by 1.7.0.

## Windows signing status
The 1.7.0 candidate binaries are **unsigned** (no code-signing identity exists in the build environment). Windows SmartScreen will warn on first run. Signing is a separate decision before public distribution.

## What is not in 1.7.0
- The Summit Offline Demo Mode (a demonstration feature of the 1.6.x Summit line) is not part of 1.7.0 by decision.
