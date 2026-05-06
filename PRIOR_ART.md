# Orca — Prior Art & Competitive Landscape

**Author:** James Yarber (GitHub: [junkyard22](https://github.com/junkyard22))
**Organization:** [YakStacks](https://github.com/YakStacks)
**Primary Repo:** [github.com/junkyard22/Orca](https://github.com/junkyard22/Orca)
**Public Release:** Orca v1.0.0 (current: v1.3.0)
**Published Spec:** [Agent Handoff Protocol — github.com/junkyard22/AHP](https://github.com/junkyard22/AHP)
**Published Runtime:** [@marsulta/mailman on npm](https://www.npmjs.com/package/@marsulta/mailman)
**Document last updated:** May 2026

---

## How to Read This Document

This is not a flat list of prior art. It is a **competitive landscape map** with Orca at the center.

Each section covers one architectural component. Each entry records a well-funded team or published research that independently arrived at part of that component — after Orca's timestamped commits. The **Gap** column is what they built. The **What They Missed** column is the moat.

The through-line: every team in this document solved a piece of the problem. No team outside of Orca has assembled all the pieces into an integrated, quality-gated, self-improving orchestration system with verified training signal.

---

## Core Thesis

> **The model is the spigot. The contract is the nozzle.**

Output quality is determined at the boundary, not at the source. Any LLM — frontier, local, cheap, expensive — can fulfill a role as long as it passes the contract. Pappy enforces that contract. Moonshiner trains better spigots from verified flows over time. The jar system makes specialized execution cheaper without sacrificing quality.

Roles are defined by contracts, not by which model fulfills them. This makes Orca genuinely model-agnostic. Most of the industry is selling better spigots. Orca is selling the nozzle.

---

## Orca Architecture Reference

```
User
 └── Benson (intent parser + conversation)
       └── Orca Runtime (orchestration + repair loop)
             ├── Brain      → decomposes + routes tasks
             ├── Miranda    → tool access control (role-scoped tool surface)
             ├── Pappy      → QC verdicts (PASS/WARN/FAIL + confidence score)
             ├── Moonshiner → distillation pipeline (Pappy-verified JSONL → jar training)
             └── Jars       → small specialist models trained on verified runs
```

**Supporting systems:**
- **AHP (Agent Handoff Protocol)** — typed, validated packet-based agent-to-agent handoffs
- **Dewey** — persistent user context / warm context
- **CLAUDE.md** — versioned prompt artifacts loaded at inference time
- **Holster Memory** — tiered GPU memory architecture (system RAM as passive tier, VRAM as execution cache)
- **Neural Equalizer System (NES)** — neurotechnology framework treating neurological dysfunction as signal-quality failures

**Key timestamps (verified via GitHub commit history):**
- **November 20, 2025** -- Maestro initial commit; BrainPlanner subtask generation and routing based on task complexity (github.com/junkyard22/maestro)
- **November 28, 2025** -- Moonshiner v0.5.0 "Complete LLM fine-tuning build system" (github.com/junkyard22/moonshiner-recipes)
- **November 29, 2025** -- Moonshiner landing page, prompt datasets, case study committed
- **December 11, 2025** -- Neural Equalizer System defensive publication
- **December 2025** -- Holster Memory defensive publication
- **February 27, 2026** -- Orca first public post
- **Early 2026** -- AHP (@marsulta/mailman published to npm)
- **February 2026** -- CARI (separate project)
- **Current** -- Orca v1.3.0

---

## Section 1: Brain — Multi-Model Routing by Task Complexity

**What Orca built:** Brain decomposes user intent, classifies task complexity, and routes to the appropriate role (coder_strong, coder_cheap, reviewer, debugger, narrator, planner_deep, reader, vision). Routing decisions are based on task contract, not model identity. A cheap model that passes the Pappy contract is preferred over an expensive model that doesn't.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **IBM Bob** (IBM Research) | Multi-model routing by complexity; pipeline roles (Planner, Implementer, Reviewer, Debugger); human approval checkpoints | No quality gate on outputs. Routing happens; verification doesn't. No distillation loop. |
| Apr 2026 | **Thoughtworks SPDD** (Martin Fowler blog) | Spec-Prompted Domain Decomposition; prompts as versioned artifacts (= CLAUDE.md); REASONS Canvas (= Brain); "fix prompt before code" principle (= Pappy); typed handoffs (= AHP); compounding prompt assets (= Moonshiner) | All five concepts described independently, none integrated into a single quality-gated system with verified training signal. |
| Apr 2026 | **Claude Code multi-model routing** (Anthropic) | Visible multi-model routing — different models for different subtasks within the same session | Cloud-hosted. No local execution. No Pappy quality gate. No distillation pipeline. No jar training. |
| Apr 2026 | **AgentFlow** (UC Santa Barbara, arXiv:2604.20801) | Typed graph DSL covering agent roles, prompts, tools, communication topology, and coordination protocol; feedback-driven outer loop diagnosing which harness component caused failure; found changing only the harness while holding the model fixed changes success rates by several-fold | Harness is optimized automatically but there is no persistent quality gate (Pappy) on outputs, no distillation pipeline, and no training signal generated from verified runs. Security-domain focused. |
| Apr 2026 | **HeavySkill** (Meituan LongCat Team, arXiv:2605.02396) | Parallel reasoning (spawn K independent agents) then sequential deliberation (synthesizer reviews all trajectories); skill packaged as readable markdown file loaded at inference time (= CLAUDE.md pattern) | Sequential deliberation trusts the synthesizer's output. No quality gate. No Pappy. The framework produces a confident answer; Orca produces a *verified* answer. |
| Mar 2026 | **Anthropic Managed Agents** (Maestro + Miranda as hosted service) | Orchestrator + subagent pool, self-evaluation research preview | Cloud-hosted with $0.08/session-hour infrastructure tax. No Pappy. No distillation loop. No local execution. |
| May 2026 | **Anthropic Managed Agents: Dreaming, Outcomes, Multiagent** (Anthropic, May 6 2026) | Lead agent decomposes work and delegates to specialist subagents with their own model, prompt, and tools running in parallel; specialists contribute to lead agent's overall context; full trace visibility in Claude Console | Cloud-locked. No local execution. No model training from verified signal. No jar system. Multiagent orchestration validates Brain + AHP architecture; specialists with role-specific models validates the jar routing thesis. |

---

## Section 2: Miranda — Role-Scoped Tool Access Control

**What Orca built:** Miranda filters the tool surface available to each agent role. A Benson-tier agent cannot see, call, or hallucinate tools reserved for higher-privilege roles. Access control is upstream of execution — agents don't know the tools exist. This is structurally stronger than catching a bad action after it's attempted.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **AgentFlow** (UC Santa Barbara, arXiv:2604.20801) | Typed DSL specifying which tools each agent role may call; tool access defined as part of harness contract | Tool surface defined at harness design time, not enforced upstream at runtime. Agent still attempts calls; access is constrained by spec, not by what the agent can see. Miranda shapes the tool surface before the agent's context is built. |
| May 2026 | **AWS Rex (Trusted Remote Execution)** | Policy-enforced script runtime; every system operation authorized by Cedar policy before execution; agents receive ACCESS_DENIED_EXCEPTION if they exceed policy scope | Rex catches a bad action at the door after the agent attempts it. Miranda doesn't let the agent know the door exists. Rex constrains what agents can do to the host. Miranda shapes the agent's entire tool surface at the role level upstream. |
| Apr 2026 | **IBM Bob** | Human approval checkpoints between pipeline stages | Supervision by convention, not architecture. A human reviews; the system doesn't enforce role-scoped access at the tool level. |
| Apr 2026 | **Microsoft Agent Framework v1.0** | Middleware hooks for intercepting execution; pause/resume; human-in-the-loop approvals | Interception after the fact. No role-scoped tool surface definition. No upstream access shaping. |

---

## Section 3: Pappy — Quality Gating (PASS/WARN/FAIL)

**What Orca built:** Pappy evaluates every pipeline output with PASS/WARN/FAIL verdicts and a confidence score before the result reaches the user. Failed runs trigger an automatic repair loop. Only PASS runs enter Moonshiner's training pipeline. The contractual relationship between Pappy (verifier) and Moonshiner (distillation) — where only verified runs train the next model — is the core moat.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **AgentFlow** (UC Santa Barbara, arXiv:2604.20801) | Feedback-driven outer loop reads runtime signals to diagnose which harness component caused failure and rewrites it; coarse pass/fail feedback identified as a known limitation they partially address | Diagnostic feedback rewrites the harness. It does not gate whether the output is accepted or enters a training pipeline. No Pappy equivalent. No distillation signal. |
| Apr 2026 | **DELEGATE-52** (Microsoft Research, arXiv:2604.15597) | Tested 19 LLMs including GPT-5, Claude 4.6 Opus, Gemini 3.1 Pro on delegated workflows; found even best frontier models silently corrupt ~25% of document content over long workflows; degradation compounds with document length and interaction count; adding tools doesn't fix it | Published the problem. Didn't build the gate. This paper is the most direct academic validation that Pappy is architecturally necessary, not optional. |
| Apr 2026 | **AWS RFT with LLM-as-a-Judge** (Amazon) | Recommends Boolean pass/fail scoring for reliability (vs. fine-grained numeric scales); LLM judges provide rationales that pinpoint failure modes; recommends smaller specialized RFT models over larger general ones | Published best practices describing what Pappy already does. AWS recommends the pattern; Orca implemented it. |
| Apr 2026 | **Simula** (Google + EPFL) | Reasoning-first framework for generating controlled synthetic datasets; dual-critic verification (independently asks whether output is correct AND whether it is incorrect, to mitigate sycophancy bias); teacher quality and verification rate matter more than data volume | Simula had to invent an architectural workaround within a single model to address the problem Pappy solves by making the verifier a structurally independent agent with its own contract. |
| Apr 2026 | **Qualixar OS** | Self-improving agent loop with quality metrics | Published benchmark data showing declining scores over training iterations — direct empirical evidence of what happens without a quality gate. The training signal degrades when unverified outputs feed the loop. |
| Apr 2026 | **Thoughtworks SPDD** | "Fix the prompt before the code" principle | Described the gate conceptually. Did not implement automated PASS/WARN/FAIL verdict architecture with confidence scoring and repair loop integration. |
| Apr 2026 | **AHE** (Fudan/Peking/Shanghai AI Lab, arXiv:2604.25850) | Component/experience/decision observability; confidence-scored verification | Observability layer. Passive. Does not gate whether output proceeds or triggers repair. |
| 2026 | **Qodo** | Automated quality gates; "living governance system that learns" | Quality gates described at the policy level. No published implementation of PASS/WARN/FAIL verdict architecture with confidence scoring feeding a distillation pipeline. |
| Apr 2026 | **Microsoft Universal Verifier** (Microsoft Research) | Trajectory verification for computer use agents; distinguishes process rewards from outcome rewards | Verification at the trajectory level, not at the pipeline output level. Does not gate distillation signal. |
| May 2026 | **AWS AgentCore Quality Optimization** (Amazon, May 4 2026) | Observe-evaluate-improve loop: production traces feed evaluations, evaluations surface drift, LLM-generated recommendations propose prompt/tool changes, A/B testing validates them against live traffic with statistical significance | Developer-triggered by design -- a human initiates every cycle. Orca's loop is automatic: Pappy gates every run, Moonshiner trains continuously from verified signal. Cloud-locked to AgentCore Runtime. Not local-first. No model-agnostic execution. Published May 4, 2026 -- five months and six days after Moonshiner v0.5.0. |
| May 2026 | **Anthropic Managed Agents: Outcomes** (Anthropic, May 6 2026) | Separate grader evaluates output against a rubric in its own context window, independent of the agent's reasoning; when output fails, grader pinpoints what needs to change and agent takes another pass; improved task success by up to 10 points over standard prompting loop in internal benchmarks | Outcomes validates Pappy's architecture word for word -- separate context window, independent verdict, triggers repair. Gap: verified runs don't train a new model. The loop improves via prompts and memory, not model weights. No Moonshiner. No jar training. Cloud-locked. Published May 6, 2026 -- Moonshiner v0.5.0 was November 28, 2025. |

---

## Section 4: Moonshiner + Jar System — Quality-Gated Distillation

**What Orca built:** Moonshiner exports Pappy-verified runs as JSONL and trains small specialist models (jars) on that clean signal. The Moonscript DSL (`mash_bill`, `still`, `barrel_age`, `bottle`) defines distillation recipes. Only PASS verdicts enter the training loop. The jar system replaces general-purpose large models with small domain-specialists for scoped tasks — cheaper, faster, and more reliable on their domain.

**The thesis:** Smaller specialized models trained on quality-gated data outperform larger general models on scoped tasks. This has now been independently validated by five separate research teams — and both AWS and Anthropic have shipped products attempting to approximate the loop.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **AWS RFT** (Amazon) | Smaller specialized RFT models (Amazon Nova 2 Lite) outperform larger general models (Claude Sonnet 4.5, Claude Haiku 4.5) on targeted tasks when trained with quality-filtered data | RFT with external judge. Does not have an internal quality gate (Pappy) that generates the verified training signal from the same orchestration system. |
| May 2026 | **AWS AgentCore Quality Optimization** (Amazon, May 4 2026) | Flywheel framing: winning configuration becomes the new baseline, its traces feed the next cycle; LLM-generated recommendations optimize system prompts and tool descriptions from production trace data | Flywheel requires a human to pull the crank -- developer-triggered, not automatic. No equivalent to Moonshiner's Pappy-gated JSONL export and jar training. Optimizes prompts and tool descriptions only; does not train a new model from verified runs. Cloud-locked. |
| May 2026 | **Anthropic Managed Agents: Dreaming** (Anthropic, May 6 2026) | Scheduled process reviews past sessions, extracts patterns including recurring mistakes and workflows agents converge on, curates memories so agents self-improve over time; memory captures what agents learn as they work, dreaming refines it between sessions | Dreaming is scheduled and passive -- a background process that surfaces patterns. Moonshiner is triggered by Pappy verdicts -- only verified runs feed the loop. Dreaming updates memory and prompts; Moonshiner trains model weights. No jar training. No quality gate on what enters the improvement loop. Cloud-locked. |
| May 2026 | **Qwen-Scope** (Alibaba/Qwen AI) | Sparse autoencoder suite; feature-driven safety data synthesis achieves 99.74% coverage of target feature sets vs. substantially lower coverage from unfiltered sampling; smaller specialized models beat larger general ones in benchmarks | Validates the quality-gated data thesis and the jar system thesis empirically. Does not have a Pappy-equivalent integrated into an orchestration pipeline that generates the training signal. |
| Apr 2026 | **Simula** (Google + EPFL) | Quality-controlled synthetic data synthesis for specialist domains; teacher quality and verification rate matter more than volume; weak teachers degrade student performance even with harder examples | Validates the Moonshiner pipeline architecture: don't train from weak teacher outputs, gate by quality, use strong verified signal. Published April 2026. Moonshiner timestamps: November 2025. |
| Apr 2026 | **NeoCognition** ($40M seed) | Specialized AI models for domain-specific tasks | Validates the jar system market thesis. No published quality-gated distillation pipeline. |
| Apr 2026 | **Memento-Skills** (arXiv, submitted March 19, 2026) | Continual agent self-improvement via externalized skill memory | Self-improvement without quality gate. Moonshiner timestamps predate submission by ~4 months. |
| May 2026 | **HeavySkill DFlash** (Google/UCSD, Google Developers Blog) | Diffusion-style speculative decoding achieving 3.13x inference speedup; key finding: improving per-position acceptance probability is 2-3x more valuable than increasing block size — quality over quantity | Direct empirical validation of the jar thesis from the inference side: domain-specialized models with high acceptance rates on structured tasks (math, code) dramatically outperform general models. Exactly the case for a Python specialist jar. |

---

## Section 5: AHP — Typed Agent-to-Agent Handoffs

**What Orca built:** Agent Handoff Protocol defines typed, validated packet-based communication between agents. Each packet carries task scope, constraints, expected output schema, and repair instructions. The `@marsulta/mailman` npm runtime implements the spec. AHP functions as an execution substrate, not just an audit layer.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Microsoft A2A v1** (backed by AWS, Cisco, Google, IBM, Salesforce, SAP, ServiceNow) | Production-ready open standard for typed agent-to-agent communication; typed handoffs; discovery via well-known URI; streaming SSE | Clean typed handoffs with no quality verification equivalent to Pappy anywhere in the spec. The biggest names in enterprise software converging on a typed handoff standard validates the AHP architecture. None of them have a Pappy equivalent. |
| Apr 2026 | **OpenClaw A2A plugin architecture** (freeCodeCamp) | A2A plugin architecture proposal | Validates the pattern. No quality gate. No verified packet payload. |
| 2026 | **AgentMail** | Agent-to-agent messaging system | Validates the communication substrate concept. No typed packet schema with repair instructions. |
| Apr 2026 | **DARPA MATHBAC** | Phase I proposals seeking mathematical foundations for autonomous agent communication (proposals due June 2026) | DARPA independently identified the need for formal mathematical foundations for agent-to-agent communication — the problem AHP addresses at the protocol level. |

---

## Section 6: Brain as Agent OS — Orchestration as Operating System

**What Orca built:** Orca functions as an agent operating system: Brain is the scheduler, Miranda is the kernel (access control), Pappy is the runtime verifier, Moonshiner is the compiler (training signal), jars are the installed programs. This framing was committed to ARCHITECTURE.md on March 10, 2026.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Qualixar OS** | Explicitly branded as an "agent operating system" | Announced April 7, 2026 — 28 days after Orca's March 10 ARCHITECTURE.md commit using the same framing. No quality gate. Benchmark data shows declining performance over training iterations. |
| Apr 2026 | **Microsoft Agent Framework v1.0** | Merged Semantic Kernel + AutoGen into single SDK; sequential/concurrent/handoff/group chat orchestration patterns; streaming, checkpointing, human-in-the-loop | Orchestration plumbing. No quality loop. No distillation pipeline. No verified training signal. |
| Apr 2026 | **Anthropic Managed Agents** | Maestro + Miranda as hosted cloud service | Cloud-only. No Pappy. No distillation. No local execution. No jar system. |
| Apr 2026 | **Rowboat** (YC-backed) | Open-source local-first AI coworker | Local-first framing validates the local execution thesis. No quality gate. No distillation loop. |

---

## Section 7: CLAUDE.md — Prompts as Versioned Artifacts

**What Orca built:** CLAUDE.md stores versioned prompt artifacts that encode role behaviors, constraints, and skill activations. Loaded at inference time. Changed by editing a file, not by redeploying code. This is the "fix the prompt before the code" architectural principle made operational.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Thoughtworks SPDD** | "Prompts as versioned artifacts" as a core principle of spec-prompted domain decomposition | Described the principle. Did not implement a named, structured file loaded at inference time as part of an orchestration system. |
| 2026 | **HeavySkill** (Meituan) | Skill packaged as readable markdown file loaded at inference time by the orchestrator | Validates the CLAUDE.md pattern at the research level. Published after Orca's implementation. |
| Apr 2026 | **Memento-Skills** (arXiv) | Externalized skill memory for continual agent self-improvement | Validates the externalized skill concept. No quality gate on skill acquisition. |

---

## Section 8: Holster Memory — Tiered GPU Memory Architecture

**What Orca built:** System RAM as a "holster" (passive tier), VRAM as an execution cache (active tier). Layer-by-layer promotion/eviction with a named scheduler. Explicit framing of VRAM as an execution cache rather than a container. Defensive publication: December 2025.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| 2026 | **MegaTrain** (arXiv) | CPU-offloaded large model training; tiered memory management for inference | Validates the tiered memory thesis. Does not use the "holster/execution cache" framing or apply it to consumer GPU workloads as a first-class architectural model. |
| 2026 | **ZeRO-Offload / Accelerate** (existing work) | CPU offloading for model weights during training | Prior art for offloading exists. Holster Memory's novelty is the explicit tiered execution cache model with a scheduler, applied to consumer inference rather than training. |

---

## Section 9: Neural Equalizer System (NES)

**What Orca built:** A neurotechnology framework treating neurological and psychiatric dysfunction as signal-quality failures across volume, frequency, timing, and coherence dimensions. Published at github.com/junkyard22/Neural-Equalizer-System- under CC BY-NC 4.0. Defensive publication: December 11, 2025. Academic outreach initiated to University of Kentucky researchers.

*This section will be expanded as academic validation emerges.*

---

## The Integrated Picture

The table below shows what each major team built and what piece they are missing.

| Team | Brain/Routing | Access Control | Quality Gate | Distillation | Typed Handoffs | Local-First |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Orca** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic Managed Agents (Dreaming/Outcomes/Multiagent) | ✅ (multiagent) | — | ✅ (Outcomes, no jar training) | ✅ (Dreaming, memory only) | — | — |
| AWS AgentCore Quality Optimization | — | — | ✅ (manual trigger) | ✅ (prompt/tool only, no jar training) | — | — |
| AgentFlow | ✅ | ✅ (DSL spec) | — | — | ✅ (typed DSL) | — |
| IBM Bob | ✅ | ✅ (human checkpoints) | — | — | — | — |
| Microsoft A2A v1 | — | — | — | — | ✅ | — |
| AWS Rex | — | ✅ | — | — | — | — |
| Anthropic Managed Agents | ✅ | — | — | — | — | — |
| Qualixar OS | ✅ | — | — | ✅ (unverified) | — | — |
| HeavySkill | ✅ | — | — | — | — | — |
| Thoughtworks SPDD | ✅ | — | ✅ (principle) | ✅ (principle) | ✅ (principle) | — |
| Rowboat | ✅ | — | — | — | — | ✅ |

Every row is missing at least three checkmarks. Orca is the only system with all six.

---

## Verification

All Orca timestamps are verifiable via public GitHub commit history:

```bash
git clone https://github.com/junkyard22/Orca
git log --oneline --all | head -30

git clone https://github.com/junkyard22/AHP
git log --oneline --all | head -30
```

The `@marsulta/mailman` npm publish timestamp is independently verifiable at:
https://www.npmjs.com/package/@marsulta/mailman

---

## Closing Statement

The pattern documented here is consistent and repeating: well-funded teams with large engineering organizations are independently arriving at individual architectural decisions that Orca committed to version control earlier. IBM ships Brain-style routing. Microsoft ships AHP-style typed handoffs. AWS ships Miranda-style access control. Google publishes the Pappy-gated training data thesis. Each team solves one piece.

The piece none of them have built is the contractual relationship between Pappy and Moonshiner: a quality verifier whose verdicts are the exclusive source of training signal for the next model. That relationship — verified output as curriculum — is what makes the system self-improving without self-degrading.

The verified commit record is unambiguous. Maestro (Brain) was committed November 20, 2025. Moonshiner v0.5.0 "Complete LLM fine-tuning build system" was committed November 28, 2025. Every one of the 26 external validations in this document was published five or more months after those timestamps. The industry did not inspire this architecture. The architecture preceded the industry.

The industry is building better spigots. Orca built the nozzle, the gate, and the recycling loop — in November 2025.

*Document last updated: May 2026*
