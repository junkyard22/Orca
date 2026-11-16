# Orca — Architecture Reference

> **Architectural invariants** — the permanent constraints that govern every component's authority — are defined in [docs/ORCA_UNIVERSAL_TRUTHS.md](docs/ORCA_UNIVERSAL_TRUTHS.md). That file sits above this one. When the two conflict, the Universal Truths win.
>
> **Whole-program contract** — component relationships, authority boundaries, runtime order, and change-control rules — are defined in [docs/ORCA_SYSTEM_CONTRACT.md](docs/ORCA_SYSTEM_CONTRACT.md). This file describes the pipeline structure; the System Contract describes the authority rules that govern it.
>
> **Development-time contract check** — a fast checklist and automation guide for verifying that proposed changes respect authority boundaries — is defined in [docs/ORCA_CONTRACT_CHECK.md](docs/ORCA_CONTRACT_CHECK.md). Run before coding tasks that touch orchestration, LLM paths, gates, QC, or role contracts.

## Pipeline

```
User input
  └── Benson          (packages/benson-core)    intent parsing, conversation management
        └── Orca Runtime  (packages/orca-core)  task lifecycle, repair loop, event bus
              ├── Maestro   (packages/maestro-core)  role routing + agent loop
              │     ├── brain          → decomposes + routes
              │     ├── strong_model   → complex coding, multi-file, architecture
              │     ├── cheap_model    → simple edits, small fixes
              │     ├── reviewer       → code review, critique
              │     ├── narrator       → writing, docs, explanations
              │     ├── utility        → linting, conversion, cleanup
              │     ├── planner_deep   → structured planning (optional, fallback: brain)
              │     ├── debugger       → root cause analysis (optional, fallback: strong_model)
              │     ├── reader         → document ingestion (optional, fallback: narrator)
              │     └── vision         → image understanding (optional, fallback: brain)
              ├── Pappy     (packages/pappy-core)     QC gate — PASS / WARN / FAIL verdicts
              └── Miranda   (packages/miranda-core)   compliance + 6-checkpoint validation
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@clawde/benson-core` | `packages/benson-core` | Intent parsing, conversation, response presentation |
| `@clawde/orca-core` | `packages/orca-core` | Runtime, task lifecycle, event bus, tool service interface |
| `@clawde/maestro-core` | `packages/maestro-core` | Role selection, agent loop, model fallback pool |
| `@clawde/pappy-core` | `packages/pappy-core` | QC evaluation — structured PASS/WARN/FAIL verdicts |
| `@clawde/miranda-core` | `packages/miranda-core` | Compliance gate layer (model/tool allowlists, arg validation, QC diagnostics) |
| `@clawde/dewey-core` | `packages/dewey-core` | Context store, plan review |
| `@clawde/tool-bootstrap` | `packages/tool-bootstrap` | Unified tool loader — core + static ext + MCP |
| `@clawde/mcp-client` | `packages/mcp-client` | MCP stdio client, tool discovery, arg coercion |
| `@yakstacks/workbench-core` | `packages/workbench-core` | Core tool registry and built-in tools |
| `@clawde/ext-github` | `packages/ext-github` | Static GitHub extension |
| `@clawde/ext-docs` | `packages/ext-docs` | Static docs extension |
| `@clawde/ext-web` | `packages/ext-web` | Static web extension |

## Apps

| App | Path | Purpose |
|-----|------|---------|
| Desktop | `apps/desktop` | Electron GUI — settings UI, chat view, session history |
| Runner | `apps/runner` | CLI entry point and pipeline tracer |

## Cargo context intake

Cargo is the desktop app's persistent resource-intake layer. The composer accepts
`/repo`, `/file`, `/task`, `/connect`, `/context`, and `/status`, plus line-oriented
`@repo`, `@file`, `@task`, and `@connector` references. The **+** menu is the graphical
equivalent and additionally exposes folders, URLs, and previous runs.

Ownership follows the existing pod boundaries:

- **Benson** parses conversation syntax and formats command responses.
- **Dewey** owns and persists the typed `ContextManifest`, then turns it into a compact
  pre-flight brief. The manifest stores resource locators and labels, never raw file or
  connector contents.
- **Orca Runtime** composes each task's resource permissions with the host Miranda gate.
- **Miranda** gates file reads, file writes, shell execution, and connector reads/writes
  before a resource tool runs.
- **Desktop** resolves graphical selections and derives connector availability from the
  tools loaded from `orca-settings.json`. Settings remain the source of truth for the
  workspace and configured connectors; attaching a connector does not install or
  configure a backend.

The manifest is session-independent and stored with Dewey's existing user context in
`~/.orca/userContext.json`. Workers receive Dewey's compact locator brief. Raw resource
contents are loaded only by an explicitly permitted tool call when a task needs them.

When **Resolve Cargo resources** is enabled in Settings, the desktop performs a bounded
pre-flight resolution for attached URLs and previous runs. URLs use the registered
`web_fetch` tool; previous runs use a virtual history-read operation. Both pass through a
composed Miranda resource gate before reading. A Settings-selected Reader, Narrator, or
Brain model converts the bounded source data into compact summaries in one provider call;
only those summaries enter Dewey's brief and raw contents are not persisted. Attached
connectors add their currently loaded tool capabilities to the brief, so MCP and static
extension backends remain provider-neutral and Settings-driven.

## Narrator progress

The desktop chat includes a lightweight **Narrator** above the technical pipeline trace.
It translates semantic runtime milestones into short updates such as planning, work step
completed, checking, and finalizing. Benson owns the fixed, user-facing language; the
desktop only maps typed `OrcaEvent` metadata to those milestones and counts completed
steps.

Standard narration is deterministic and does not make additional model calls. It never receives
or renders prompt text, model output, tool arguments, paths, error strings, or Miranda
diagnostics. Detailed component events remain available behind the existing pipeline
Details control, while general Narrator updates remain visible when technical pipeline
display is disabled.

Settings can optionally enable a personalized Narrator voice. Orca then asks the explicitly
configured Narrator role for a complete milestone lexicon once per initialization. That
request contains canonical milestone phrases only—never the active task, tool output, or
errors. The result is schema-checked, length-capped, stripped of internal component terms,
and falls back per phrase to Benson's deterministic copy.

## Tools & MCP

### Tool loading stack

`buildToolBootstrap()` (`packages/tool-bootstrap/src/index.ts`) assembles all tools in three layers:

1. **Core workbench tools** — `read_file`, `write_file`, `run_command`, `list_directory`, `search_files`
2. **Static extensions** — `@clawde/ext-github`, `@clawde/ext-docs`, `@clawde/ext-web`
3. **MCP servers** — any `McpServerConfig[]` entries from `orca-settings.json → mcpServers[]`

### MCP server configuration

Servers are declared in `orca-settings.json` under `mcpServers[]` (type: `McpServerConfig`):

```jsonc
{
  "mcpServers": [
    {
      "id":        "desktop-commander",          // stable ID; used as tool-name prefix
      "name":      "Desktop Commander",
      "transport": "stdio",
      "command":   "npx",
      "args":      ["-y", "@wonderwhy-er/desktop-commander"],
      "enabled":   true
    },
    {
      "id":        "github-mcp",
      "name":      "GitHub MCP",
      "transport": "stdio",
      "command":   "docker",
      "args":      ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
                    "ghcr.io/github/github-mcp-server"],
      "env":       { "GITHUB_PERSONAL_ACCESS_TOKEN": "<encrypted-on-disk>" },
      "enabled":   true
    }
  ]
}
```
## Agent Loop — Single Source of Truth

The agent execution loop lives in `packages/agent-loop-core`.

**Rules:**
- DO NOT copy loop logic into app-level adapters
- DO NOT fix loop behavior in `apps/runner` or `apps/desktop` directly  
- Any change to `runAgentLoop`, loop detection, or tool execution behavior
  must go in `packages/agent-loop-core/src/loop.ts`
- Both adapters (`maestroAdapter.ts` and `ReactAgentAdapter.ts`) stay as
  thin wrappers that delegate to the shared loop
- `apps/desktop/orca-tracer.ts` is intentionally exempt — see its header comment

**Current state:** Desktop adapter retains inline loop as primary path pending
full unification. See `packages/agent-loop-core/README.md` for roadmap.

**Setup note — Desktop Commander**: run `npx @wonderwhy-er/desktop-commander setup` once before enabling.
**Setup note — GitHub MCP**: requires Docker installed and running; PAT stored encrypted via `safeStorage`.

### Registered MCP servers

| Server ID | Package/Image | Transport | Tool prefix | Purpose |
|-----------|--------------|-----------|-------------|---------|
| `desktop-commander` | `@wonderwhy-er/desktop-commander` | stdio (`npx`) | `desktop-commander_` | Local file read/write, terminal execution, codebase search |
| `github-mcp` | `ghcr.io/github/github-mcp-server` | stdio (Docker) | `github-mcp_` | Clone, push, PRs, issues, repo file access |

### Tool namespacing

By default (`namespaceTools: true`) each MCP server's tools are prefixed with `${id}_` to avoid
collisions.  Example: Desktop Commander's `execute_command` → `desktop-commander_execute_command`.

### Role access — capability-scoped by default

Each role's tools are resolved from **named capability groups**
(`packages/maestro-core/src/toolCapabilities.ts`) rather than every registered tool being visible to
every role. Groups: `filesystem-read`, `filesystem-write`, `shell`, `github-read`, `github-write`,
`web`, `documentation`, `document-editing` (reserved — no tools classify into it today).

`classifyToolCapability(toolName)` matches known static tools (core + ext-github/ext-docs/ext-web) by
exact name, and namespaced MCP tools by a verb heuristic on the name after the `${serverId}_` prefix —
destructive/write verbs (`create|write|edit|delete|merge|push|kill|…`) are checked before execution
verbs (`execute|run|start|…`), which are checked before read verbs (`get|list|read|search|…`), so an
ambiguous name resolves to the more privileged group, never a guessed "safe" one. A name matching no
verb at all is **unclassified** and excluded from every role's resolved set — there is no
"allow by default" fallback. Classification is by what a tool *does*, not which server it came from:
a role with `filesystem-read` gets both the core `read_file` tool and any MCP tool that classifies as
a filesystem read (e.g. `desktop-commander_read_file`) — semantic parity across sources, not
per-server allow/deny.

`DEFAULT_ROLE_CAPABILITIES` gives each role a baseline (e.g. `strong_model`/`cheap_model`/`utility`/
`debugger` → filesystem-read+write+shell; `reviewer`/`planner_deep`/`vision` → filesystem-read only;
`narrator`/`reader` → filesystem-read+documentation, **not** filesystem-write; `brain` →
filesystem-read only — Brain's internal *routing* LLM call (direct-vs-decompose) never sees tools,
but `pickCoreRole()`/`selectRole()` can also select `brain` as the direct *worker* role for
investigative/status tasks, in which case it runs through the normal tool-bearing agent loop like any
other role, and its own prompt text assumes read access). Override a role's baseline in
`orca-settings.json → roles.<role>`:

```jsonc
"narrator": {
  "providerId": "...",
  "model": "...",
  "toolCapabilities": ["filesystem-read", "filesystem-write", "documentation"]
}
```

**Task-aware composition** narrows or narrowly expands that baseline per request, driven only by the
existing structured `task.permissions` flags — never by inferring intent from prompt wording:

- `permissions.fileWrite === true` may add `filesystem-write`; `permissions.shellExec === true` may
  add `shell`. These are the *only* two additions ever made.
- `permissions.fileWrite === false && permissions.shellExec === false` (the same signal already used
  to gate subagent decomposition) removes `filesystem-write`/`shell`/`github-write`, regardless of
  the role's baseline.
- Absent `task.permissions`, nothing changes — the role's baseline is used as-is (safe fallback).

An explicit `toolsAllowed` list (same field as before, still supported) is a **hard upper bound**
resolved capability groups and task-aware additions can never exceed:

```jsonc
"strong_model": {
  "providerId": "...",
  "model": "...",
  "toolsAllowed": ["read_file", "write_file", "desktop-commander_execute_command"]
}
```

This resolution happens in `apps/runner/src/adapters/maestroAdapter.ts`'s `resolveRoleToolNames()`,
called once per role invocation from `runSingleAgent()` — it wraps `ctx.tools` with
`createFilteredToolService()` (`packages/orca-core/src/toolFilter.ts`, shared with the pre-existing
task-level `taskSpec.permissions.toolsAllowed` filter in `runtime.ts`) before the tool catalog is
ever formatted into the prompt, so a filtered-out tool's schema is never serialized, not merely
blocked at execution time. The Electron desktop app has its own, separately-implemented equivalent
(`apps/desktop/src/main.ts`'s `selectToolsForRole`) — this section describes the runner/CLI path.

### Role prompts describe behavior, not a static tool list

Role prompts (`packages/maestro-core/src/prompts/rolePrompts.ts`) contain behavioral guidance —
what the role does, its output contract, what it does NOT do. They do not assert which specific
tools exist: `getRolePrompt(role, availableToolNames)` takes the same resolved allowlist computed by
`resolveRoleToolNames()` above and adjusts its tool-usage reminder accordingly — omitted entirely
when the list is empty (a model must never be told to use tools it doesn't have), a generic,
tool-name-agnostic reminder when tools exist (the actual catalog — names, schemas, call syntax — is
already appended separately by the agent loop's `tools.formatForPrompt()`, so the role prompt doesn't
duplicate it), and only a fixed legacy reminder (naming the 5 core tools unconditionally) for the
small number of call sites that don't yet pass a resolved list (`apps/desktop`'s adapters, which
build their own separately-dynamic tool-availability text). Actual tool availability for any given
invocation is always the post-filter tool service constructed above — no role prompt or static list
should be treated as authoritative about what's callable.

### Miranda tool filtering

Miranda's `before_tool_run` gate checks every tool call against `allowedTools` (if set at gate
creation) **and** the runtime wraps `OrcaToolService` to enforce `taskSpec.permissions.toolsAllowed`.
Both checks apply uniformly to MCP tools — there is no special-casing for MCP tool names.

The filter works on the **namespaced** tool name (e.g. `desktop-commander_execute_command`,
`github-mcp_create_pull_request`).  See `packages/orca-core/src/toolFilter.ts` for the shared
filtering implementation, `packages/orca-core/src/runtime.ts` for the task-level wrapping, and
`packages/orca-core/src/runtime.stress.test.ts` ("tool permission filtering" suite) /
`packages/orca-core/src/toolFilter.test.ts` for tests.

### Context-budget telemetry and guardrails

Every tool-bearing role invocation emits a `context.budget` trace event (via the existing
`ctx.recordTrace`, persisted through `analysisWriter.writeTrace()` — no new storage) recording: role,
model, tools-exposed count, tool-schema character length, system-prompt and task-prompt character
lengths, conversation-history message count and character length, and an approximate token count
(chars ÷ 4, explicitly labeled `estimated: true` — never conflated with provider-reported usage).
Where a provider *does* report real usage, that's captured separately by the existing
`ORCA_PROFILE`-gated `llm_call` event in `packages/miranda-core/src/llm/openaiCompat.ts`.

Miranda's `beforeLLMCall` gate (`packages/miranda-core/src/gate/mirandaGate.ts`) accepts the same
size fields on `LLMCallGateContext` and checks them against configurable, WARN-only thresholds
(`MirandaGateConfig.contextBudget`, conservative defaults — never block a call, only set
`verdict: "WARN"` with a `GateResult.warnings` list). This flags an oversized tool catalog or history
without ever interrupting legitimate large-context work.

### Pipeline handoffs

AHP packets (`AHPPacket` in `packages/miranda-core/src/ahp/types.ts`, threaded through Maestro as
`ahpPacket`/`ctx.ahpRootPacket`) already carry the structured `objective` / `inputs` / `constraints` /
`expectedOutput` / `trace` a specialist or repair pass needs, and `repairLoop.ts` already prefers a
packet's `repairPrompt` over replaying the full prior conversation. No new handoff abstraction was
added for this milestone — role-scoped tooling and context telemetry compose with AHP as-is.

### Secrets storage

MCP server `env` values (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`) are encrypted at rest using the same
`encryptApiKey` / `decryptApiKey` helpers as provider API keys
(`apps/desktop/src/settings.ts`):

- **Primary**: Electron `safeStorage` → OS keychain (`enc:` prefix)
- **Fallback**: base64 encoding (`b64:` prefix) when OS keychain is unavailable
- **Legacy**: plain text values are auto-upgraded on the next save

## Workspace authority, shell execution and execution evidence

These rules were added by the November 2026 audit follow-up (stages 1–2.1). They do not move any responsibility between components: Miranda authorizes, tools execute, the runtime records, Pappy judges.

### Workspace authority (Miranda)

- A task's workspace root is set only by a **structured** choice: the host's configured root (Settings on the desktop; `WORKSPACE_ROOT` or the working directory for the CLI) or an explicit `context.workspaceRoot`. A path that appears in a message, an intent, a goal or a tool call's arguments never establishes or replaces it.
- `createWorkspaceAuthorityGate()` (`packages/miranda-core/src/gate/mirandaGate.ts`) is composed by the runtime in front of the host and task gates. A file-read, file-write or shell tool — and any call that names an absolute local path — is refused with `code: "workspace_required"` unless the root is given, exists, is a folder and is not a filesystem root (`assessWorkspaceRoot`). Nothing is substituted for an unusable root: not `process.cwd()`, not a parent directory.
- When a worker was refused this way the runtime skips the repair loop (only the user can establish a workspace) and returns a fixed explanation as `followUpQuestion`.
- Tasks that touch no local files need no workspace.

### Structured path validation (Miranda)

- `before_tool_run` checks every argument whose key names a local location (`path`, `paths[]`, `files[].path`, `cwd`, `source`, `destination`…, at any depth) against the workspace. The check follows the filesystem: the nearest existing ancestor is resolved with links followed, so a symlinked directory or file that leads out of the workspace is refused.
- Argument types are checked against the tool schema with a JSON-schema-aware test (`array` → native array, `object` → plain object, `integer`, finite `number`). A JSON string standing in for an array or object is rejected. The schema contract carries top-level types only; element and member shapes are not validated, but path members are still boundary-checked wherever they are nested.
- This is validation of **arguments**. For Orca's own file tools the tool re-resolves the path itself (`host_enforced_paths`). For an MCP file tool it is all there is (`argument_validation`): the MCP server is a separate host process and is trusted to use only the paths it was given.

### Shell execution is not sandboxed

Orca has no operating-system sandbox. `run_command` starts a host shell as the current user (`spawn(command, { shell: true, cwd })`); MCP process tools run inside MCP servers that are themselves unconfined host processes. The workspace is the directory a command starts in. It is **not** a boundary for the process. Four different things must not be confused:

| Mechanism | What it is | What it is not |
|---|---|---|
| Working directory | Where the command starts (always inside the workspace) | A limit on what the command can reach |
| Miranda's checks | Task permission (`shellExec`), workspace authority, validation of a `cwd` argument | An inspection of what a command string will do |
| Command policy / user approval | Decides whether a command may run **without asking** | Confinement of the process once it runs |
| OS sandbox | — (none exists in Orca) | — |

`packages/workbench-core/src/tools/sandbox.ts` is the command policy (the file name is historical):

- Blocked patterns never run.
- A command runs unattended only as a **confined read**: it contains nothing a shell interprets (letters, digits, `_ . / -` and single spaces only — any quote, expansion, substitution, glob, redirection, chain or line break disqualifies it), its first word is a listed single-purpose reader (`cat`, `head`, `tail`, `wc`, `ls`, `stat`, `file`, `echo`, `pwd`, …) with only the options listed for it, and every path operand resolves inside the workspace with links followed. Tools that can execute, write, or load configuration from the repository (`git`, `find`, `grep`, `npm`, `less`, …) are not on that list.
- A host may configure `extraAllowedCommands`; that is the host's explicit standing authorization and is recorded as `host_policy`.
- Everything else needs the user's approval, and the request says what approval grants: *not sandboxed — the command has the user's access to the whole computer*. With no approval handler the command does not run.
- MCP shell/process tools: the desktop asks for approval on every call with the same warning (`apps/desktop/src/toolAuthorization.ts`); the shared loop used by the CLI refuses them when no approval handler exists.

Every executed tool event carries `raw._execAuthority` (`filesystemScope`, `confinement`, and for `run_command` how it was authorized: `confined_read`, `host_policy` or `user_approved`). A shell execution is always `filesystemScope: "host"`, `confinement: "none"`. The host record counts such executions and says that what they did outside the watched workspace files is not recorded. **A confined read is an argument validation, not a sandbox, and must not be described as one.**

### Filesystem evidence

- The runtime's workspace evidence collector (`packages/orca-core/src/workspaceEvidence.ts`) baselines the workspace at task start and gives Pappy the task-level diff and the test runs it observed.
- `observeExecution` wraps one tool execution between two snapshots (content hashes; unchanged files are trusted on size and mtime outside a 2 s window). Both agent loops wrap every execution that may modify files — after Miranda allowed it — and record the result on that execution's event as `raw._fsEvidence`:
  - `confirmed` — the listed paths differ on disk before and after;
  - `no_change` — nothing changed **within the observed scope**;
  - `unverified` — the workspace could not be read completely, or two observed executions overlapped.
- `observedScope` on every result states what was watched: the files Git tracks or would track (or, without Git, everything outside dependency, build and version-control directories), plus any path named in the tool's arguments, which is fingerprinted directly. Git-ignored files, dependency and build directories, and everything outside the workspace are **not** watched. `no_change` is therefore never "the tool changed nothing on this computer".
- File changes are credited to a worker only from this evidence where it exists. A tool's `ok`, its name, its output, a printed `<!-- Files changed -->` marker and the model's account are not evidence. A failed tool's confirmed changes are recorded but not credited.
- Keys beginning with `_` on a tool event's `raw` are the host's observations (`_fsEvidence`, `_execAuthority`, `_outputForProof`, `_exitCodeForProof`, `_contentForDiff`, `_filesChangedForDiff`). They are removed from the model's own arguments before the record is built (`toolInputForRecord`), so a model cannot write them.
- Cost, measured on temporary Git repositories on the audit host (`scripts/bench/fs-evidence-bench.mjs`): about 10 ms per observed execution at 300 files, 44 ms at 5,000 files, 312 ms at 40,000 files (160 MB).

### Limits of MCP verification

- An MCP tool's effects are verified only inside the observed scope above. A change it makes outside the workspace, or to an ignored path it was not given as an argument, is neither credited nor detected.
- A change another process makes in the workspace while a tool runs is attributed to that tool; overlapping observed executions are `unverified`.
- An MCP server runs with whatever access its own process has. Orca validates the arguments it sends; it does not confine the server.

### Pappy and recorded evidence

Pappy remains the quality verifier and is deterministic. It judges against the runtime's task-level workspace evidence and receives each tool event with the host's `_fsEvidence` and `_execAuthority`. `filesChanged` in its input is derived from confirmed evidence where the host observed the execution. Recorded evidence informs Pappy; it never overrides a Pappy verdict, and nothing recorded on an event can turn a FAIL into a PASS.

## Miranda Gate — 6 checkpoints

| Gate | When | Checks |
|------|------|--------|
| `before_llm_call` | Before each live LLM invocation | Model allowlist; budget fields are neutral unless live cost accounting is wired |
| `after_llm_call` | After each LLM response | Output shape validation |
| `before_tool_run` | Before each tool execution | **Workspace authority** (filesystem tools need a usable, explicitly established workspace), **tool allowlist**, task file/shell/connector permissions, link-aware workspace boundary for path arguments, protected paths, null args, required fields, schema types (arrays and objects must be native) |
| `after_tool_run` | After each tool execution | Non-empty receipt |
| `before_qc` | Before Pappy evaluation | Non-empty output |
| `after_qc` | After Pappy verdict | Diagnostic checkpointing only; Pappy remains the quality verifier |

## Miranda Architecture Lock

Miranda is a compliance gate, not a response pipeline.

Rules:

- Miranda does not plan, answer, critique, rewrite, synthesize, or judge output quality.
- The old Miranda multi-stage PLAN -> ANSWER -> CRITIQUE -> REWRITE pipeline is legacy. Do not extend it for live Orca behavior.
- Live LLM calls must pass through `beforeLLMCall`.
- Tool execution must pass through `beforeToolRun` and `afterToolRun`.
- Pappy QC must pass through `afterQC` for diagnostics and checkpointing.
- Pappy remains Orca's quality verifier. Miranda must not downgrade Pappy `FAIL` verdicts, skip repair loops, or change final QC behavior unless a future explicit design doc authorizes that change.
- `gate_blocked` is an internal controlled-stop reason. Do not expose it as a user-facing failure phrase.
- Neutral `budgetUsed: 0` / `budgetLimit: Infinity` placeholders are not real budget enforcement. Treat them as neutral metadata until live cost accounting is wired into the gate context.

Gate verdict meanings:

| Verdict | Meaning |
|---------|---------|
| `PASS` | Continue |
| `WARN` | Continue with diagnostic warning |
| `BLOCK` | Stop safely |
| `CONFIRM_REQUIRED` | Pause until user approval; reserved until wired |

### Where Miranda is wired today

LLM call stages:

- `agent_loop_main_stream`
- `agent_loop_rescue_stream`
- `maestro_no_tools_stream`
- `maestro_brain_route_complete`
- `maestro_synthesis_complete`

Tool gates:

- `beforeToolRun`
- `afterToolRun`

QC diagnostics:

- `afterQC`
- Trace stage: `miranda.after_qc`

## Configuration file

`orca-settings.json` (stored in Electron `userData` for the desktop app, or the project root for the
CLI runner):

```
OrcaSettings {
  providers[]    — LLM API sources (type, baseUrl, encrypted apiKey)
  roles{}        — Maps role names to providers + models + optional toolsAllowed
  budgetUsd      — USD spend cap per request (runtime/repair-loop guard; not Miranda gate enforcement until live cost accounting is wired)
  maxRepairPasses— Repair loop iteration limit (Pappy FAIL → Maestro retry)
  verbose        — Write LLM call log to miranda-runs.jsonl
  workspaceRoot  — Root directory for tool execution
  mcpServers[]   — MCP server definitions (see §Tools & MCP above)
}
```
