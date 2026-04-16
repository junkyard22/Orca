# Orca — Multi-Role AI Agent Runtime

Orca is a TypeScript/Node.js monorepo for orchestrating multiple AI roles to solve coding tasks. A **brain** role decomposes the request, specialist roles execute it (coder, reviewer, debugger, etc.), and a QC layer validates the output before it reaches you.

## Architecture

```
User
 └── Benson (intent parser + conversation)
       └── Orca Runtime (orchestration + repair loop)
             ├── Maestro (role router + subagent pool)
             │     ├── brain          → decomposes + routes
             │     ├── strong_model   → full implementation
             │     ├── cheap_model    → quick edits
             │     ├── reviewer       → critique + suggestions
             │     ├── narrator       → writing + docs
             │     ├── planner_deep   → structured planning
             │     ├── debugger       → root cause analysis
             │     ├── reader         → document ingestion
             │     └── vision         → image understanding
             ├── Pappy (QC — PASS/WARN/FAIL verdicts)
             └── Miranda (LLM compliance + repair loop)
```

## Quick Start

### Desktop App

```bash
cd apps/desktop
pnpm install
pnpm dev
```

Opens an Electron window. Go to **Settings** to configure LLM providers and map models to roles.

### CLI Runner

```bash
cd apps/runner
cp .env.example .env          # add your OPENROUTER_API_KEY
pnpm dev "Create a README for my project"
```

Or pipe a prompt:

```bash
echo "Refactor this function to use async/await" | pnpm dev
```

## Configuration

### API Keys

Copy `apps/runner/.env.example` to `apps/runner/.env`:

```env
LLM_PROVIDER=openrouter        # or: ollama
OPENROUTER_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4o-mini   # default model for all roles
WORKSPACE_ROOT=/path/to/project
```

Role-to-model mappings live in `orca-settings.json` at the repo root. Edit this to assign different models to each role.

### Ollama (local)

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

## Workspace Structure

```
apps/
  runner/     CLI agent runner (stdin/stdout)
  desktop/    Electron desktop app

packages/
  orca-core       Runtime wiring, event bus, persistence (SQLite)
  maestro-core    Role routing, task classification, subagent pool
  benson-core     Intent parsing, conversation history
  pappy-core      QC verdicts (PASS/WARN/FAIL), repair task generation
  miranda-core    LLM pipeline (PLAN→ANSWER→CRITIQUE→REWRITE)
  workbench-core  Tool execution (ShellRunner, ToolRegistry)
  dewey-core      User context and pre-flight plan review

  ext-github      GitHub tools: list PRs, get PR diff, list issues
  ext-docs        Document tools: read .md/.txt/.html/.csv/.log
  ext-web         Web tools: fetch URL, DuckDuckGo search
```

## Building

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Build and package desktop app (Windows .exe)
cd apps/desktop && pnpm dist
```

## Tools Available to Agents

**Core tools** (always loaded):

| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the workspace |
| `write_file` | Write or create a file |
| `run_command` | Execute a shell command |
| `list_directory` | List files in a directory |
| `search_files` | Recursive file search (glob) |

**Extension tools** (loaded in runner by default):

| Tool | Extension |
|------|-----------|
| `github_list_prs` | ext-github |
| `github_get_pr` | ext-github |
| `github_list_issues` | ext-github |
| `docs_read` | ext-docs |
| `docs_list` | ext-docs |
| `web_fetch` | ext-web |
| `web_search` | ext-web |

## Writing a Custom Extension

```typescript
// packages/ext-mycustom/src/index.ts
import type { OrcaExtension, ExtTool } from "@clawde/orca-core";

const myTool: ExtTool = {
  name: "my_tool",
  description: "Does something useful for the agent",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input value" },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    return { ok: true, output: `processed: ${args["input"]}` };
  },
};

export const myExtension: OrcaExtension = {
  id: "@clawde/ext-mycustom",
  name: "My Custom Extension",
  version: "0.1.0",
  tools: [myTool],
};
```

Then register it in `apps/runner/src/index.ts`:

```typescript
import { myExtension } from "@clawde/ext-mycustom";
// ...
const extRegistry = await createExtensionRegistry([
  githubExtension, docsExtension, webExtension,
  myExtension,
]);
```

## Training Data Export

Export run history for fine-tuning:

```bash
pnpm dev export-training-data \
  --verdict PASS \
  --output training_data.jsonl \
  --task-type strong_model \
  --limit 500
```

## License

Apache 2.0
