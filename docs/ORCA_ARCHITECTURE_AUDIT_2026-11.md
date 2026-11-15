# Orca — Principal Engineering Architecture Audit (2026-11-15)

**Audited commit:** `9974e92` (`main`, includes PR #101) · **Host:** Linux cloud container, Node 22.23.4, pnpm 10.30.2
**Scope:** read-only audit. No production code was changed. Nothing here was run against a real provider or inside Electron.

Version note: the root `package.json` says `1.0.0`; `apps/desktop/package.json` and the build stamp say `1.7.0`. This audit is of the code at the commit above, whichever label applies.

---

## 1. Summary

Orca's verification core is in good shape. Pappy judges against host-collected workspace evidence, the task ledger meters every provider adapter, cancellation is tracked through a real lifecycle, and the training export refuses anything without an evidence tag. I looked for a way to make Pappy report a false PASS, or to spend past the ledger, and did not find one.

The defects are at the edges of that core — in what decides whether a request reaches the pipeline, and in what happens to the result afterwards:

1. **Routing is keyword regex, and it is wrong often.** Questions about the user's code are answered by a model with no tools and no verification. Ordinary edit requests are given read-only permissions and then blocked by Miranda. A request that mentions "review my project" is replaced by a canned static report.
2. **The failure path is brittle.** One transient provider error ends the task: there is no retry, an empty pass is stopped before Pappy and never repaired, and under a hard budget the failed request also blocks the ledger. The user is then told "Quality verification was blocked before evaluation."
3. **The delivered answer is not the verified answer.** Every result is rewritten after QC by a second model at temperature 0.9 with a 1,024-token cap. If that call fails, a completed task is lost. On FAIL the user sees neither the issues nor the output.
4. **Miranda's argument validation blocks every MCP call that passes an array.**

Fourteen findings follow: nine reproduced by running the built code, five confirmed by code inspection. The existing 2,191 passing tests did not catch any of them, because almost every test exercises one component against stubs; nothing runs classifier → runtime → real gate → real Pappy → narration with a scripted model.

**The three changes I would make first** (plan in §6):

| # | Change | Fixes |
|---|---|---|
| 1 | Stop inferring routing and permissions from keywords | F-01, F-05, F-13 |
| 2 | Make the failure and delivery path resilient and honest | F-03, F-04 |
| 3 | One gated choke point for tool execution in the desktop loop, with correct schema typing | F-02, F-06, F-09 |

---

## 2. Baseline — what was actually run

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | passed |
| `pnpm -r build` | passed, exit 0 |
| `pnpm -r --no-bail test` | **2,191 passed · 3 failed · 3 skipped** (exit 1) |
| `pnpm contract:check` | `Status: CLEAR` (clean worktree, nothing to scan) |

Per package: dewey 32, maestro 75, benson 133, miranda 236 (+1 skipped), workbench 130 passed / **3 failed** (+1 skipped), claire 3, pappy 423, pappy-eval 163, orca-core 375, ext-docs 14, ext-web 12, ext-github 18, mcp-client 44, agent-loop-core 12, runner 107, desktop 358 (+1 skipped).

The three failures are all in `packages/workbench-core/src/tools/survivingProcesses.test.ts`. Re-run in isolation: 2 failed, 1 passed. They are not flaky — see F-12: this container's PID 1 does not reap orphans, and Orca's process probe counts a defunct process as alive.

Not run: typechecks, `contract:check:strict`, the pappy-eval corpus commands, packaging, anything requiring a provider key or a display.

---

## 3. Architecture as implemented

### 3.1 Critical execution pipeline (desktop)

```
renderer ── IPC "send-message" ─────────────────────────────── apps/desktop/src/main.ts:2778
  │  taskSessions lock · workspaceGuard.status · createMessageBudget
  ▼
Claire.handleUserMessage ───────────────────────────── packages/claire-core/src/claire.ts:107
  │  classifyIntent (regex) ──────────────────────── packages/benson-core/src/classify.ts:83
  │      ├─ CONVERSATIONAL / NEEDS_CLARIFICATION ──► narrator LLM, no tools, no QC   ◄── F-01
  │      └─ EXECUTABLE → parseIntent → TaskSpec ──── packages/benson-core/src/intent.ts
  │             intent (may be 3 words) · goals · permissions (keyword regex) · mode   ◄── F-05, F-13
  ▼
executeTask wrapper: Dewey.brief + Cargo resolution ───────────── main.ts:2048
  ▼
OrcaRuntime.executeTask ───────────────────────── packages/orca-core/src/runtime.ts:245
  │  task-permission gate ∘ host gate · workspace root · evidence baseline · ledger · lifecycle
  │  ├─ project_audit mode → static audit, no model ────────────── runtime.ts:557      ◄── F-05
  │  └─ maestro.run ─────────────────────────────────────────────── main.ts:1077
  │        brainRoute (LLM, ≤2 attempts) → direct | decompose(≤3) ─ main.ts:560
  │        runRoleWorker → RoleAgentAdapter → ReactAgentAdapter.run  (inline loop, ≤10 turns)
  │            each turn: runGatedLLMCall ─► budgetedAdapter ─► provider     (no retry) ◄── F-03
  │            each call: gate.beforeToolRun → lifecycle.track(tool.execute)
  │                         └─ enforceToolAuthorization (approval, boundary) main.ts:1830
  │            exceptions: warning turn drops calls (F-06) · write rescue skips gate (F-09)
  │        [decompose] result_synthesis (brain LLM)
  ▼
  gate.beforeQC ── empty output ⇒ FAIL, no Pappy, no repair ──── runtime.ts:799-821    ◄── F-03
  pappy.evaluate(workspace evidence, receipts, acceptance contract) → PASS | WARN | FAIL
  gate.afterQC (diagnostic)
  FAIL + repair path ⇒ handleRepairLoop (≤ maxRepairPasses) ─── orca-core/src/repairLoop.ts
  ▼
  persist: writeTrace · store.saveRun (SQLite) · budget journal · workspace protection
  ▼
Claire.presentResult ── narrator LLM, temp 0.9, 1,024 tokens ─── claire.ts:64, main.ts:2029  ◄── F-04
  ▼
reply.text ──► renderer
```

Hard dependencies on the path to a delivered answer: Dewey's context file (read on every task), the brain provider, the worker provider, the narrator provider, SQLite (soft — failures are logged), and the MCP processes for any connector tool.

### 3.2 Components — documented role versus code

| Component | What the code does | Gap against the stated role |
|---|---|---|
| **Maestro** | `maestro-core` supplies classification, role prompts and the fallback pool. The orchestration itself lives in `apps/desktop/src/main.ts` (`buildMaestroAdapter`, ~900 lines) and separately in `apps/runner/src/adapters/maestroAdapter.ts`. | Two independent orchestrators. |
| **Brain** | One routing LLM call per task, validated, with a deterministic fallback route. | Sound. Its input `task.intent` can be a three-word stub (F-13). |
| **Benson** | Regex classifier, intent parser, Cargo syntax, progress copy. `createBenson` and its presenter are **not used by the desktop**. | The user-facing voice is **Claire** (`claire-core`), which does not appear in `ARCHITECTURE.md`'s pipeline. |
| **Miranda** | Stateless gate: tool permissions, workspace boundary, protected paths, schema checks; budget decisions pass through `beforeLLMCall`. | No model allowlist is configured on the desktop, and the gate is handed a pool id (`strong_model_primary`), not a model id (F-14). |
| **Pappy** | Deterministic evaluator (no model). Verdict, evidence status and training eligibility are separate axes. | Sound. Only reached when the pass produced non-empty output (F-03). |
| **Dewey** | Persists the Cargo manifest and produces a brief. | **Signal capture is not wired on the desktop** (F-10). |
| **Moonshiner** | A JSONL exporter in `orca-core`, callable only from the runner CLI. No distillation code exists in this repository. | Export gating is strict; the exported prompt is not the user's message (F-13). |
| **Repair loop** | Re-dispatches on Pappy FAIL with the host record; refuses to "repair" evidence or authorization problems. | Sound once entered; several failures never enter it (F-03). |
| **Agent loop** | `agent-loop-core` is declared the single source of truth; the desktop runs its own 900-line inline loop in `ReactAgentAdapter.ts`. | The loop that ships to users is not the loop the shared tests cover. |

### 3.3 Answers to the ten audit questions

1. **Can verification be bypassed or report false success?** Pappy itself — no bypass found. Around it — yes: conversational routing skips it entirely (F-01); the narrator rewrites verified text and presents WARN and unverified results as "done" (F-04).
2. **Can a model or tool bypass Miranda or spending controls?** Spending: no path found; every provider adapter is wrapped by `budgetedAdapter`. Authorization: one tool call path skips `beforeToolRun` (F-09); the boundary check is lexical (F-14). The desktop's own `enforceToolAuthorization` still runs in both cases.
3. **Can wrong planning propagate?** Yes, and this is the weakest area: F-01, F-05, F-08, F-13.
4. **Are error handling, retries and repair reliable?** The repair loop is. The path into it is not (F-03), and near the turn limit the worker loop silently discards tool calls (F-06).
5. **Can unverified output contaminate training data?** I could not get an unverified *response* exported: the gate needs `verdict=PASS`, `training_eligibility=eligible`, `evidence=verified`, zero repairs, and the tags come from a deterministic source a model cannot write to. What is exported is mislabelled (F-13).
6. **Is Dewey's signal capture functional?** Not on the desktop. On the runner it is crude (F-10).
7. **Concurrency, cancellation, persistence, races?** Cancellation and settlement are careful. Saving Settings mid-task is unguarded (F-07). Dewey's context file is written non-atomically (F-10).
8. **Does model selection respect Settings?** Yes — primaries and fallbacks both come from Settings; nothing is hardcoded. Two caveats in F-14.
9. **Are role boundaries enforced?** Miranda's lock holds in code, with one tension: `before_qc` denial skips the repair loop, which the Architecture Lock says Miranda must not do (F-03).
10. **Where does complexity add latency without measured gain?** §7. I did not measure latency; those are structural observations.

---

## 4. Findings

Status: **Reproduced** = I ran the built code and observed it. **Inspected** = confirmed by reading the code path; not executed. Line numbers are at `9974e92`.

### F-01 · High · Questions about the user's code are answered without tools or verification — Reproduced

**Where:** `packages/benson-core/src/classify.ts:20-45` (`CONVERSATIONAL_PATTERNS`), consumed at `packages/claire-core/src/claire.ts:119-125`.

**Evidence.** `classifyIntent(message, [])` on the built package:

| Message | Result |
|---|---|
| `Why is the login test in auth.test.ts failing?` | `CONVERSATIONAL` |
| `Can you explain how the auth module in this repo works?` | `CONVERSATIONAL` |
| `What is in package.json?` | `CONVERSATIONAL` |
| `Tell me about the retry logic in src/http.ts` | `CONVERSATIONAL` |
| `How does it handle cancellation in runtime.ts?` | `CONVERSATIONAL` |

A `CONVERSATIONAL` message goes straight to `deps.complete` — the narrator model, temperature 0.9, no tools, no workspace, no runtime, no Pappy, no run record.

**Impact.** The most common thing a developer asks a coding assistant — "why is X failing", "how does Y work" — gets a fluent answer from a model that has not read a single file. Nothing in the reply signals that. This is the one place I found where Orca's central promise (answers are checked against evidence) is silently not kept.

**Fix.** Keep the conversational path only for closed-form social messages (greetings, thanks, acknowledgements — the first thirteen patterns). Delete the open-ended ones (`classify.ts:35-41`). Everything else is `EXECUTABLE`, where Brain can still route genuine chat to the narrator role — but through the runtime, with a run record and a verdict.

**Regression tests.** A labelled corpus (~200 messages: social, codebase questions, edits, mixed) asserted against `classifyIntent`; an invariant test that any message naming a file path or a workspace noun (`repo`, `test`, `module`, `function`, a filename) is never `CONVERSATIONAL`.

### F-02 · High · Miranda blocks every MCP call that passes an array argument — Reproduced

**Where:** `packages/miranda-core/src/gate/mirandaGate.ts:929-943`; schema source `packages/mcp-client/src/index.ts:119-120`.

**Evidence.** The gate compares `typeof value` with the schema type. `convertSchema` maps MCP `array` to `"array"`, and `typeof [] === "object"`. Running `convertSchema` output through `createMirandaGate().beforeToolRun` with representative shapes for the two servers `ARCHITECTURE.md` registers:

```
desktop-commander_read_multiple_files → blocked: field "paths" must be array, got object
github-mcp_push_files                 → blocked: field "files" must be array, got object
github-mcp_list_issues                → blocked: field "labels" must be array, got object
```

A gate given a raw `integer` type fails the same way; `mcp-client` converts that to `number`, so only arrays are affected in practice. I used representative schemas, not ones captured from live servers.

**Impact.** Any connector tool with a list parameter can never run, however the model phrases the call. The model sees a type error it cannot satisfy and loops until the empty-result limit stops the worker.

**Fix.** Replace the `typeof` comparison with a small type predicate (`array` → `Array.isArray`, `integer` → `Number.isInteger`, `object` → non-null non-array object).

**Regression tests.** Table test over every schema type × a matching and a non-matching value; a contract test that feeds recorded `tools/list` responses from the registered MCP servers through `convertSchema` and the gate with a valid argument set and expects `allowed`.

### F-03 · High · One transient provider error ends the task, unverified and unrepaired — Reproduced (runtime) / Inspected (retry, ledger)

Four behaviours compound:

1. **No retry anywhere.** `budgetedAdapter.ts:9` states it "never retries"; `openaiCompat.ts` retries only for a `stream_options` rejection; `providerAdapter.ts` has none. `errors.ts:71-72` already classifies 429 and 5xx as retryable in its message text.
2. **The worker turns the error into an empty result.** `ReactAgentAdapter.ts:1618-1635` returns `outputText: ""`, `stoppedBecause: "error"`, discarding the conversation.
3. **Empty output is stopped before Pappy and never repaired.** `runtime.ts:799-821`: `beforeQC` denies empty text (`mirandaGate.ts:1000-1010`), the runtime returns FAIL and skips both Pappy and `handleRepairLoop`. The same happens for `no_final_output` (turn limit reached) — Pappy has dedicated handling and repair tasks for `stoppedBecause` and `loopEvidence` that the desktop can therefore never reach.
4. **Under a hard budget the failed request also blocks the ledger.** `budgetedAdapter.ts:129-131` marks any post-dispatch failure unreconciled; `ledger.ts:403` then blocks the task and charges the full reservation. A 429 or a 401, which bill nothing, is treated like an unknown outcome.

**Evidence.** Real runtime, real gate, real Pappy port, a Maestro stub returning what the adapter returns on a provider error:

```
{"status":"FAIL","summary":"Quality verification was blocked before evaluation.",
 "maestroRuns":1,"pappyRan":false,"repairStarted":false,"qcBlocked":true}
```

`maxRepairPasses` was 2. The provider's actual message (`429 rate limited…`) is in `metadata.errorMessage` and reaches neither the summary nor Claire.

**Impact.** Rate limits and brief outages are routine with every provider. Each one currently costs the user the whole task, and the explanation they get is about "quality verification".

**Contract tension.** `CLAUDE.md`: "Miranda must not … skip repair loops". A `before_qc` denial does exactly that. The code comment (`repairLoop.ts:357`) calls this intended; the two documents disagree and one should change.

**Fix.** See §6, change 2.

**Regression tests.** Fault-injection provider (§8) returning 429 → 200: the task succeeds with one retry and one ledger entry settled. 429 × N: the task fails with the provider's message in `summary`. Empty first pass: Pappy runs and a repair pass is dispatched. Hard budget + HTTP 429: reservation released, ledger not blocked.

### F-04 · High · The delivered answer is a post-QC rewrite, and it is a single point of failure — Reproduced

**Where:** `packages/claire-core/src/claire.ts:64-90`, `packages/claire-core/src/voice.ts:33-60`, `apps/desktop/src/main.ts:2029-2046`.

After the runtime returns, `presentResult` sends the result to the narrator model (temperature 0.9, `maxTokens: 1024`) and returns only what that model writes. Four consequences, each observed with the built packages:

- **(a) A completed task is lost if narration fails.** `executeTask` returned SUCCESS; `complete` threw `503`; `handleUserMessage` rejected with the 503 and no reply. Under a hard budget the same happens when the task spent the budget and the narration request is refused.
- **(b) On FAIL the user gets neither issues nor output.** With a real runtime and real Pappy failing an unverifiable "I fixed it" claim, the entire content the narrator received was: `Still failing after 1 repair pass(es).` `claire.ts:82` uses `summary` and drops `userFacingText`; Pappy's issue list is never passed. For a non-repairable FAIL the summary is the internal string `verdict=FAIL 1xHIGH training_eligibility=… evidence=…`.
- **(c) WARN and unverified results are presented as done.** The runtime maps every non-FAIL verdict to `SUCCESS`, and the prompt opens "The work is done." Nothing about verification status reaches the narrator.
- **(d) Verified text is not what is shown.** A 1,024-token cap means any longer result cannot be delivered intact; `reviewNarration` checks only provenance claims. Claire's history stores the rewrite, so follow-up tasks get the rewrite as context, not what the worker produced.

**Impact.** Pappy's guarantee stops one step short of the user. It also costs one extra model round trip on every task.

**Fix.** See §6, change 2.

**Regression tests.** Narrator throws → reply equals the runtime's `userFacingText`. FAIL → reply contains each blocking issue description. WARN → reply states what was not verified. Result longer than the cap → delivered text contains the full result.

### F-05 · High · Keyword-inferred permissions block ordinary edits; "review my project" hijacks the task — Reproduced

**Where:** `packages/benson-core/src/intent.ts:198-213` (`extractPermissions`), `:102-112` (`isProjectAuditRequest`); enforced at `runtime.ts:251-262` and `mirandaGate.ts:483-508`.

**Evidence.**

| Message | Result |
|---|---|
| `Correct the typo in README.md` | permissions `["read"]` |
| `Bump the version in package.json to 2.0.0` | `["read"]` |
| `Rewrite the parser in src/parse.ts to be iterative` | `["read"]` |
| `Explain how add() works, don't delete or change anything` | `["read","write"]` |
| `Why is the build broken?` | `["read","shell"]` |
| `Review my project and fix the failing login test` | mode `project_audit`, `["read"]` |

`["read"]` normalizes to `fileWrite: false`, the runtime builds a task gate from it, and Miranda answers every write with "File writes are not permitted for this request". In `project_audit` mode the runtime runs a deterministic static audit and calls no model at all (`runtime.ts:557`); the "fix" half of the request is dropped.

**Impact.** The verb list decides whether a task can succeed. "Correct", "bump", "rewrite", "change", "convert", "migrate" are not on it. The user sees a worker that tried and was refused. ("Correct" is even in the leading-verb list used for the intent label — just not in the write list.)

`ARCHITECTURE.md` says task-aware composition is "never by inferring intent from prompt wording"; the flags it relies on are inferred from prompt wording one layer up.

**Fix.** See §6, change 1.

**Regression tests.** Corpus test: every edit-phrased message yields a spec under which a `write_file` inside the workspace passes `beforeToolRun`. A message with both audit language and an action verb is not `project_audit`.

### F-06 · Medium · The desktop agent loop silently discards tool calls on its warning turn — Reproduced

**Where:** `apps/desktop/src/agents/ReactAgentAdapter.ts:1090-1104`.

When two turns remain, the loop appends "You have 2 turns remaining" and `continue`s — before reaching the tool-execution block at `:1161`. Tool calls in that response are never executed and no tool result is returned; the model is not told.

**Evidence.** Scripted model: seven reads on turns 1–7, a `write_file` on turn 8, a final answer on turn 9.

```
executed: read_file ×7          writeExecuted: false
stoppedBecause: "done"          outputText: "I wrote the fix to src/parse.ts."
```

**Impact.** A worker that needs eight turns reports work it did not do. Pappy's workspace evidence should catch the false claim, so the cost is a wasted pass and a repair, not a false PASS — but it is a self-inflicted failure on exactly the long tasks where turns are scarce.

**Fix.** Execute the response's tool calls first, then append the warning alongside the tool results.

**Regression tests.** The scripted scenario above, asserting the write executed. A general invariant test: every `<tool_call>` in a model response yields exactly one of executed / blocked / reported-as-dropped in the next user message.

### F-07 · Medium · Saving Settings while a task runs tears the task's environment down — Inspected

**Where:** `apps/desktop/src/main.ts:2643-2657` (`settings:save`), `:1682-1740` (`_initOrcaImpl`). No `taskSessions` check on either side; `renderer/app.js:2368` opens Settings regardless of `busy`.

During a running task, `initOrca`:

- disposes every MCP connection (`:1692-1696`) — the task's connector tools start failing;
- calls `budgetJournal().recover()` (`:1730`), which returns *every* open journal entry and clears the file (`orca-core/src/budget/journal.ts:85-92`) — the live task is reported as a possible charge from "a previous process", an `interrupted` run record is saved for it, and its later journal updates become no-ops, so a real crash afterwards leaves no record of its exposure;
- replaces `claire`, discarding the conversation history.

**Reproduction.** Start a long task; open Settings; press Save. Not exercised here — no Electron in this environment.

**Fix.** Refuse `settings:save` (or defer the re-init) while `taskSessions.current` is unsettled, and say so in the Settings form. Carry Claire's history across re-inits.

**Regression tests.** `settings:save` with an active session returns a refusal and leaves `mcpDispose` uncalled; `recover()` is not invoked while a ledger is open in-process.

### F-08 · Medium (High on the CLI) · The workspace root is taken from prose in the user's message — Reproduced

**Where:** `packages/orca-core/src/runtime.ts:52-103` (`extractExplicitWorkspaceRoot`), used at `:264-265` ahead of the configured root.

Any token that looks like a path and exists on disk becomes the task's workspace root. With the configured root `…/packages/benson-core`:

```
"Compare our config with /etc/hosts and report"          → effectiveRoot "/etc"
"Should the CLI accept yes / no answers? Update cli.ts"  → root "/"; did not finish in 60 s
```

In the second case the bare `/` in "yes / no" resolves to the filesystem root; the evidence baseline then walks it. An earlier unbounded run of the same message was OOM-killed.

**Exposure.** The desktop sets `context.workspaceRoot` from Settings on every task (`main.ts:2130`) and that is tried first, so the desktop is affected only if the configured folder has disappeared since start-up. The runner CLI passes no such context and is fully exposed. The effective root is what Miranda's boundary check and tool execution use, so this moves the security boundary on the strength of a regex.

**Fix.** Remove the prose scan. The root comes from Settings (desktop), `WORKSPACE_ROOT`/cwd (CLI), or an explicit structured `context.workspaceRoot`. A path in the message is an argument for a tool call, which the boundary check then judges.

**Regression tests.** The two messages above leave the configured root unchanged. A task whose `context.workspaceRoot` does not exist fails fast with a clear error.

### F-09 · Medium · The post-loop "write rescue" writes a file without passing Miranda — Inspected

**Where:** `apps/desktop/src/agents/ReactAgentAdapter.ts:1448-1486`.

If the task text "implies a file save", the worker never called a write tool, a final answer was rejected, and the loop ended in under four turns, the adapter calls `writeTool.execute` directly: no `beforeToolRun`, no `afterToolRun`, no `lifecycle.track`. Task permissions, protected paths and AHP constraints are not consulted. The target is the *first* filename-shaped token in the task text and the content is the model's rejected prose answer, so for "Read src/config.ts and save a summary to docs/summary.md" the regex at `:1459` selects `src/config.ts`.

The desktop's `enforceToolAuthorization` inside `tool.execute` still applies. Reaching this branch needs an early loop exit (a tool-failure or parse-failure stop within three turns), which is why I rate it Medium; I did not construct a full reproduction.

This violates the Architecture Lock rule "Tool execution must pass through `beforeToolRun` and `afterToolRun`".

**Fix.** Delete the rescue. A worker that did not write is a FAIL with a specific repair instruction, which the repair loop already handles (`repairLoop.ts:217-224`).

**Regression tests.** A structural test that `tool.execute` is reachable in the adapter only through the gated helper (§6, change 3).

### F-10 · Medium · Dewey does not capture signals on the desktop, and its store can lock the app out — Inspected

**Where:** `packages/dewey-core/src/dewey.ts`, `context/contextStore.ts:133-162`; desktop call sites `main.ts:1324, 2049-2050`.

- **Capture is not wired.** The desktop calls only `brief()` and the manifest methods. `observe()`, `reviewPlan()` and `startSession()` are called only by the runner. On the desktop `learnedPreferences` is never written, so every brief reports tone `casual` and no preferences. The brief is emitted as an event and traced; I found no place where its tone or preferences reach a model prompt.
- **The runner's capture is crude.** `maestroAdapter.ts:385-391` records the observation before Pappy has run, with a verdict derived from tool errors. One request containing "as json" stores `prefer_json` permanently; signals never expire and contradict each other freely.
- **Task categories are from another product.** `detectTaskType` knows `scheduling`, `food`, `communication`; coding is `work` only if the intent contains "code", "coding" or "implement".
- **Persistence is fragile.** `save()` is a plain `writeFile` (no temp file + rename, unlike the budget journal). A crash mid-write leaves invalid JSON; `load()` rethrows anything but `ENOENT`, and `getManifest()` runs at the start of every task and at the end of every `send-message`. A corrupt `~/.orca/userContext.json` therefore fails every request until the user deletes the file by hand. `recentTasks` grows without bound.

**Fix.** Atomic write; on a parse error, move the file aside and start from the template with a visible warning. Then decide whether Dewey learns at all: either wire `observe()` after the final verdict with decay and an explicit opt-out, or cut the learning surface and describe Dewey as the context manifest it currently is.

**Regression tests.** Truncated context file → app starts, warning shown, original preserved as `.corrupt`. If capture is kept: two contradictory requests do not both persist; an observation is recorded only after a non-FAIL verdict.

### F-11 · Low · An exhausted repair persists a mixed record — Inspected

**Where:** `repairLoop.ts:462-473`, `runtime.ts:937-947`.

When repairs run out, the returned result carries neither `artifacts` nor `qcResult`, so the runtime keeps the *first* pass's Maestro result and QC result. The saved run then pairs the last repair's output text with the first pass's role, tool events, changed files and issue list. The summary also says "after N repair pass(es)" using the configured maximum even when the loop stopped early at `:455`.

**Fix.** Return `artifacts: currentArtifacts, qcResult: currentQC` and count the passes actually run. **Test:** exhaust two passes with distinct tool events and assert the persisted events and issues belong to the last pass.

### F-12 · Low · A defunct process is treated as a live writer — Reproduced (as the 3 baseline test failures)

**Where:** `packages/workbench-core/src/tools/processIdentity.ts:44, 185`.

The probe asks `ps` for `lstart` only. A zombie still has a start time, so it reads as alive and, as an "unsettled resource", makes evidence partial and can leave the workspace protected. Any host whose PID 1 does not reap orphans shows this — including a container started without an init process (this audit's host, and any `docker run` of the runner image without `--init`).

**Fix.** Include `stat` in the `ps` columns and treat `Z` as gone. **Test:** the existing three tests, which then pass here.

### F-13 · Medium · The stored "intent" is a truncated stub, and it becomes the training prompt — Reproduced

**Where:** `packages/benson-core/src/intent.ts:134-161`; consumers `exportTrainingData.ts:264, 291`, `main.ts:1079` (`maestroCore.orchestrate(task.intent)`), `main.ts:2050` (`dewey.brief(spec.intent)`), `runtime.ts:1240` (run record).

For a message over 80 characters that does not begin with one of 40 listed verbs, the intent is its first three words:

```
"Please take a look at the date parsing in src/parse.js because … then fix it"  → "Please take a"
"In src/parse.js the loop bound is wrong and the last element is skipped; …"     → "In src/parse.js the"
```

Workers are unaffected — they read the goals, which hold the full message. But the run record's `intent`, Maestro's risk classification, Dewey's task type, and the Moonshiner export all use the stub. An exported training record is `{prompt: "Please take a", response: <full verified answer>}`; the `brain` record pairs the same stub with the routing decision at score 10, including when the routing policy overrode that decision.

Also relevant to Moonshiner: the export reads `~/.orca/runs.db` (`runner/src/index.ts:510`); the desktop writes `userData/orca-runs.db`. Desktop runs are not exported unless `ORCA_DB_PATH` is pointed at that file.

**Fix.** Persist `originalUserMessage` on the run record and export that as the prompt. Use the full message for classification. Skip the `brain` record when the executed route differs from Brain's decision.

**Regression tests.** Export of a run whose message is 200 characters yields `prompt` equal to the message. A run with a remapped route yields no `brain` record.

### F-14 · Low · Smaller items — Inspected (boundary check Reproduced)

| Item | Where | Note |
|---|---|---|
| Lexical workspace boundary | `mirandaGate.ts:536-550` | No `realpath`. A symlink inside the workspace pointing out passes the gate (reproduced). Core tools re-check with `realpath` (`workbench-core/src/tools/workspacePath.ts:51`); MCP file tools do not. |
| Gate sees a pool id, not a model | `main.ts:982`, `ReactAgentAdapter.ts:940` | `beforeLLMCall` receives `strong_model_primary`. Harmless today (no allowlist configured); an allowlist added later would never match. |
| Fallback cooldown on any error | `main.ts:1030-1036` | Any worker error — a gate block, a parse failure — puts the Settings-chosen primary in a 30 s cooldown; with fallbacks configured the next pass silently uses a different model. Only provider failures should count. |
| Unconfigured role uses Brain's model | `main.ts:871-882` | Recorded in the trace only. Worth an init warning. |
| Documentation drift | `CLAUDE.md`, `ARCHITECTURE.md` | Both still describe budget fields as neutral placeholders (they are live), list stage names the desktop does not use (`agent_iteration`, `brain_route`, `result_synthesis`, `claire_narration` are the real ones), and omit Claire. |
| Two agent loops | `ReactAgentAdapter.ts`, `agent-loop-core` | Acknowledged in `ARCHITECTURE.md`. F-06 and F-09 exist only in the desktop copy. |

### Looked for and not found

- A way for model output to forge the training-eligibility tags: `internalSummary` is built from fixed tokens (`pappy.ts:1325-1339`) and the tags are appended by code.
- A provider call that escapes the ledger: all adapters come from `buildAdapterForProvider`, which always wraps.
- A late tool or model call after Stop: both are refused by `lifecycle.mayDispatch`.
- An export of a stopped, repaired, or evidence-less run: all three are filtered.

Not audited in depth: Pappy's individual heuristics (1,500 lines of pattern rules — I checked structure, not each rule), the runner's `maestroAdapter.ts`, the renderer, Windows-specific paths, packaging.

---

## 5. Prioritized register

Scored 1–5. *Reliability* and *User value*: higher is more gain. *Risk* and *Effort*: higher is worse. *Perf*: effect on latency/cost (+ faster, − slower, 0 neutral). *Diff.* = relevance to "answers are verified".

| Rank | ID | Finding | Sev. | Status | Reliability | User value | Risk | Effort | Perf | Diff. |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | F-01 | Codebase questions bypass tools and QC | High | Reproduced | 4 | 5 | 2 | 1 | − | 5 |
| 2 | F-03 | Transient error ends the task | High | Reproduced | 5 | 5 | 3 | 3 | 0 | 3 |
| 3 | F-04 | Post-QC rewrite / narration SPOF | High | Reproduced | 4 | 5 | 2 | 2 | + | 5 |
| 4 | F-05 | Keyword permissions and audit hijack | High | Reproduced | 5 | 5 | 3 | 2 | 0 | 2 |
| 5 | F-02 | Gate blocks array arguments | High | Reproduced | 4 | 4 | 1 | 1 | 0 | 2 |
| 6 | F-06 | Tool calls dropped on warning turn | Medium | Reproduced | 3 | 3 | 1 | 1 | + | 3 |
| 7 | F-07 | Settings save mid-task | Medium | Inspected | 3 | 3 | 1 | 1 | 0 | 2 |
| 8 | F-13 | Intent stub / training prompt | Medium | Reproduced | 2 | 2 | 2 | 2 | 0 | 5 |
| 9 | F-08 | Workspace root from prose | Medium | Reproduced | 3 | 2 | 1 | 1 | 0 | 3 |
| 10 | F-09 | Write rescue skips Miranda | Medium | Inspected | 2 | 2 | 1 | 1 | 0 | 4 |
| 11 | F-10 | Dewey capture / store | Medium | Inspected | 3 | 2 | 1 | 2 | 0 | 2 |
| 12 | F-11 | Mixed record after exhausted repair | Low | Inspected | 1 | 2 | 1 | 1 | 0 | 3 |
| 13 | F-12 | Zombie counted as alive | Low | Reproduced | 2 | 1 | 1 | 1 | 0 | 1 |
| 14 | F-14 | Smaller items | Low | Mixed | 1 | 1 | 1 | 2 | 0 | 2 |

---

## 6. Implementation plan — top three

None of these adds a component, a provider assumption, or a setting that overrides Settings. Each is mostly deletion.

### Change 1 — Stop inferring routing and permissions from keywords (F-01, F-05, F-13)

**Principle.** Benson may recognise a closed set of social messages. It may not decide what a task is allowed to do, or replace the task, from vocabulary. Capability comes from Settings (role capabilities, `toolsAllowed`) and is enforced by Miranda and the approval layer, which already exist.

1. `classify.ts`: remove the open-ended conversational patterns (`:35-41`). Anything not in the closed social set is `EXECUTABLE`.
2. `intent.ts` `extractPermissions`: stop emitting restrictive flags from verb lists. Emit a restriction only for an explicit one in the message ("read-only", "don't change/modify/write anything"). Otherwise leave `permissions` undefined, which `ARCHITECTURE.md` already defines as "the role's baseline is used as-is".
3. `intent.ts` `isProjectAuditRequest`: require the audit phrasing *and* the absence of any action request; otherwise `mode: "default"`. Alternatively make the static audit a tool Brain can route to.
4. `intent.ts` `extractIntent` and `persistence`: keep `intent` as a display label; add `originalUserMessage` to `RunRecord` (one nullable column, idempotent migration like `brain_decision`). Classification, Dewey and the export use the full message.

**Risk.** More messages enter the pipeline, so simple questions cost a Brain call and a worker. That is the correct trade for a product whose claim is verification, and pure chat can still be routed to the narrator role. Network permission needs a decision: today it is keyword-granted; I would default it from whether connectors are attached (`enrichTaskWithCargo` already does this).

**Contract check.** Touches role contracts and Benson output → run `pnpm contract:check` first; expect REVIEW REQUIRED.

**Size.** ~150 lines changed across two files, one migration, one corpus fixture.

### Change 2 — A resilient, honest failure and delivery path (F-03, F-04)

1. **Retry once, in one place.** Add a thin retry adapter *beneath* `budgetedAdapter` in `providerAdapter.ts`: for errors classified transient (HTTP 408/429/5xx, connection reset before any token was received) retry with capped backoff, honouring `Retry-After`, bounded by attempts and by the abort signal. Limits belong in Settings with conservative defaults. No retry after partial streamed output. The budget wrapper sees one logical request.
2. **Do not charge what was provably not billed.** In `budgetedAdapter`'s catch, `release` the reservation for HTTP 401/403/404/429 and for connection failures before the request body was sent; keep `markUnreconciled` for everything ambiguous. The ledger's conservatism is preserved where the outcome is actually unknown.
3. **Let an empty pass be judged.** In `runtime.ts`, when `beforeQC` denies for empty output, do not return: call Pappy with the pass metadata (`stoppedBecause`, `loopEvidence`, `errorMessage`), which already yields a FAIL with a repair task, and continue to the normal repair decision. Carry `metadata.errorMessage` into the result summary. Update the Architecture Lock wording so `before_qc` is described consistently — this needs the explicit design note the lock asks for.
4. **Narration cannot lose or distort a result.**
   - `presentResult`: wrap `deps.complete` in try/catch; on any failure return the runtime's `userFacingText` (or the failure summary) unchanged.
   - Deliver long or structured results verbatim: the narrator writes a short lead-in; the verified text is appended by code, not regenerated. This removes the 1,024-token ceiling and the rewrite risk together.
   - FAIL: pass Pappy's blocking issue descriptions and the worker's last output to the prompt, and include the issue list verbatim below the narrated line.
   - Pass the verification status (`verified` / `unverified` / WARN issues) and require the reply to state what was not verified; append a fixed one-line status from Benson's copy so it cannot be dropped.
   - Store the runtime's text, not the rewrite, in the history that feeds later tasks.

**Risk.** Item 3 changes a documented stop into a repair attempt — it needs sign-off as a contract change. Item 1 can double latency on a failing provider; bound it tightly. The rest is additive.

**Contract check.** Touches LLM call paths, Miranda gates, Pappy QC flow → REVIEW REQUIRED expected.

**Size.** ~250 lines: one new small adapter, edits in `budgetedAdapter.ts`, `runtime.ts`, `claire.ts`, `voice.ts`.

### Change 3 — One gated choke point for tool execution in the desktop loop (F-02, F-06, F-09)

1. `mirandaGate.ts`: replace the `typeof` comparison with a JSON-Schema-aware predicate (F-02). Five lines; ship this first and on its own.
2. `ReactAgentAdapter.ts`: extract the body of the per-call block (`:1161-1402`) into one `executeGatedToolCall(call)` helper — gate before, lifecycle-tracked execute, gate after, result message, event record.
3. Move the turn-limit warning after the tool-execution step so no call is discarded (F-06).
4. Delete the post-loop write rescue (F-09).
5. Add an invariant at the end of each turn: every parsed call was executed, blocked, or explicitly reported as dropped.

This is also the practical first step toward the single shared loop `ARCHITECTURE.md` already asks for: once the desktop's tool step is one function, moving it into `agent-loop-core` is a relocation rather than a rewrite. I would not attempt the full unification now.

**Risk.** Low. Step 4 removes behaviour some runs currently rely on; the repair loop covers the same case with the gate intact.

**Contract check.** Touches tool execution and Miranda gates → REVIEW REQUIRED expected.

**Size.** Net negative; ~60 lines removed.

### Suggested order

F-02 fix (hours, isolated) → Change 2 items 4 and 1 → Change 1 → rest of Change 3 → Change 2 item 3 after the contract decision → F-07, F-08, F-10 store hardening, F-11, F-12 as small follow-ups.

---

## 7. Latency and complexity — structural observations

Not measured; `PROFILING_FINDINGS.md` and `profile-runs/` were not re-run. Each of these is visible in the code path.

- **Post-QC narration** adds a full model round trip to every task (F-04). Change 2 reduces it to a short lead-in and makes it skippable.
- **Brain routing** is a model call for every executable message, including the trivially direct ones. A deterministic pre-route already exists as the fallback (`auditDecomposeFallback`); using it first for unambiguous single-role tasks would save a round trip. Suggestion only — it trades planning quality for speed and should be measured.
- **Evidence settling** can wait up to 8 s for process scans and 10 s for resource settlement before each Pappy evaluation (`runtime.ts:420-431`); `PROJECT_STATE.md` records ≈3.4 s per command for the survivor scan on Windows. This buys real integrity. The cost would fall if scans ran only after commands that could plausibly leave children.
- **Text-protocol tool calls** (`<tool_call>` JSON in prose) require a parser, a batch enforcer, parse-failure counters and re-prompts. Native tool-calling where a provider supports it would remove most of that, but it is a provider-capability feature and belongs behind the adapter interface — a larger change than anything in §6.
- **AHP packets** are created, traced, verified and serialized for every run, including single-worker runs where root and child carry the same content. I found no consumer of the single-run graph beyond the trace and a stderr summary.
- **Dewey's brief** is computed twice per task (`main.ts:2050` and `:1324`) and, on the desktop, influences nothing.

---

## 8. Regression and fault-injection strategy

The gap is a missing layer, not missing volume. Today's tests are component tests with stubs on both sides. Every finding above lives at a seam between two components.

**Layer A — Pipeline tests with a scripted provider (new; highest value).**
One harness that wires the real pieces — `classifyIntent` → Claire → runtime → real `createMirandaGate` → real `createPappyPort` → `ReactAgentAdapter` — against a temporary workspace and a `ScriptedProvider` implementing `LLMAdapter`. A script is a list of responses or faults per stage. The probes used in this audit are the first seven cases. This runs in vitest in seconds and needs no Electron.

**Layer B — Fault-injection matrix.** Each row is one scripted run with an asserted outcome (delivered text, verdict, ledger state, run record).

| Fault | Injected at | Expected |
|---|---|---|
| HTTP 429, then success | worker turn | task succeeds; one settled ledger entry |
| HTTP 429 × N | worker turn | FAIL; provider message in the reply; ledger not blocked |
| HTTP 500 mid-stream after tokens | worker turn | no retry; unreconciled; clear reply |
| Timeout / connection reset | Brain route | deterministic fallback route; task proceeds |
| Empty completion | worker turn | Pappy runs; repair dispatched |
| Malformed `<tool_call>` × 3 | worker | `parse_failure_loop`; Pappy FAIL; repair |
| Tool call on turns 8, 9, 10 | worker | each executed or explicitly reported |
| Invented tool results in output | worker | cut; not executed; model told |
| Narrator throws / refused by budget | after SUCCESS | verified text delivered unchanged |
| Pappy FAIL, no repair path | QC | reply lists the blocking issues |
| Tool hangs past abort | tool | task INTERRUPTED; workspace protected |
| MCP server exits mid-task | tool | tool error surfaced; no hang |
| Settings saved mid-task | IPC | refused; MCP connections intact |
| Corrupt `userContext.json` / budget journal / protection file | start-up | app starts; warning; file preserved |
| SQLite write failure | `saveRun` | task result still delivered |
| Hard budget reached mid-pass | ledger | FAIL with figures; no further requests |
| Process survivor / zombie | after command | survivor keeps protection; zombie does not |

**Layer C — Corpora instead of examples.**
- *Routing corpus*: ~200 labelled messages for `classifyIntent` and the permission/mode decisions. This turns F-01/F-05 from anecdotes into a tracked accuracy number and stops regressions when a pattern is edited.
- *MCP schema fixtures*: recorded `tools/list` output from each registered server, replayed through `convertSchema` and the gate with valid arguments. Catches F-02-class breaks when a server updates.

**Layer D — Invariants (property-style).**
- Every tool call in a model response has exactly one fate recorded.
- The text delivered to the user contains the verified `userFacingText`, or a verbatim failure report.
- No training record is produced unless verdict, eligibility and evidence tags all agree, and its prompt equals the stored user message.
- A run record's tool events, files and issues come from the same pass as its output text.
- No `tool.execute` call site exists outside the gated helper (a static check suited to `contract:check`).

**Layer E — One packaged smoke per release.** The existing `scripts/desktop-validation` mock covers this; add the Settings-save-mid-task and narrator-failure cases to it.

**CI.** `survivingProcesses.test.ts` currently fails in any container without an init process. Until F-12 is fixed, run CI containers with `--init` or these three stay red for an environmental reason and train people to ignore them.

---

## 9. Limits of this audit

- Nothing was run against a live provider or inside Electron. Findings marked *Inspected* have not been executed end to end; F-07 in particular should be confirmed in the running app before it is scheduled.
- F-02 used representative MCP schemas, not ones captured from live servers.
- Latency observations in §7 are structural and unmeasured.
- Pappy's individual heuristics, the runner orchestrator and the renderer were read selectively.
- Severity reflects my judgement of user impact on the desktop app; the runner CLI is treated as the development tool `PROJECT_STATE.md` says it is.
