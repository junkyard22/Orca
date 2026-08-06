# Orca — Production Readiness Roadmap

## What You Have (Honest Assessment)

| Package | Role | Status |
|---|---|---|
| benson-core | User-facing speaker — parses intent, formats replies | ✅ `parseIntent` fully implemented — ambiguity detection, goal/constraint extraction, CLARIFY/TASK routing. |
| dewey-core | User context — workspace capture, git metadata, pre-flight context injection | ✅ `getWorkspaceContext()` captures git branch, commit, recent files; threaded into every task run. |
| orca-core | Runtime wiring — routes tasks through Maestro → Pappy → repair loop | ✅ Solid architecture. Carries `OrcaToolService` in `OrcaRunCtx` for agent-loop mode. |
| maestro-core | Orchestration — classifies tasks, scores risk, plan-gates, manages cancellation | ✅ `orchestrate()` solid. MaestroAdapter runs full agent loop with tools. |
| miranda-core | LLM behavior enforcement — gates, prompt wrapping, output validation, repair loops, circuit breaker | ✅ Production-quality. Also hosts the `MirandaGate` compliance layer. |
| pappy-core | QC evaluator — PASS/WARN/FAIL verdicts + training eligibility on Maestro output | ⚠️ **Phase 4.1–4.4 shipped; 4.5–4.7 open.** Integrity/anti-cheat checks catch 100% of the eval suite's cheats, but 28.6% of correct work is still sent to repair. See Phase 4. |
| pappy-eval | Offline eval harness for Pappy — fixtures + deterministic judges | ✅ Fixture suite plus raw-Pappy and Pappy-plus-hardening judges. Run via `pnpm pappy:eval`. |
| agent-loop-core | The shared tool-calling agent loop | ✅ Extracted from maestroAdapter; used by runner and desktop. Gated via `beforeLLMCall`. |
| workbench-core | Tool execution (Runner + tools) | ✅ ShellRunner done. **Phase 3 complete:** `ToolRegistry` plus read/write/run/list/search tools, and a sandbox policy. |
| claire-core | Conversational presentation layer | ⚠️ Implemented but **no tests**. |
| mcp-client | Wraps MCP servers as `OrcaExtension` instances | ⚠️ Implemented but **no tests**. |
| tool-bootstrap | Assembles the tool/extension registry for app shells | ⚠️ Implemented but **no tests**. |
| ext-docs / ext-github / ext-web | Built-in extensions (Phase 7.3) | ✅ All three implement `OrcaExtension`. |
| apps/runner | CLI harness that wires everything together | ✅ **SHIPPABLE.** Works end-to-end with full agent-loop tool calling. |
| apps/desktop | Electron shell | ✅ **Phase 6 COMPLETE.** Streaming output, tool approval, session history, settings, auth lock, theme toggle, file attachments. Windows `.exe` artifacts produced. |

The architecture is genuinely well-designed. The dependency graph is correct, and
the interfaces are clean.

> Per-package test counts used to be quoted here and went stale by a wide margin
> (miranda-core was listed at 27 when it had 128). Run `pnpm -r --if-present test`
> for current numbers instead of trusting a figure in a document.

---

## The Team/Department Head Mental Model

```
User
  └── Benson (Front Desk / Receptionist)
        └── Orca Runtime (Operations Manager)
              ├── Maestro (Department Router + Project Manager)
              │     ├── brain role        → general reasoning
              │     ├── strong_model role → heavy implementation
              │     ├── cheap_model role  → fast/cheap edits
              │     ├── reviewer role     → critique/review
              │     ├── narrator role     → writing/docs
              │     ├── planner_deep role → complex planning
              │     ├── debugger role     → error diagnosis
              │     ├── reader role       → document ingestion
              │     └── vision role       → image understanding
              ├── Pappy (QC Manager — reviews all output)
              └── Miranda (Compliance Officer — enforces LLM behavior)
```

Each "role" is a named model slot. Maestro's `RoleSelector` already handles routing. The gap is that once a role is selected, nothing tells it what to actually do with an LLM call.

---

## Phase 1 — Make the Core Actually Work ✅ COMPLETE

**Goal:** A real end-to-end task executes and produces real output.

### 1.1 — Implement MaestroAdapter properly ✅

`apps/runner/src/adapters/maestroAdapter.ts` — fully implemented. Uses `RoleSelector`, loads role prompts via `getRolePrompt()`, calls `ctx.llm.complete()` through Miranda. When tools are available, runs the full agent loop instead of a single call.

### 1.2 — Build role system prompts ✅

`maestro-core/src/prompts/rolePrompts.ts` — all 9 roles defined in `ROLE_PROMPTS` with a typed `getRolePrompt()` accessor.

### 1.3 — Implement Benson.parseIntent() for real ✅

`benson-core/src/intent.ts` — ambiguity detection, goal/constraint extraction, returns correct `CLARIFY` / `TASK` discriminated union.

### 1.4 — Implement ShellRunner.execute() ✅

`workbench-core/src/runner.ts` — `child_process.spawn` with stdout/stderr capture, SIGKILL timeout enforcement, exit code handling.

---

## Phase 2 — Subagent Architecture ✅ COMPLETE

**Goal:** Maestro can spawn subagents for parallel or delegated work.

### 2.1 — Define the SubAgent interface ✅

`maestro-core/src/subagent.ts` — `SubAgent`, `SubAgentResult`, `SubAgentStatus`, `SubAgentSpawner` interfaces defined and exported. No external dependencies.

### 2.2 — Implement parallel subagent execution ✅

`apps/runner/src/adapters/maestroAdapter.ts` — when `orch.classification.multiStep === true` at depth 0:

1. `decomposeTask()` calls `planner_deep` to break the task into a JSON array of `{role, task}` subtasks (max 5, fully independent).
2. `runSubagentPool()` runs all subtasks concurrently via `Promise.all()`, each as an isolated `runSingleAgent()` call with the assigned role and `subagentDepth: 1` (prevents recursive decomposition).
3. `synthesizeResults()` merges multiple successful outputs using the `brain` role into a single coherent response.
4. Full `subagentRuns` array recorded in `OrcaMaestroResult` for Doctor/UI visibility.

Decomposition is best-effort: if parsing fails or returns a single item, falls through to normal single-agent execution.

### 2.3 — Add subagent events to the EventBus ✅

`maestro-core/src/types/orchestration.ts` — `OrchestrationEvent` extended with `"subagent:spawned" | "subagent:done" | "subagent:failed"`.
`orca-core/src/types.ts` — `OrcaEvent` union extended with three new typed variants (carrying `subagentId`, `role`, `task`/`ok`/`error`).
`orca-core/src/runtime.ts` — `ctx.emit` populated from the internal `OrcaEmitter` so adapters can fire events upward without importing runtime internals.
`apps/runner/src/index.ts` — listeners for all three events log to stderr with role and id.

---

## Phase 3 — Tool Integration ✅ 3.1–3.3 COMPLETE

**Goal:** Agents can actually do things, not just generate text.

### 3.1 — Define the Tool Registry ✅

`workbench-core/src/tools/types.ts` — `Tool`, `ToolResult`, `ToolRunCtx`, `ToolSchema` interfaces.
`workbench-core/src/tools/registry.ts` — `ToolRegistry` class with `register()`, `get()`, `list()`, and `formatForPrompt()` (renders tool definitions as a prompt block for the LLM).
`orca-core/src/types.ts` — `OrcaToolService` interface added. `OrcaRunCtx` and `OrcaRuntimeDeps` each accept an optional `tools` slot.

### 3.2 — Implement core tools ✅

All five tools live in `workbench-core/src/tools/`:

- **read_file** (`readFileTool.ts`) — reads a file, workspace-relative paths supported
- **write_file** (`writeFileTool.ts`) — writes content, creates missing parent directories
- **run_command** (`runCommandTool.ts`) — shell execution via `child_process.spawn`, timeout + exit code handling
- **list_directory** (`listDirectoryTool.ts`) — directory listing with file/dir type prefix
- **search_files** (`searchFilesTool.ts`) — recursive file walk with text pattern matching, skips `node_modules`/`dist`/`.git`, glob filter support

Factory: `createCoreToolRegistry()` returns a `ToolRegistry` pre-loaded with all five.

### 3.3 — Wire tools into Maestro's LLM calls ✅

`apps/runner/src/adapters/maestroAdapter.ts` — when `ctx.tools` is present, `run()` calls `runAgentLoop()` instead of a single LLM call.

Agent loop protocol:
- Tool definitions are appended to the system prompt via `tools.formatForPrompt()`
- Model signals tool use with `<tool_call>{"tool": "NAME", ...args}</tool_call>` blocks
- Loop parses calls, executes via `ctx.tools.execute()`, feeds back `<tool_result>` blocks
- Continues until no tool calls remain (max 10 iterations)
- All tool events collected into `OrcaMaestroResult.toolEvents`

`apps/runner/src/adapters/toolService.ts` — `createToolService(registry, workspaceRoot)` bridges `ToolRegistry` → `OrcaToolService`.
`apps/runner/src/index.ts` — `createCoreToolRegistry()` + `createToolService()` wired at startup; `WORKSPACE_ROOT` env var sets the working directory.

### 3.4 — Add the adapter pattern for tool extensions ✅

Superseded by Phase 7, which landed. `OrcaExtension` in [`orca-core/src/extension.ts`](packages/orca-core/src/extension.ts) is the formal registration contract; `ExtensionRegistry` converts loaded extensions into an `OrcaToolService`. Direct `registry.register(myTool)` still works for one-off local tools.

---

## Phase 4 — Pappy QC — Make Verdicts Meaningful

**Goal:** Pappy catches real problems, not just structural absences.

**Status: 4.1–4.4 shipped. Effectiveness is now measured, not asserted — see the
numbers below for what remains.**

The original text here claimed Pappy's checks were "mostly did the output have
content at all." That stopped being true some time ago and the section was never
updated. All four sub-items exist in code:

| Item | Where it lives |
|------|----------------|
| 4.1 Task-aware completeness | `pappy-core/src/checks/completeness.ts` — `runCompletenessChecks`, `runSatisfactionChecks` |
| 4.2 File change verification | `pappy-core/src/ahp/fileVerifier.ts` — real filesystem reads, reached via `verifyAHPPacket` |
| 4.3 Tool event correlation | `pappy-core/src/checks/toolResults.ts` |
| 4.4 Repair task specificity | `pappy-core/src/repair.ts` — `buildRepairTask` groups issues by category |

Both entry points are live: `evaluateWithPappy` via `orca-core/src/adapters/pappyPort.ts`,
and `verifyAHPPacket` via `orca-core/src/runtime.ts` and `repairLoop.ts`.

### Measured effectiveness

Run `pnpm pappy:eval:raw-real-pappy` to refresh. Against the 23-fixture suite in
`packages/pappy-eval`:

| Metric | Baseline | Current |
|--------|----------|---------|
| fixtures passed | 3/23 | 19/23 |
| cheat catch rate | 55.6% | 100% |
| false accept rate | 11.1% | 0% |
| false reject rate | 57.1% | 28.6% |
| training-eligibility precision | 100% (vacuous) | 100% |
| evidence grounding | 4.3% | 4.3% |

Baseline is the state before the integrity checks and the training-eligibility
axis landed. "Vacuous" means Pappy never returned `eligible`, so the precision
metric had no denominator and trivially scored 100%.

### 4.5 — Reduce the false reject rate *(open, highest value)*

28.6% of correct work is still sent back for repair. This is the most expensive
defect in the system and the least visible: profiling puts essentially all
wall-clock in LLM inference, so every spurious repair is a full round-trip, and a
wrongly-rejected run still looks like the gate doing its job.

The cause is `completeness.ts` heuristics demanding vocabulary the task never
required. Two have been fixed (`ROUTING_CRITERIA_MISMATCH` firing on failure
words that describe working software; `COMPLETENESS_MISSING_DOMAIN_TERMS`
demanding "fetch"/"response" from anything HTTP-shaped). Known remaining
examples, both reproducible:

- `UNREQUESTED_FILE_CHANGE` fires HIGH on "add a formula evaluator", reading a
  plain change request as inspection-only.
- Goal-concept extraction treats the modal "must" as a required domain concept,
  and derives "form" from "formula" by prefix.

**Warning for whoever picks this up.** Removing "must" from the demanded concepts
is correct in isolation and *regressed* the suite: it turned a partial success
into an accept, because that demand was accidentally carrying a real
incompleteness signal. The fix is a better completeness signal, not more
stopwords. Verify against `false accept rate` — trading a false reject for a
false accept is a loss, not a win.

The suite is 23 fixtures. Treat the percentages as direction, and be wary of
tuning heuristics against it.

### 4.6 — Verdict has no "needs human review" state *(open, needs a design doc)*

Scope drift is detected — an out-of-scope edit to `.env` or `.github/workflows/`
raises `FORBIDDEN_PATH_ACCESSED` and correctly caps training eligibility at
`needs_human_review`. But `Verdict` is `PASS | WARN | FAIL`, so the *verdict*
collapses to WARN and the run goes to repair instead of to a human.

Adding a fourth state changes the contract for every `PappyResult` consumer, and
Miranda already reserves `CONFIRM_REQUIRED` "until wired" per CLAUDE.md. This
needs an explicit design doc covering both, not an improvised fourth enum value.

### 4.7 — Evidence grounding is 4.3% *(open, partly a measurement artifact)*

Pappy emits its own structured citations (`filesChanged: src/foo.ts changeType=M`)
rather than verbatim slices of the input, so the harness's substring-match
grounding check mostly fails even when the citation is accurate. Some of this
number is methodology, not hallucination — see `packages/pappy-eval/GAPS.md` §6
before treating it as a defect.

## Phase 5 — Persistence & Session Management

> ✅ **DONE** — Committed as part of Phase 5 implementation.

**Goal:** Orca remembers what it did and can continue work across sessions.

### 5.1 — Run store / job database ✅

SQLite-backed run store using `better-sqlite3` (zero-infra, desktop-appropriate).
- **`packages/orca-core/src/persistence/types.ts`** — `PersistedRun` schema + `RunStore` port interface
- **`apps/runner/src/store/sqliteRunStore.ts`** — concrete SQLite factory; DB at `~/.orca/runs.db` (override with `ORCA_DB_PATH`)
- Persists per-run: task spec, role, subagent count, tool events, verdict, repair passes, duration, workspace/git info
- `OrcaRuntimeDeps.store` threads the store into the runtime; persisted in a `finally`-style block so every run is recorded even on error
- `OrcaRuntimeDeps.getWorkspaceContext` called once per task start (before any async work)

### 5.2 — Workspace context ✅

- **`packages/orca-core/src/workspaceContext.ts`** — `WorkspaceContext` type + `getWorkspaceContext(cwd?)` factory
- Captures: `cwd`, `gitBranch`, `gitCommit`, `gitCommitMessage`, `recentlyModifiedFiles` (last 3 commits diff)
- Threaded into `OrcaRunCtx.workspaceContext` so all adapters can access it without re-running git
- **`apps/runner/src/adapters/maestroAdapter.ts`** renders a `### Workspace` section in the task prompt with branch/commit/recent files
- Workspace info also written to the `runs` SQLite table for historical queries

### 5.3 — Conversation history for multi-turn tasks ✅

- **`packages/benson-core/src/types.ts`** — `ConversationTurn` type added; `BensonDependencies.maxHistoryTurns` optional (default 8)
- **`packages/benson-core/src/benson.ts`** — closure-internal rolling `history: ConversationTurn[]` buffer; injects last N turns into `taskSpec.context.conversationHistory` before each `executeTask` call
- **`apps/runner/src/adapters/maestroAdapter.ts`** renders a `### Conversation History` section in the task prompt (User / You previously replied blocks); truncates long replies to 400 chars to avoid prompt bloat
- `conversationHistory` stripped from the raw JSON context dump (rendered verbatim above instead)
- `ORCA_HISTORY_TURNS` env var controls the cap

---

## Phase 6 — Desktop App (Electron) ✅ COMPLETE

**Goal:** A real UI that a non-developer can use.

All three sub-items below shipped. The renderer streams output, tool approval and
session history work, and Windows `.exe` artifacts are produced. The sub-sections
are kept for the design rationale, not as open work.

### 6.1 — Replace the renderer skeleton

`apps/desktop/renderer/app.js` is currently empty scaffolding. Build the UI with React (natural fit for the existing TypeScript stack).

The minimum viable UI has:

- Chat input + message history
- Real-time event stream (`task:start`, `maestro:start`, `qc:result`, etc. — all already emitted)
- File change preview (diff view)
- Tool execution log
- Role indicator (which department head is handling this)
- Cost + token display (Miranda already tracks this)

### 6.2 — IPC bridge

`apps/desktop/src/preload.ts` needs to expose Orca's runtime to the renderer via Electron's `contextBridge`:

```typescript
// preload.ts
contextBridge.exposeInMainWorld('orca', {
  sendMessage: (msg: string) => ipcRenderer.invoke('orca:message', msg),
  onEvent: (handler: (event: OrcaEvent) => void) =>
    ipcRenderer.on('orca:event', (_, e) => handler(e)),
});
```

### 6.3 — Settings panel

Users need to configure:

- API keys (per provider)
- Which model maps to which role
- Budget limits
- Workspace root

`apps/desktop/src/settings.ts` exists but is thin. This is where the "assign a model to each department head" UX lives.

---

## Phase 7 — Extension / Adapter System ✅ COMPLETE

**Goal:** Third parties (and you) can add capabilities without modifying core.

### 7.1 — Formalize the adapter contract ✅

Landed in [`orca-core/src/extension.ts`](packages/orca-core/src/extension.ts). The
shipped interface is narrower than the sketch originally in this document — it
carries tools only, not roles or LLM adapters:

```typescript
export interface OrcaExtension {
  readonly id: string;        // reverse-domain, e.g. "@orca/ext-github"
  readonly name: string;
  readonly version: string;
  readonly tools: ExtTool[];  // required, not optional
  onLoad?(): Promise<void>;   // no runtime argument
  onUnload?(): Promise<void>;
}
```

Roles and `llmAdapters` were deliberately left out: role definitions live in
`maestro-core/src/prompts/rolePrompts.ts` and provider wiring is settings-driven,
so neither needs an extension seam yet. Add them only if a real extension needs
them.

### 7.2 — Extension registry ✅

`ExtensionRegistry` and `createExtensionRegistry()` in the same module. The
registry loads extensions, aggregates their tools, and converts itself into an
`OrcaToolService` that drops straight into `createOrcaRuntime({ tools })`. Wired
up in [`apps/runner/src/index.ts`](apps/runner/src/index.ts) and
[`tool-bootstrap`](packages/tool-bootstrap/src/index.ts).

### 7.3 — Built-in extensions ✅

All three ship and implement `OrcaExtension`:

- **@clawde/ext-github** — PRs, issues, commits
- **@clawde/ext-web** — URL fetch, web search
- **@clawde/ext-docs** — PDF/Word ingestion, docx output

Beyond the original plan, [`mcp-client`](packages/mcp-client) exposes MCP servers
as `OrcaExtension` instances, so any MCP server becomes a tool source without
core changes.

---

## Recommended Build Order

| Timeline | Work |
|---|---|
| ~~Week 1–2~~ | ~~**Phase 1** entirely.~~ ✅ **DONE** |
| ~~Week 3~~ | ~~**Phase 3.1–3.3** (core tools).~~ ✅ **DONE** |
| ~~Week 4~~ | ~~**Phase 2.1–2.2** (basic subagents).~~ ✅ **DONE** |
| ~~Then~~ | ~~**Phase 5.1–5.3** (persistence).~~ ✅ **DONE** |
| Then | **Phase 4** (Pappy QC depth). ⚠️ **4.1–4.4 done, 4.5–4.7 open** — effectiveness is measured now; see Phase 4. |
| ~~Then~~ | ~~**Phase 6** (real desktop UI).~~ ✅ **DONE** |
| ~~Then~~ | ~~**Phase 7** (extension system).~~ ✅ **DONE** |

**Every numbered phase is complete except Phase 4, which is measured rather than
finished — 4.5–4.7 remain open.** New work is tracked
below rather than as further phases.

### Open work

| Priority | Work |
|---|---|
| 1 | **Measure prompt-cache hit rate, then act on it.** Profiling shows 99.82% of wall-clock is LLM inference ([PROFILING_FINDINGS.md](PROFILING_FINDINGS.md)), so token volume is the only lever that matters. `TokenUsage.cachedPromptTokens` captures `prompt_tokens_details.cached_tokens`, which DashScope, OpenAI and OpenRouter all report, on both the buffered and the streaming path — streaming needed `stream_options.include_usage`, without which every live agent-loop stage reported no usage at all. `scripts/profiling/analyze.ts` prints the hit rate per run. Collect real numbers before changing prompt assembly — the agent loop's prefix already looks stable, so implicit caching may be working already. |
| 2 | **Tests for the untested packages.** `claire-core` (314 lines), `mcp-client` (505), `tool-bootstrap` (226) have no test files. `claire-core` runs with `--passWithNoTests` purely so the root `pnpm test` stays green. |
| 3 | **Decide the two open architectural questions below** (model pools, multi-workspace). |
| 4 | **Consider splitting the large files.** `apps/desktop/src/main.ts` is 2,378 lines; `ReactAgentAdapter.ts` 1,520; `orca-tracer.ts` 1,515; `maestroAdapter.ts` 1,337. |

---

## Critical Architectural Decisions to Make Now

Before going deep on implementation, these decisions affect everything:

### 1. Synchronous vs streaming output ✅ RESOLVED — streaming
Streaming won, and it shipped. `LLMAdapter` and `OrcaLLMService` both expose
`stream()`, callers pass `onToken`, the agent loop emits `stream:token` events, and
the desktop renderer consumes them over the IPC bridge. Adapters without SSE fall
back to a single buffered `complete()` call that fires `onChunk` once, so a
non-streaming provider still works.

### 2. One model per role vs model pools ⚠️ PENDING
The current `RoleSelector` picks a single role. Miranda already supports model fallback ladders per stage. Decide whether roles map 1:1 to models or whether each role can have a primary/fallback pool.

### 3. Tool execution sandboxing ✅ COMPLETE
When Maestro runs shell commands, you need a security model. **Implemented:**
- Command allowlist for safe read-only operations
- Denied patterns for dangerous commands (sudo, curl | bash, rm -rf /*, credential access)
- Policy-based approval callback system
- Configurable via `SandboxPolicy` in [`workbench-core/src/tools/sandbox.ts`](packages/workbench-core/src/tools/sandbox.ts)

### 4. API key storage ✅ COMPLETE
API keys are now encrypted using Electron's `safeStorage` API (uses OS keychain on Windows/macOS, base64 fallback on Linux without secret service). See [`apps/desktop/src/settings.ts`](apps/desktop/src/settings.ts).

### 5. Multi-workspace support ⚠️ PENDING
Can a single Orca instance manage multiple codebases simultaneously? The current `workspaceRoot` in `Context` is a single path. If yes, this needs to be a first-class concept in the run context.
