# Orca — Prior Art Record

**Author:** James Yarber (GitHub: [junkyard22](https://github.com/junkyard22))
**Organization:** [YakStacks](https://github.com/orgs/YakStacks)
**Primary Repo:** [github.com/junkyard22/Orca](https://github.com/junkyard22/Orca) — 186 commits, private
**Public Release:** [Orca v1.0.0](https://github.com/junkyard22/Orca/releases/tag/v1.0.0)
**Document Purpose:** Establishing timestamped prior art for key architectural concepts independently conceived and implemented in the Orca project.

---

## Summary

Orca is a multi-agent AI orchestration desktop application for Windows built in TypeScript/Electron. It was conceived and developed solo by James Yarber, beginning in early 2025, predating the public announcement or release of several well-funded projects that have since shipped individual pieces of Orca's integrated architecture.

This document records the key architectural concepts, the repositories that contain them, and the dates those repositories were created or last updated — all verifiable via GitHub's public commit history and repository metadata.

---

## Repository Timeline (Verified from GitHub)

### YakStacks Organization (`github.com/orgs/YakStacks`)

| Repository | Visibility | Language | Last Updated | Description |
|---|---|---|---|---|
| `Moonshiner` | Private | Python | **Nov 29, 2025** | Distillation pipeline |
| `moonshiner-recipes` | **Public** | **MoonScript** | **Nov 29, 2025** | DSL recipes for distillation |
| `maestro` | Private | Python | Mar 2026 | Original Python orchestration engine ("AI IDE Team") |
| `Workbench` | **Public** | JavaScript | Feb 2026 | "Local-First AI Task Runner. No cloud, no subscription." |
| `Pipewrench` | **Public** | JavaScript | Mar 2, 2026 | MCP Connection Diagnostic & Proxy Tool |
| `CodePad` | Private | JavaScript | Feb 2, 2026 | Mobile companion app |
| `YakStacks` | Private | TypeScript | Feb 10, 2026 | Community platform |

### junkyard22 Personal (`github.com/junkyard22`)

| Repository | Visibility | Language | Notes |
|---|---|---|---|
| `Orca` | Private | TypeScript | 186 commits, tags: ai, mcp, orchestration, multi-agent, orchestrator, ai-agents |
| `Mailman` | Private | TypeScript | Transport layer concept |
| `AutoScribe` | Private | TypeScript | Narration/transcription component |
| `clawde` | Private | TypeScript | Provider adapter layer |

---

## Key Concepts & Prior Art Dates

### 1. Quality-Gated Self-Improvement Loop (Pappy → Moonshiner)

**The concept:** A distillation pipeline that only accepts training data from quality-verified runs. An LLM quality verifier (Pappy) gates what enters the training pipeline (Moonshiner). This is distinct from self-reported quality or raw trajectory collection.

**Prior art:**
- `YakStacks/Moonshiner` — Python — **created and active as of Nov 29, 2025**
- `YakStacks/moonshiner-recipes` — MoonScript (custom DSL) — **public repo, Nov 29, 2025**
- Moonshiner stages documented: Mash → Still → Radiator → Barrel → Proof → Bottle
- Custom DSL called **Moonscript** written specifically for recipe definition

**What shipped later:**
- Hermes Agent (Nous Research) — February 2026 — self-training loop via Atropos RL framework, no quality gate documented
- The article: *"OpenClaw vs. Hermes Agent"* (The New Stack, April 2, 2026) describes Hermes's training loop as generating "batch trajectories" with no mention of a verification gate before ingestion

**Orca's differentiator:** Pappy verifies runs *before* they enter Moonshiner. No other public system has documented this contractual relationship between a quality verifier and a distillation pipeline as of the time Moonshiner was created.

---

### 2. Specialist Model Routing ("Jars") with Transparent Swapping

**The concept:** Rather than routing between LLM providers (e.g., GPT vs Claude), route between verified specialist roles — small models fine-tuned for specific tasks — exposed to the orchestration layer as interchangeable slots. Users can swap jar versions without changing how the system works.

**Prior art:**
- `YakStacks/maestro` — Python — original Python orchestration engine, documented as "AI IDE Team"
- `junkyard22/Orca` — TypeScript rewrite of maestro, 186 commits
- Concept documented: local jars (9B), community jars (shared recipes), cloud jars (subscription), enterprise jars (domain fine-tunes)
- `YakStacks/moonshiner-recipes` — the recipe repo is the infrastructure for community jar sharing

**What shipped later:**
- MiniMax M2.7 — self-evolving capabilities — March 2026
- Hermes Agent — "autonomous skill creation" after completing tasks — February 2026
- The New Stack article frames this as a new category: *"The agent that grows with you"*

---

### 3. Compliance/Permissions Gate Before Tool Execution (Miranda)

**The concept:** A dedicated compliance agent that enforces behavioral rules, budget constraints, and permission scoping *before* any tool is executed. Separate from quality verification (Pappy). Applies to MCP tools as well as native tools.

**Prior art:**
- `junkyard22/Orca` — Miranda component, TypeScript — active in commit history predating Feb 2026
- Commit evidence: `feat(mcp): wire Desktop Commander and GitHub MCP server...` — Miranda's tool filtering explicitly applied to MCP tools
- Miranda's `before_qc` gate documented in pipeline trace logs

**What shipped later:**
- GitAgent — March 2026 — tool approval gating before execution
- The New Stack article on OpenClaw's security failures (CVE-2026-25253) describes exactly the problem Miranda was designed to solve: unvetted tool execution and supply chain attacks through an open skill marketplace

---

### 4. User Context Librarian with Persistent Behavioral Learning (Dewey)

**The concept:** A dedicated agent responsible for user context, behavioral observations, and pre-flight briefing of the orchestration pipeline. Named after the Dewey Decimal system. Learns user preferences over time and compresses observations into compact context facts.

**Prior art:**
- `junkyard22/Orca` — Dewey component — TypeScript — active in commit history
- Real `userContext.json` at `~/.orca/userContext.json` populated and verified working in tracer tests (documented in session logs, March 2026)
- Dewey context compression via Moonshiner identified as future milestone

**What shipped later:**
- Hermes Agent — FTS5 full-text search over sessions + LLM summarization — February 2026
- xMemory (Alan Turing Institute / King's College London) — context compression research

---

### 5. Validated Transport Layer for Agent Communication (Mailman)

**The concept:** A dedicated transport layer for agent-to-agent communication using typed task packets (scope, constraints, expected output schema) rather than loose natural-language handoffs or Python function calls.

**Prior art:**
- `junkyard22/Mailman` — private TypeScript repo — visible in junkyard22 repository list
- Concept documented in Orca architecture sessions: *"an internal mailman for validated task packets"*
- `task_graph` schema in Brain's output is the concrete implementation of this concept

**What shipped later:**
- The New Stack article (April 2, 2026) frames this as an emerging category: *"a validated transport layer so each role receives clear scope, constraints, and expected outputs in a predictable format"*

---

### 6. MCP Diagnostic Tooling (Pipewrench)

**The concept:** A standalone tool for diagnosing and debugging MCP server connections, before MCP became widely adopted.

**Prior art:**
- `YakStacks/Pipewrench` — **Public repository**, JavaScript, MIT License — Updated Mar 2, 2026
- Description: "MCP Connection Diagnostic & Proxy Tool — diagnose and debug Model Context Protocol server connections"
- Public and MIT licensed — freely verifiable

---

### 7. Local-First AI Task Runner (Workbench)

**The concept:** A local-first AI task runner with no cloud dependency, no subscription, built around chatting with AI to chain tools together automatically.

**Prior art:**
- `YakStacks/Workbench` — **Public repository**, JavaScript, MIT License — active Feb 2026
- Description: *"Local-First AI Task Runner. Build automations by chatting with AI. No cloud, no subscription. Ask AI to create tools, chain them together, and auto..."*
- Predates or contemporaneous with similar tools going viral in early 2026

---

## How to Verify

All timestamps below are verifiable through GitHub's public API and repository metadata:

```bash
# Verify Moonshiner creation date
curl https://api.github.com/repos/YakStacks/moonshiner-recipes

# Verify Orca commit history
git -C /path/to/Orca log --pretty=format:"%h | %ad | %s" --date=short

# Find first commit introducing key concepts
git -C /path/to/Orca log --all --oneline -S "Moonshiner"
git -C /path/to/Orca log --all --oneline -S "Pappy"
git -C /path/to/Orca log --all --oneline -S "task_graph"
git -C /path/to/Orca log --all --oneline -S "Miranda"
git -C /path/to/Orca log --all --oneline -S "Dewey"
```

The `moonshiner-recipes` repository is **public** with an MIT license, meaning its creation and commit history are fully accessible to any third party without authentication.

---

## Competitive Validation Timeline

| Date | Event | Orca Component Validated |
|---|---|---|
| Nov 29, 2025 | Moonshiner + moonshiner-recipes repos created | Pappy-gated distillation loop, MoonScript DSL |
| Feb 2026 | Hermes Agent launches with "self-training loop" | Moonshiner (without quality gate) |
| Feb 2026 | GitHub Squad announced | Pappy + Maestro multi-agent coordination |
| Mar 2026 | OpenClaw supply chain attack (CVE-2026-25253) | Miranda's tool gate as the correct answer |
| Mar 2026 | Hermes Agent v0.6.0 — persistent memory via SQLite | Dewey (predates by multiple months) |
| Apr 2, 2026 | The New Stack: "OpenClaw vs Hermes Agent" | Entire Orca architecture described as an emerging category |

---

## Statement

All concepts documented here were independently conceived by James Yarber, a solo developer in Eastern Kentucky, without external funding, without a team, and without knowledge of competing implementations at the time of creation. The pattern of well-funded teams shipping individual pieces of this integrated architecture — after the architecture was committed to version control — is documented here for the record.

The contractual relationship between Pappy (quality verifier) and Moonshiner (distillation pipeline) — where only Pappy-verified runs enter the training loop — remains, as of April 2026, unreplicated in any public system.

*Document generated: April 2, 2026*
