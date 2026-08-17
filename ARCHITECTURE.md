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

### Role access

MCP tools are visible to all roles by default (same as core tools).  `strong_model` and `cheap_model`
have no `toolsAllowed` restriction in the default config, so Desktop Commander and GitHub MCP tools
are available to both.

To restrict a role, set `toolsAllowed` in `orca-settings.json → roles.<role>`:

```jsonc
"strong_model": {
  "providerId": "...",
  "model": "...",
  "toolsAllowed": ["read_file", "write_file", "desktop-commander_execute_command"]
}
```

### Miranda tool filtering

Miranda's `before_tool_run` gate checks every tool call against `allowedTools` (if set at gate
creation) **and** the runtime wraps `OrcaToolService` to enforce `taskSpec.permissions.toolsAllowed`.
Both checks apply uniformly to MCP tools — there is no special-casing for MCP tool names.

The filter works on the **namespaced** tool name (e.g. `desktop-commander_execute_command`,
`github-mcp_create_pull_request`).  See `packages/orca-core/src/runtime.ts` for the wrapping logic
and `packages/orca-core/src/runtime.stress.test.ts` ("tool permission filtering" suite) for tests.

### Secrets storage

MCP server `env` values (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`) are encrypted at rest using the same
`encryptApiKey` / `decryptApiKey` helpers as provider API keys
(`apps/desktop/src/settings.ts`):

- **Primary**: Electron `safeStorage` → OS keychain (`enc:` prefix)
- **Fallback**: base64 encoding (`b64:` prefix) when OS keychain is unavailable
- **Legacy**: plain text values are auto-upgraded on the next save

## Miranda Gate — 6 checkpoints

| Gate | When | Checks |
|------|------|--------|
| `before_llm_call` | Before each live LLM invocation | Model allowlist; budget fields are neutral unless live cost accounting is wired |
| `after_llm_call` | After each LLM response | Output shape validation |
| `before_tool_run` | Before each tool execution | **Tool allowlist**, task file/shell/connector permissions, workspace boundary, protected paths, null args, required fields, types |
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
