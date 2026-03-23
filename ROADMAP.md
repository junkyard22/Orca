# Orca — Production Readiness Roadmap

## What You Have (Honest Assessment)

| Package | Role | Status |
|---|---|---|
| benson-core | User-facing speaker — parses intent, formats replies | ✅ `parseIntent` fully implemented — ambiguity detection, goal/constraint extraction, CLARIFY/TASK routing. |
| dewey-core | User context — workspace capture, git metadata, pre-flight context injection | ✅ `getWorkspaceContext()` captures git branch, commit, recent files; threaded into every task run. |
| orca-core | Runtime wiring — routes tasks through Maestro → Pappy → repair loop | ✅ Solid architecture. Carries `OrcaToolService` in `OrcaRunCtx` for agent-loop mode. |
| maestro-core | Orchestration — classifies tasks, scores risk, plan-gates, manages cancellation | ✅ `orchestrate()` solid. MaestroAdapter runs full agent loop with tools. |
| miranda-core | LLM behavior enforcement — wraps prompts, validates outputs, repair loops, circuit breaker | ✅ Most complete package. Production-quality. 27 tests passing. |
| pappy-core | QC evaluator — PASS/WARN/FAIL verdicts on Maestro output | ✅ **Phase 4 COMPLETE.** 84 tests passing. SATISFACTION_EXPLANATION_THIN, PROOF_NO_TRACE, and all claim-proof checks working. |
| workbench-core | Tool execution (Runner + tools) | ✅ ShellRunner done. **Phase 3 complete:** `ToolRegistry`, `readFileTool`, `writeFileTool`, `runCommandTool`, `listDirectoryTool`, `searchFilesTool` all implemented. |
| apps/runner | CLI harness that wires everything together | ✅ **SHIPPABLE.** Works end-to-end with full agent-loop tool calling. Tool registry + `OrcaToolService` wired. |
| apps/desktop | Electron shell | ✅ **Phase 6 COMPLETE.** Full renderer with streaming output, tool approval, session history, settings, auth lock, theme toggle, file attachments. Windows `.exe` artifacts produced. |

The architecture is genuinely well-designed. The dependency graph is correct. The interfaces are clean. What's missing is the meat inside several of those interfaces.

---

## The Team/Department Head Mental Model

```
User
  └── Benson (Front Desk / Receptionist)
        └── Orca Runtime (Operations Manager)
              ├── Maestro (Department Router + Project Manager)
              │     ├── brain role        → general reasoning
              │     ├── coder_strong role → heavy implementation
              │     ├── coder_cheap role  → fast/cheap edits
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

### 3.4 — Add the adapter pattern for tool extensions ⬜

The `OrcaExtension` interface (Phase 7) will formalize third-party tool registration. For now, custom tools can be added by calling `registry.register(myTool)` before `createToolService()` in the app shell.

---

## Phase 4 — Pappy QC — Make Verdicts Meaningful

**Goal:** Pappy catches real problems, not just structural absences.

Right now Pappy's checks are mostly "did the output have content at all?" That's not enough for production.

### 4.1 — Task-aware completeness checks

Pappy needs to compare what was asked against what was delivered. If the task was "implement a login form" and the output doesn't mention `form`, `submit`, or `validation` — that's a FAIL, not a PASS.

### 4.2 — File change verification

If Maestro claimed to write files, Pappy should verify those files exist and contain the expected content. This requires Pappy to have read-only filesystem access.

### 4.3 — Tool event correlation

If a task required running tests and no test runner tool event exists in the result, that's a WARN at minimum.

### 4.4 — Expand repair task specificity

`buildRepairTask()` in `pappy-core/src/repair.ts` should generate targeted repair prompts, not generic ones. "Fix 2 HIGH issues: missing error handling in `write_file` call (line ~45) and no validation for empty input" is more actionable than "please fix the issues."

---

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

## Phase 6 — Desktop App (Electron)

**Goal:** A real UI that a non-developer can use.

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

## Phase 7 — Extension / Adapter System

**Goal:** Third parties (and you) can add capabilities without modifying core.

### 7.1 — Formalize the adapter contract

```typescript
// In orca-core/src/adapters/
export interface OrcaExtension {
  id: string;
  name: string;
  version: string;

  // Optional capabilities this extension adds
  tools?: Tool[];
  roles?: Record<string, RoleDefinition>;
  llmAdapters?: LLMAdapter[];

  // Lifecycle hooks
  onLoad?(runtime: OrcaRuntime): Promise<void>;
  onUnload?(): Promise<void>;
}
```

### 7.2 — Extension registry

A simple registry in `orca-core` that loads extensions at startup and makes their tools/roles available to Maestro and the `RunnerRegistry`.

### 7.3 — Built-in extension examples to ship with

- **@orca/ext-github** — read PRs, issues, create commits
- **@orca/ext-web** — fetch URLs, search the web
- **@orca/ext-docs** — read PDFs, Word docs, render output to docx

---

## Recommended Build Order

| Timeline | Work |
|---|---|
| ~~Week 1–2~~ | ~~**Phase 1** entirely.~~ ✅ **DONE** |
| ~~Week 3~~ | ~~**Phase 3.1–3.3** (core tools).~~ ✅ **DONE** |
| ~~Week 4~~ | ~~**Phase 2.1–2.2** (basic subagents).~~ ✅ **DONE** |
| ~~Now~~ | ~~**Phase 5.1–5.3** (persistence).~~ ✅ **DONE** |
| ~~Now~~ | ~~**Phase 4** (Pappy QC depth).~~ ✅ **DONE** (84 tests passing) |
| **Now** | **Phase 6** (real desktop UI). Something you can hand to a non-developer. |

| Ongoing | **Phase 7** (extension system) in parallel with the above. |

---

## Critical Architectural Decisions to Make Now

Before going deep on implementation, these decisions affect everything:

### 1. Synchronous vs streaming output ⚠️ PENDING
Miranda's pipeline returns completed text. For good UX, you want streaming — the user sees output appearing as it's generated. This requires changes to `LLMAdapter`, `OrcaLLMService`, and the IPC bridge. **Decide before the UI layer is built.**

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
