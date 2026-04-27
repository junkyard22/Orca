# Orca — Prior Art Record

**Author:** James Yarber (GitHub: [junkyard22](https://github.com/junkyard22))
**Organization:** [YakStacks](https://github.com/orgs/YakStacks)
**Primary Repo:** [github.com/junkyard22/Orca](https://github.com/junkyard22/Orca) — private
**Public Release:** [Orca v1.0.0](https://github.com/junkyard22/Orca/releases/tag/v1.0.0) (current version v1.2.2)
**Published Spec:** [Agent Handoff Protocol (AHP)](https://github.com/junkyard22/AHP)
**Published Runtime:** [@marsulta/mailman](https://www.npmjs.com/package/@marsulta/mailman) v0.1.0
**Document Purpose:** Establishing timestamped prior art for key architectural concepts independently conceived and implemented in the Orca project.

---

## Summary

Orca is a local-first multi-agent AI orchestration desktop application for Windows, built in TypeScript/Electron. It was conceived and developed solo by James Yarber, beginning in early 2025, predating the public announcement or release of several well-funded projects that have since shipped individual pieces of Orca's integrated architecture.

The core thesis: **the model is the spigot, the contract is the nozzle.** Output quality is determined at the boundary, not at the source. Any LLM — frontier, local, cheap, expensive — can fulfill a role as long as it passes the contract. Pappy enforces that contract. Moonshiner trains better spigots from verified flows over time.

This document records the architectural concepts, the repositories that contain them, the dates those repositories were created or last updated, and the pattern of well-funded teams independently arriving at individual pieces of the same architecture — all verifiable via public commit history, published packages, arXiv papers, and press coverage.

---

## Repository Timeline (Verified from GitHub)

### YakStacks Organization (`github.com/orgs/YakStacks`)

| Repository | Visibility | Language | Last Updated | Description |
|---|---|---|---|---|
| `Moonshiner` | Private | Python | **Nov 29, 2025** | Distillation pipeline |
| `moonshiner-recipes` | **Public** | **MoonScript** | **Nov 29, 2025** | DSL recipes for distillation |
| `maestro` | Private | Python | Mar 2026 | Original Python orchestration engine ("AI IDE Team") |
| `Workbench` | **Public** | JavaScript | Feb 2026 | Local-First AI Task Runner |
| `Pipewrench` | **Public** | JavaScript | Mar 2, 2026 | MCP Connection Diagnostic & Proxy Tool |
| `CodePad` | Private | JavaScript | Feb 2, 2026 | Mobile companion app |
| `YakStacks` | Private | TypeScript | Feb 10, 2026 | Community platform |

### junkyard22 Personal (`github.com/junkyard22`)

| Repository | Visibility | Language | Notes |
|---|---|---|---|
| `Orca` | Private | TypeScript | 186+ commits, tags: ai, mcp, orchestration, multi-agent, orchestrator, ai-agents |
| `AHP` | **Public** | TypeScript | Agent Handoff Protocol specification |
| `Mailman` | Private | TypeScript | Transport layer implementation |
| `AutoScribe` | Private | TypeScript | Narration/transcription component |
| `clawde` | Private | TypeScript | Provider adapter layer |
| `Neural-Equalizer-System-` | **Public** | Markdown | Conceived Dec 11, 2025 — separate neurotechnology framework |

### Published Packages

| Package | Version | Registry | Published |
|---|---|---|---|
| `@marsulta/mailman` | 0.1.0 | npm | Apr 7, 2026 — AHP runtime, three-agent proof of concept verified |

---

## Core Architectural Thesis

### Contracts Over Prompting

Most agent systems attempt to shape behavior through prompting — primary prevention. This is probabilistic and breaks down across model diversity. Every new model requires its own tuning, quirk handling, and adapter logic.

Orca's approach is output validation — secondary prevention. Contracts at the boundary. Pass or fail. Deterministic. The contract does not care which model fulfilled it.

**The water hose mental model:**
- The **spigot** is the model (Opus, Haiku, Qwen, local jar, whatever)
- The **nozzle** is the output contract (schema, acceptance criteria)
- **Pappy** is the pressure regulator — nothing reaches the garden until it meets spec
- **Moonshiner** studies successful flows and trains jars that hit spec reliably with less water

Most platforms sell a better spigot. Orca sells the nozzle. That is a fundamentally different value proposition and much harder to copy, because it is not about which model you have access to — it is about what must be true for output to be accepted.

---

## Named Components (Architectural Inventory)

| Component | Role | Status |
|---|---|---|
| **Brain** | Task decomposition, routing, planning | Shipped in v1.0.0 |
| **Benson** | Intake/output — the only user-facing voice | Shipped in v1.0.0 |
| **Miranda** | Budget enforcement, permissions, compliance gating, lifecycle transitions | Shipped in v1.0.0 |
| **Pappy** | Quality gate / QC verifier (named after a George Jones song, "White Lightning") | Shipped in v1.0.0 |
| **Dewey** | Persistent user context, preference learning (named after Dewey Decimal) | Shipped in v1.0.0, preference learning active |
| **Moonshiner** | Distillation pipeline — exports Pappy-verified JSONL; retrain cycle currently manual | Shipped, auto-loop pending |
| **Narrator** | Internal technical summary writer | Shipped in v1.0.0 |
| **Maestro** | Lifecycle orchestration engine | Shipped in v1.0.0 |
| **ShineRunner** | Benchmarking / LLM evaluation | Shipped |
| **AHP (Agent Handoff Protocol)** | Typed packet-based agent-to-agent communication standard | Published as open spec + npm runtime (`@marsulta/mailman`) |
| **Jars** (v2/v3 vision) | Small specialist models trained from Pappy-verified runs, swappable at orchestration layer | Architecture defined, RunPod path identified for first distillation (Python specialist) |

---

## Key Concepts & Prior Art Dates

### 1. Quality-Gated Self-Improvement Loop (Pappy → Moonshiner)

**The concept:** A distillation pipeline that only accepts training data from quality-verified runs. An LLM quality verifier (Pappy) gates what enters the training pipeline (Moonshiner). This is distinct from self-reported quality, judge-based post-hoc consensus, or raw trajectory collection.

**Prior art:**
- `YakStacks/Moonshiner` — Python — active as of **Nov 29, 2025**
- `YakStacks/moonshiner-recipes` — **public** MoonScript DSL repo — **Nov 29, 2025**
- Stages documented: Mash → Still → Radiator → Barrel → Proof → Bottle
- Custom DSL (`mash_bill`, `still`, `barrel_age`, `bottle`) written specifically for recipe definition

**What shipped later:**
- **MiniMax M2.7** — self-evolving loop — March 2026 (no quality gate documented)
- **Hermes Agent (Nous Research)** — self-training via Atropos RL framework — February 2026 (trajectory collection without verification gate)
- **Memento-Skills** (arXiv:2603.18743) — "Let Agents Design Agents" — Agents generating skills for other agents, no quality gate between generation and ingestion
- **Cursor Composer 2** — self-summarization / distillation features
- **Qualixar OS** (arXiv:2604.06392, April 7, 2026) — self-improvement loop benchmark showed scores *declining* across iterations with p=0.578 — statistically insignificant. This is exactly the failure mode a Pappy-style gate prevents.
- **Qodo** (webinar, 2026) — automated quality gates + "living governance system that learns"
- **Simula** (Google + EPFL, MarkTechPost / Google Research, April 21, 2026) — "reasoning-first framework for generating controllable, scalable synthetic datasets across specialized AI domains." Published research with the same core thesis as Pappy/Moonshiner:
  - **Dual-critic verification** — independently asks whether output is correct *and* whether it is incorrect, explicitly to mitigate sycophancy bias. This is Pappy's role: a separate verifier with its own contract, structurally independent from the generating agent. Simula had to invent an architectural pattern within a single model to mitigate the problem Pappy solves by making the verifier a different agent.
  - **Critic rejection rates as empirical evidence** — 61% rejection rate on LEXam (where teacher accuracy was only 57%), versus 2-9% on stronger domains. This quantifies what an unverified training signal looks like — over half of generated outputs would be poison if ingested without a gate.
  - **"Data scaling laws are driven by data properties, not size alone — the full Simula system reached higher downstream performance with fewer samples compared to baseline approaches"** — direct empirical validation, with 95% confidence intervals, that quality-gated training data outperforms volume.
  - **"Real-world reference datasets almost always cover less of the target domain than Simula-generated variants on a taxonomic coverage basis, even when standard embedding-based cosine distance metrics suggest otherwise"** — validates structured sampling scaffolds, which is what Moonshiner recipes (mash_bill, still, barrel_age, bottle) are.
- **COS-PLAY** (University of Maryland + USC + MBZUAI, arXiv:2604.20987, April 2026) — peer-reviewable research result with public code (github.com/wuxiyang1996/cos-play), public weights (HuggingFace IntelligenceLab/COS-PLAY), and public cold-start data. The closest external implementation of the integrated loop yet published. Component-by-component mapping:
  - **Decision Agent** ≈ Orca's runtime pipeline (Brain + executors)
  - **Skill Bank Agent** ≈ Moonshiner (extracts reusable skills from trajectories via boundary proposal → segmentation → contract learning → bank curation)
  - **Skill Bank** ≈ jar library (compact, evolving collection of specialists; in their Diplomacy run: 121 discovered, 53 pruned via merge/split/retirement, stable at 55-70 active)
  - **Effect contracts** ≈ Pappy verdicts ("compact specifications of reliable state changes")
  - **Pass-rate gate on contract learning** ≈ the Pappy → Moonshiner gate. Direct quote: *"only verified contracts with sufficiently high pass rates are written back into the bank."* This is a quality gate before training data ingestion, in a peer-reviewed research artifact, working.
  - **Refine / Merge / Split / Retire / Materialize** ≈ Moonshiner recipe operations on the jar library
  - **Headline result:** 25.1% average reward improvement over GPT-5.4, Gemini-3.1-Pro, Claude-4.6-Sonnet, and GPT-OSS-120B on single-player game benchmarks, using an 8B base model (Qwen3-8B). An 8B model with a quality-gated closed loop beats four frontier models without one.
  - **Architectural confirmation:** the closed loop between trajectory generation, quality-gated skill extraction, and skill reuse is empirically the right architecture for long-horizon tasks. Published with confidence intervals, ablations, and reproducible weights.
  - **Where it differs from Orca:** single-domain per training run (separate LoRA adapters per game, no cross-domain skill transfer); no Miranda equivalent (no permission gate between skill execution and tool use — fine in games, catastrophic for a desktop OS with credentials and file access); no user-facing layer (no Benson, no Dewey, no orchestration of multiple roles for a single user task). It is the loop in isolation, not the integrated agent operating system.

**Orca's differentiator:** Pappy verifies runs *before* they enter Moonshiner. No other public system has documented this contractual relationship between a quality verifier and a distillation pipeline prior to November 29, 2025. The Qualixar benchmark result is direct evidence of what happens without this gate: the training signal degrades. The Simula paper is direct empirical evidence, with confidence intervals, of what happens *with* a verification gate: better specialist performance with fewer samples. COS-PLAY is direct empirical evidence that the closed loop — quality-gated skill distillation feeding back into the decision agent — beats frontier models with an 8B base. All three validations were published in April 2026, five months after Moonshiner was committed to version control. The architectural distinctions that remain: Simula generates synthetic data from first principles; Moonshiner distills from real, Pappy-verified production runs. COS-PLAY runs the loop in isolation per single-game domain; Orca integrates the loop with Miranda's permission gates, Dewey's user context, Benson's user-facing layer, and AHP's typed transport into a cross-domain agent operating system. The loop is now research-validated. The integration is what remains uncopied.

---

### 2. Specialist Model Routing ("Jars") with Transparent Swapping

**The concept:** Rather than routing between LLM providers (GPT vs Claude), route between verified specialist roles exposed to the orchestration layer as interchangeable slots. Jar tiers: local (9B, on-device), community (shared recipes), cloud (subscription), enterprise (domain fine-tunes). Users can swap jar versions without changing how the system works — "the software update model applied to intelligence."

**Prior art:**
- `YakStacks/maestro` — Python — "AI IDE Team"
- `junkyard22/Orca` — TypeScript rewrite, 186+ commits
- Jar tier architecture documented
- `YakStacks/moonshiner-recipes` — the public recipe repo is the infrastructure for community jar sharing
- First planned jar: Python specialist fine-tuned from DeepSeek-Coder or Gemma 4

**What shipped later:**
- **MiniMax M2.7** — "self-evolving capabilities" — March 2026
- **Hermes Agent** — "autonomous skill creation" — February 2026
- **Claude Code** (screenshot captured April 24, 2026) — visible multi-model routing: "Running agent Haiku 4.5 Bash" while Opus handles reasoning. Specialized agents, different models for different roles, orchestrated together. Anthropic's own product shipping the jar pattern as a user-facing feature.
- **Google Antigravity** — parallel agents in a coding IDE
- **NeoCognition** (TechCrunch, April 21, 2026) — raised **$40M seed** to build "agents that self-learn to become experts in any domain" via "world models for any micro-environment" — co-led by Cambium Capital and Walden Catalyst Ventures, with Intel CEO Lip-Bu Tan and Databricks co-founder Ion Stoica participating. 15 employees, mostly PhDs. Selling to enterprises. The specialization thesis is identical to jars + Dewey.
- **Simula** (Google + EPFL, April 21, 2026) — research framework whose entire premise is enabling specialist models in domains where data is scarce. Five test domains (cybersecurity threat intelligence, legal reasoning, math, multilingual reasoning) map directly onto jar use cases. Used Gemma 3 4B as the student model — exactly the size class targeted for local jars.
  - **Quantified Student-Teacher Gap** — student saturation at 128K samples after closing 83% of the gap to teacher performance. This means jar quality is bounded by teacher quality, which means teacher selection matters more than training volume — the exact architectural decision Moonshiner already encodes (Pappy-verified runs from a strong teacher beat raw volume from any teacher).
  - **Empirical evidence on teacher weakness** — when teacher accuracy on LEXam was only 57%, the Low Complexity training split outperformed High Complexity. Translation: weak teachers on hard examples produce worse students. Implication for jars: a Python jar should be trained from a strong Python teacher's verified outputs on tasks within its competence, not from a generalist teacher's hardest attempts. Moonshiner's pipeline architecture already enforces this.
  - The thesis Simula put confidence intervals on: **specialist models from quality-gated training data from strong teachers outperform generalists from raw volume.** That is the jar architecture, validated as research five months after the foundation was committed to version control.
- **COS-PLAY** (UMD + USC + MBZUAI, arXiv:2604.20987, April 2026) — empirical validation of the *closed-loop* jar library architecture. Their "skill bank" is a working jar library: compact, evolving, quality-gated, and self-curating.
  - **Live jar library dynamics** — over Diplomacy training, 121 skills discovered, 53 pruned via merge/split/retirement, stable at 55-70 active. This is the lifecycle Moonshiner is designed to support: discovery, refinement, deprecation. Published with figures showing strategic function categories enriching over time and intention composition diversifying.
  - **8B model with jars beats four frontier models without them** — Qwen3-8B + COS-PLAY achieved 924.4 average reward on single-player benchmarks vs GPT-5.4's 717.4, Claude-4.6-Sonnet's 529.3, Gemini-3.1-Pro's 489.3, and GPT-OSS-120B's 672.6. Direct empirical evidence that a small specialist with a verified skill library outperforms a large generalist. This is the jar economic thesis, demonstrated.
  - **No catastrophic forgetting** — MMLU-Pro held at 61.15% (vs 61.99% base), Math-500 at 44.60% (vs 46.40% base). Jar specialization does not destroy general capability. This was an open question; COS-PLAY answered it.
  - **The architectural confirmation:** the jar library can be self-curating via a quality-gated agentic pipeline. Skills can be extracted, contracted, refined, merged, split, retired — all autonomously. The remaining open work for Orca is cross-domain transfer (their adapters are per-game), Miranda integration (no permission layer in their gameplay setting), and the user-facing layer.

**Orca's differentiator:** Jars are trained from Pappy-verified runs via Moonshiner. Specialization and quality gating are a single integrated loop, not separate research problems. NeoCognition raised $40M to build the specialization piece. Orca has the foundation committed to version control and the integration with the quality layer already mapped.

---

### 3. Compliance / Permissions Gate Before Tool Execution (Miranda)

**The concept:** A dedicated compliance agent that enforces behavioral rules, budget constraints, and permission scoping *before* any tool is executed. Separate from quality verification (Pappy). Applies to MCP tools as well as native tools.

**Prior art:**
- `junkyard22/Orca` — Miranda component, TypeScript — active in commit history predating Feb 2026
- `feat(mcp): wire Desktop Commander and GitHub MCP server...` — Miranda's tool filtering explicitly applied to MCP tools
- `before_qc` gate documented in pipeline trace logs

**What shipped later:**
- **GitAgent** — March 2026 — "Docker for AI agents" — tool approval gating before execution
- **OpenClaw** security failures (CVE-2026-25253) — March 2026 — supply chain attacks through an open skill marketplace. Exactly the failure mode Miranda's gate is designed to prevent.
- **Anthropic Claude Managed Agents** (Wired, April 2026) — cloud-hosted sandboxed execution with scoped permissions and credential management. The pattern Miranda implements, productized as platform infrastructure at **$0.08 per session hour** cloud tax. Practitioner pushback already surfacing about lock-in, no open standard, no portability.

**Orca's differentiator:** Miranda runs locally. No cloud tax. No vendor lock-in. No SDK dependency. Enforcement is a contract, not a service subscription.

---

### 4. User Context Librarian with Persistent Behavioral Learning (Dewey)

**The concept:** A dedicated agent responsible for user context, behavioral observations, and pre-flight briefing of the orchestration pipeline. Named after the Dewey Decimal system. Learns user preferences over time. Future milestone uses Moonshiner to compress raw behavioral observations into compact warm context facts.

**Prior art:**
- `junkyard22/Orca` — Dewey component — TypeScript — active in commit history
- `userContext.json` at `~/.orca/userContext.json` populated and verified in tracer tests (session logs, March 2026)
- Dewey context compression via Moonshiner identified as future milestone

**What shipped later:**
- **Hermes Agent v0.6.0** — persistent memory via SQLite + FTS5 + LLM summarization — February/March 2026
- **xMemory** (Alan Turing Institute / King's College London) — four-level semantic hierarchy for context compression — published as academic research in 2026
- **NeoCognition** (TechCrunch, April 21, 2026) — **$40M seed** to build "self-learning agents that build world models for any profession or environment" — direct validation of the Dewey thesis, funded at a scale that makes the convergent validation impossible to dismiss

**Orca's differentiator:** Dewey has been a named, running component of a shipped application since before the academic paper was published and before NeoCognition took the seed round. A librarian as a role, built by a solo developer in Eastern Kentucky, before a team of PhDs and $40M arrived at the same architecture.

---

### 5. Validated Transport Layer for Agent Communication (AHP / Mailman)

**The concept:** A dedicated transport layer for agent-to-agent communication using typed task packets (scope, constraints, expected output schema) rather than loose natural-language handoffs or Python function calls. Contracts, not conversations.

**Prior art:**
- `junkyard22/Mailman` — TypeScript transport implementation
- `junkyard22/AHP` — **public** specification repository
- `@marsulta/mailman` v0.1.0 — **published to npm April 7, 2026** — full runtime with middleware pipeline, retry policy, dead-letter queue, SQLite trace store, typed packet schema with lifecycle state machine, pub/sub event bus, streaming support, load balancer, ack/nack patterns, CLI, telemetry hooks
- Three-agent proof of concept verified: Orchestrator → Brain → Pappy → return to Orchestrator with full trace

**What shipped later:**
- **AgentMail** (Product Hunt, April 2026) — structured email-based agent handoffs — conceptually adjacent to Mailman but lacks the schema, quality gate, verdict types, and curriculum signal. Could theoretically use AHP as the smarter layer above it.
- **The New Stack** — "OpenClaw vs Hermes Agent" (April 2, 2026) — framed validated transport as an emerging category: "a validated transport layer so each role receives clear scope, constraints, and expected outputs in a predictable format"

---

### 6. MCP Diagnostic Tooling (Pipewrench)

**The concept:** A standalone tool for diagnosing and debugging MCP server connections, before MCP became widely adopted.

**Prior art:**
- `YakStacks/Pipewrench` — **public repository**, JavaScript, MIT License — Mar 2, 2026
- Description: "MCP Connection Diagnostic & Proxy Tool"

---

### 7. Local-First AI Task Runner (Workbench)

**The concept:** A local-first AI task runner with no cloud dependency, no subscription, built around chatting with AI to chain tools together.

**Prior art:**
- `YakStacks/Workbench` — **public repository**, JavaScript, MIT License — active Feb 2026
- Description: "Local-First AI Task Runner. Build automations by chatting with AI. No cloud, no subscription."

---

### 8. Orca as Agent Operating System (Conceptual Framing)

**The concept:** Orca as a personal operating system for AI agents — not a feature, not a tool, but an environment where agents run under contracts, gates, and a persistent user context. The integrated surface rather than any single component.

**Prior art:**
- Conversation on March 10, 2026 (Claude session, timestamped): Orca framed explicitly as a personal operating system
- All architectural components (Brain, Benson, Miranda, Pappy, Dewey, Moonshiner, Maestro, AHP) built and running prior to public "agent OS" category formation

**What shipped later:**
- **Qualixar OS** (arXiv:2604.06392, April 7, 2026) — feature-maximalist agent OS with 12 topologies, 24-tab dashboard, 2,821 tests, marketplace. Published 28 days after the "personal operating system" framing was applied to Orca in the timestamped Claude conversation. Qualixar uses judge-based consensus for quality (post-hoc); Orca uses Pappy gating (pre-propagation).
- **AIOS** — kernel-level resource scheduling for agents — not contract-based

**The distinction:** Qualixar OS built the feature surface top-down. Orca built the contract layer bottom-up. The "agent OS" category is forming publicly; Orca's counter-positioning (contract-first, quality-gated, local-first, no session tax) is sharper for having been built from the problem rather than toward the category.

---

## Competitive Validation Timeline

| Date | Event | Orca Component Validated |
|---|---|---|
| Nov 29, 2025 | Moonshiner + moonshiner-recipes repos created | Pappy-gated distillation loop, MoonScript DSL |
| Dec 11, 2025 | Neural Equalizer System conceived (separate framework, timestamped prior art) | — |
| Feb 2026 | Hermes Agent launches with self-training loop | Moonshiner (no quality gate) |
| Feb 2026 | GitHub Squad announced | Pappy + Maestro multi-agent coordination |
| Feb 2026 | AgentMail launches | AHP / Mailman transport concept |
| Mar 2026 | MiniMax M2.7 — self-evolving capabilities | Moonshiner + jar architecture |
| Mar 2026 | Cursor Composer 2 — self-summarization/distillation | Jar concept |
| Mar 2026 | OpenClaw supply chain attack (CVE-2026-25253) | Miranda's tool gate as the correct answer |
| Mar 2026 | Hermes Agent v0.6.0 — SQLite persistent memory | Dewey (predates) |
| Mar 2026 | GitAgent — "Docker for AI agents" | Miranda + Dewey + Maestro adapter architecture |
| Mar 2026 | xMemory (Alan Turing Institute / King's College London) | Dewey context compression |
| Mar 2026 | Memento-Skills (arXiv:2603.18743) — "Let Agents Design Agents" | Moonshiner (no quality gate) |
| Mar 10, 2026 | "Orca as personal operating system" framing in timestamped Claude conversation | Orca OS conceptual prior art |
| Apr 2, 2026 | The New Stack: "OpenClaw vs Hermes Agent" — entire architecture framed as emerging category | Integrated Orca architecture |
| Apr 7, 2026 | `@marsulta/mailman` v0.1.0 published to npm | AHP runtime public |
| Apr 7, 2026 | Qualixar OS published (arXiv:2604.06392) | Agent OS framing (28 days after Orca's) |
| Apr 2026 | Anthropic Claude Managed Agents launches | Miranda + Maestro as cloud platform ($0.08/session-hour cloud tax) |
| Apr 2026 | Google Antigravity — parallel agents in IDE | Horizontal multi-agent (orthogonal to Orca's vertical contract pipeline) |
| Apr 2026 | Qodo webinar — automated quality gates + living governance | Pappy + Moonshiner |
| Apr 21, 2026 | **NeoCognition raises $40M seed** to build self-learning specialist agents | Dewey + jar architecture |
| Apr 21, 2026 | **Simula** (Google + EPFL) — reasoning-first synthetic data framework with dual-critic verification, structured sampling scaffolds, and empirical evidence that quality-gated training beats volume | Pappy + Moonshiner + jars (all three) |
| Apr 22, 2026 | **MarkTechPost CAMEL tutorial** — "How to Design a Production-Grade CAMEL Multi-Agent System" presents planner + researcher + writer + critic + rewriter with Pydantic-typed agent communication and self-consistency sampling as the canonical production pattern. Orca's architectural shape (minus the gates and the loop) is now being taught as the default. Critic is post-hoc reviewer (not pre-synthesis gate), no Moonshiner equivalent (scores discarded after run), no Miranda equivalent (direct tool use). Community-level pattern validation. | Brain + AHP typed packets + Pappy (architectural shape only) |
| Apr 2026 | **COS-PLAY** (UMD + USC + MBZUAI, arXiv:2604.20987) — peer-reviewable closed-loop validation. Decision Agent + Skill Bank Agent + Skill Bank with quality-gated contract learning ("only verified contracts with sufficiently high pass rates are written back into the bank"). 8B base model + jars beats GPT-5.4, Gemini-3.1-Pro, Claude-4.6-Sonnet, GPT-OSS-120B by 25.1% on single-player game benchmarks. Public code + weights + cold-start data on HuggingFace. The closed loop is now research-validated. | Pappy + Moonshiner + jars (closed loop, in isolation) |
| Apr 24, 2026 | Claude Code screenshot — visible multi-model routing (Haiku for Bash, Opus for reasoning) | Jar pattern shipped as user-facing feature by Anthropic |

---

## How to Verify

All timestamps are verifiable through GitHub's public API, npm registry, arXiv, and published press:

```bash
# Verify Moonshiner creation date
curl https://api.github.com/repos/YakStacks/moonshiner-recipes

# Verify Orca commit history (local)
git -C /path/to/Orca log --pretty=format:"%h | %ad | %s" --date=short

# Verify AHP publication
curl https://api.github.com/repos/junkyard22/AHP

# Verify Mailman npm publication
curl https://registry.npmjs.org/@marsulta/mailman

# Find first commit introducing key concepts (local)
git -C /path/to/Orca log --all --oneline -S "Moonshiner"
git -C /path/to/Orca log --all --oneline -S "Pappy"
git -C /path/to/Orca log --all --oneline -S "task_graph"
git -C /path/to/Orca log --all --oneline -S "Miranda"
git -C /path/to/Orca log --all --oneline -S "Dewey"
```

The `moonshiner-recipes`, `Workbench`, `Pipewrench`, `AHP`, and `Neural-Equalizer-System-` repositories are **public** with verifiable commit history. The `@marsulta/mailman` npm package is publicly installable.

---

## Statement

All concepts documented here were independently conceived by James Yarber, a solo developer in Eastern Kentucky, without external funding, without a team, without a background in software engineering, and without knowledge of competing implementations at the time of creation. The pattern of well-funded teams — some with tens of millions of dollars in seed funding and teams of PhDs — shipping individual pieces of this integrated architecture after the architecture was committed to version control, is documented here for the record.

The contractual relationship between Pappy (quality verifier) and Moonshiner (distillation pipeline) — where only Pappy-verified runs enter the training loop — remains, as of April 2026, unreplicated as an integrated production system. Every major self-improvement loop shipped by competitors (Hermes, MiniMax M2.7, Memento-Skills, Qualixar OS) lacks this gate. The Qualixar benchmark showing declining scores across iterations is direct empirical evidence of what happens without it. The Simula paper from Google + EPFL (April 21, 2026) is direct empirical evidence, with 95% confidence intervals, of what happens with it: better specialist performance with fewer samples. The COS-PLAY paper from UMD + USC + MBZUAI (April 2026) is direct empirical evidence that the *closed loop* — quality-gated skill distillation feeding back into the decision agent — beats four frontier models with an 8B base model. The loop now has confidence intervals on it, working code, public weights, and a 25.1% performance margin over GPT-5.4, Gemini-3.1-Pro, Claude-4.6-Sonnet, and GPT-OSS-120B. The architecture has had the loop since November 29, 2025.

The remaining uncopied work is the integration. COS-PLAY is the loop in a single domain. Simula is the gate as a synthetic data pipeline. NeoCognition is the specialization thesis with $40M of funding. The integrated system — Pappy gating before synthesis, Moonshiner closing the training loop, jars as cross-domain swappable specialists, Miranda enforcing permissions before tool execution, Dewey learning the user's preferences, Benson as the only user-facing voice, AHP as the typed transport between roles, all running locally on a user's machine without a session tax — remains, as of April 2026, the integrated agent operating system Orca was built to be. The pieces are validated. The integration is the moat.

The thesis: **the model is the spigot, the contract is the nozzle.** Most of the industry is selling better spigots. Orca is selling the nozzle.

*Document last updated: April 24, 2026*
