# Orca — Architecture Reference

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
| `@clawde/miranda-core` | `packages/miranda-core` | 6-gate compliance layer (budget, model/tool allowlists, arg validation) |
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
| `before_llm_call` | Before each LLM invocation | Budget, model allowlist |
| `after_llm_call` | After each LLM response | Output shape validation |
| `before_tool_run` | Before each tool execution | **Tool allowlist**, null args, required fields, types |
| `after_tool_run` | After each tool execution | Non-empty receipt |
| `before_qc` | Before Pappy evaluation | Non-empty output |
| `after_qc` | After Pappy verdict | Recognized verdict (PASS/WARN/FAIL) |

## Configuration file

`orca-settings.json` (stored in Electron `userData` for the desktop app, or the project root for the
CLI runner):

```
OrcaSettings {
  providers[]    — LLM API sources (type, baseUrl, encrypted apiKey)
  roles{}        — Maps role names to providers + models + optional toolsAllowed
  budgetUsd      — USD spend cap per request (Miranda enforces)
  maxRepairPasses— Repair loop iteration limit (Pappy FAIL → Maestro retry)
  verbose        — Write LLM call log to miranda-runs.jsonl
  workspaceRoot  — Root directory for tool execution
  mcpServers[]   — MCP server definitions (see §Tools & MCP above)
}
```
