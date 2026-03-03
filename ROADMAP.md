# Orca — Production Readiness Roadmap

## What You Have (Honest Assessment)

| Package | Role | Status |
|---|---|---|
| benson-core | User-facing speaker — parses intent, formats replies | Thin stub. `parseIntent` is not implemented beyond a placeholder. |
| orca-core | Runtime wiring — routes tasks through Maestro → Pappy → repair loop | Solid architecture. Clean dependency injection. Works. |
| maestro-core | Orchestration — classifies tasks, scores risk, plan-gates, manages cancellation | Logic is real and good. But `run()` on `MaestroCore` just echoes the task back — it never actually calls an LLM to do work. |
| miranda-core | LLM behavior enforcement — wraps prompts, validates outputs, repair loops, circuit breaker | Most complete package. Solid. Production-quality internal logic. |
| pappy-core | QC evaluator — PASS/WARN/FAIL verdicts on Maestro output | Works, but checks are shallow heuristics. Needs real signal. |
| workbench-core | Tool execution (Runner interface) + diagnostics (Doctor) | `ShellRunner.execute()` throws "not yet migrated". Doctor is functional. |
| apps/runner | CLI harness that wires everything together | Works end-to-end as a test harness. |
| apps/desktop | Electron shell | Bare skeleton — renderer is a plain HTML file with no real UI. |

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

## Phase 1 — Make the Core Actually Work

**Goal:** A real end-to-end task executes and produces real output.

### 1.1 — Implement MaestroAdapter properly

`apps/runner/src/adapters/maestroAdapter.ts` is the bridge between Orca's runtime and Maestro's logic. Right now `MaestroCore.run()` just returns the task description as output. You need:

```typescript
// What maestroAdapter needs to do:
async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
  // 1. Use RoleSelector to pick the right role based on task context
  const roleResult = selectRole({ task: task.intent, ... }, availableRoles);

  // 2. Build a role-specific system prompt
  const systemPrompt = buildSystemPromptForRole(roleResult.role);

  // 3. Call ctx.llm.complete() — this goes through Miranda automatically
  const response = await ctx.llm.complete(
    `${systemPrompt}\n\nTask: ${task.intent}\nGoals: ${task.goals.join(', ')}`
  );

  return {
    outputText: response.text,
    summary: `Completed via ${roleResult.role} role`,
  };
}
```

This is the single most important missing piece. Without it, Orca produces no real output.

### 1.2 — Build role system prompts

Each role needs a system prompt that defines its behavior. These become your "department head instructions":

- **brain** — General reasoning, analysis, planning
- **coder_strong** — Full implementation, architecture decisions, complex code
- **coder_cheap** — Quick edits, small fixes, formatting, trivial changes
- **reviewer** — Critique, identify problems, suggest improvements
- **narrator** — Documentation, READMEs, user-facing writing
- **planner_deep** — Structured multi-step plans with acceptance criteria
- **debugger** — Root cause analysis, fix proposals for errors/failures
- **reader** — Summarize large documents into actionable points
- **vision** — Interpret images, diagrams, screenshots

Store these in `maestro-core/src/prompts/` as typed constants. They're the personality of each department head.

### 1.3 — Implement Benson.parseIntent() for real

`benson-core/src/intent.ts` currently has a stub. It needs to:

- Detect if the message is ambiguous → return `CLARIFY` with clarifying questions
- Extract intent, goals, and constraints from clear messages → return `TASK` with a `TaskSpec`

This doesn't need an LLM call — a good rule-based parser + a simple LLM call for intent extraction both work. Since Miranda is already wired in, use a lightweight LLM call here.

### 1.4 — Implement ShellRunner.execute()

`workbench-core/src/runner.ts` has `ShellRunner.execute()` throwing a "not yet migrated" error. This is the tool execution layer. Implement it using Node's `child_process.spawn` with proper:

- stdout/stderr capture
- timeout enforcement
- exit code handling
- working directory support

---

## Phase 2 — Subagent Architecture

**Goal:** Maestro can spawn subagents for parallel or delegated work.

This is the "each department head has employees" part. Right now there's no subagent concept.

### 2.1 — Define the SubAgent interface

```typescript
// In maestro-core/src/subagent.ts
export interface SubAgent {
  id: string;
  role: RoleName;
  task: string;
  parentRunId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: OrcaMaestroResult;
}

export interface SubAgentSpawner {
  spawn(task: string, role: RoleName, parentCtx: OrcaRunCtx): Promise<SubAgent>;
  await(agentId: string): Promise<OrcaMaestroResult>;
  awaitAll(agentIds: string[]): Promise<OrcaMaestroResult[]>;
}
```

### 2.2 — Implement parallel subagent execution

For tasks where Maestro detects independent subtasks (e.g. "implement feature X and write tests for it"), it should:

1. Break the task into subtasks (use `planner_deep` role)
2. Spawn a subagent per subtask with the appropriate role
3. Await all results
4. Synthesize into a final output

### 2.3 — Add subagent events to the EventBus

Extend `OrchestrationEvent` in `types/orchestration.ts`:

```typescript
| "subagent:spawned"
| "subagent:done"
| "subagent:failed"
```

This is what lets the UI (and Doctor) answer "what subagents ran for this task?"

---

## Phase 3 — Tool Integration

**Goal:** Agents can actually do things, not just generate text.

Right now the LLM only produces text. Production means agents can write files, run commands, call APIs, read codebases.

### 3.1 — Define the Tool Registry

```typescript
// In workbench-core or orca-core
export interface Tool {
  name: string;
  description: string;  // shown to the LLM
  schema: JSONSchema;   // input schema
  execute(input: unknown, ctx: OrcaRunCtx): Promise<ToolResult>;
}
```

### 3.2 — Implement core tools first

Start with the five tools that unlock 90% of use cases:

- **read_file** — read a file from the workspace
- **write_file** — write/create a file
- **run_command** — execute a shell command (use ShellRunner)
- **list_directory** — list files in a directory
- **search_files** — grep/search within the workspace

### 3.3 — Wire tools into Maestro's LLM calls

Miranda already supports tool use via its pipeline. Pass the tool definitions into the LLM calls and handle `tool_use` responses — running the tool and feeding results back as `tool_result` in the conversation.

### 3.4 — Add the adapter pattern for tool extensions

The existing adapter pattern in `orca-core/src/adapters/` is the right place. A `ToolAdapter` registers tools with the runtime. Third-party extensions implement this to add new tools without touching core.

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

**Goal:** Orca remembers what it did and can continue work across sessions.

### 5.1 — Run store / job database

Miranda has a `runStore` in `miranda-core/src/metrics/runStore.ts`. Promote this concept to the full Orca level. Every run gets persisted with:

- Task spec
- Role used
- Subagents spawned
- Tool calls made
- Files changed
- Final verdict + output
- Cost + tokens

Use SQLite (via `better-sqlite3`) — it's zero-infrastructure and production-appropriate for a desktop app.

### 5.2 — Workspace context

Maestro needs to know about the workspace between tasks. Add a `WorkspaceContext` that tracks:

- Current working directory
- Recently modified files
- Active git branch + last commit
- Open tasks / in-progress work

### 5.3 — Conversation history for multi-turn tasks

Benson currently handles one message at a time. For production, it needs to maintain conversation history so the user can say "actually, make that endpoint return JSON instead" and Maestro understands what "that endpoint" refers to.

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
| Week 1–2 | **Phase 1** entirely. Get real output flowing end-to-end. Foundation everything else builds on. |
| Week 3 | **Phase 3.1–3.3** (core tools). File read/write and command execution make real tasks completable. |
| Week 4 | **Phase 2.1–2.2** (basic subagents). Single-level subagent spawning unlocks a huge class of tasks. |
| Week 5–6 | **Phase 5.1–5.3** (persistence). Without this, every session starts from scratch. |
| Week 7–8 | **Phase 6** (real desktop UI). Something you can hand to a non-developer. |
| Ongoing | **Phase 4** (Pappy QC) and **Phase 7** (extension system) in parallel with the above. |

---

## Critical Architectural Decisions to Make Now

Before going deep on implementation, these decisions affect everything:

### 1. Synchronous vs streaming output
Miranda's pipeline returns completed text. For good UX, you want streaming — the user sees output appearing as it's generated. This requires changes to `LLMAdapter`, `OrcaLLMService`, and the IPC bridge. **Decide before the UI layer is built.**

### 2. One model per role vs model pools
The current `RoleSelector` picks a single role. Miranda already supports model fallback ladders per stage. Decide whether roles map 1:1 to models or whether each role can have a primary/fallback pool.

### 3. Tool execution sandboxing
When Maestro runs shell commands, you need a security model. Options:
- Sandboxed Docker container
- User-approved tool calls
- Allowlist of safe commands

**Decide before shipping to real users.**

### 4. Multi-workspace support
Can a single Orca instance manage multiple codebases simultaneously? The current `workspaceRoot` in `Context` is a single path. If yes, this needs to be a first-class concept in the run context.
