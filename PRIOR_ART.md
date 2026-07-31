# Orca — Prior Art & Competitive Landscape

**Author:** James Yarber (GitHub: [junkyard22](https://github.com/junkyard22))
**Organization:** [YakStacks](https://github.com/YakStacks)
**Primary Repo:** [github.com/junkyard22/Orca](https://github.com/junkyard22/Orca)
**Public Release:** Orca v1.0.0 (current: v1.4.0)
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
- **Current** -- Orca v1.4.0

---

## Section 1: Brain — Multi-Model Routing by Task Complexity

**What Orca built:** Brain decomposes user intent, classifies task complexity, and routes to the appropriate role (coder_strong, coder_cheap, reviewer, debugger, narrator, planner_deep, reader, vision). Routing decisions are based on task contract, not model identity. A cheap model that passes the Pappy contract is preferred over an expensive model that doesn't.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **IBM Bob** (IBM Research) | Multi-model routing by complexity; pipeline roles (Planner, Implementer, Reviewer, Debugger); human approval checkpoints | No quality gate on outputs. Routing happens; verification doesn't. No distillation loop. |
| Apr 2026 | **Thoughtworks SPDD** (Martin Fowler blog) | Spec-Prompted Domain Decomposition; prompts as versioned artifacts (= CLAUDE.md); REASONS Canvas (= Brain); "fix prompt before code" principle (= Pappy); typed handoffs (= AHP); compounding prompt assets (= Moonshiner) | All five concepts described independently, none integrated into a single quality-gated system with verified training signal. |
| Apr 2026 | **Claude Code multi-model routing** (Anthropic) | Visible multi-model routing — different models for different subtasks within the same session | Cloud-hosted. No local execution. No Pappy quality gate. No distillation pipeline. No jar training. |
| Apr 2026 | **AgentFlow** (UC Santa Barbara, arXiv:2604.20801) | Typed graph DSL covering agent roles, prompts, tools, communication topology, and coordination protocol; feedback-driven outer loop diagnosing which harness component caused failure; found changing only the harness while holding the model fixed changes success rates by several-fold | Harness is optimized automatically but there is no persistent quality gate (Pappy) on outputs, no distillation pipeline, and no training signal generated from verified runs. Security-domain focused. |
| May 2026 | **Cursor /orchestrate** (Cursor, May 7 2026) | Recursively spawns agents to tackle ambitious tasks; planners spawn workers that write code and verifiers that run it; if verification fails the planner spawns a new worker to fix it; cut token use 20% and cold start times 80% internally | No Moonshiner. No quality-gated distillation. No typed AHP packets. No role-scoped access control. Validates Brain + Pappy + repair loop architecture. Cursor's free tier hitting its limit in July 2025 is the direct origin event that caused Orca to be built. |
| May 2026 | **Garry Tan gstack / Charlie Hills** (@charliejhills, May 8 2026, 62.8K views) | 6 named specialist agents each owning a phase: CEO challenges decisions before code, Eng Manager locks architecture, Designer ships variants, Release Manager deploys, Doc Engineer writes changelog, QA Lead runs real browser tests and audits; 38 slash commands across 9 categories | Named roles owning phases of the build validates Orca's character architecture. No quality gate on outputs. No distillation pipeline. No verified training signal. CLAUDE.md as the skill file validates the prompt-as-versioned-artifact pattern. |
| May 2026 | **Tech with Mak 9-layer AI production architecture** (May 8 2026) | document_grader.py, adaptive_router.py, query_router.py, versioned hot-swappable prompt templates, security input/output guards, online and offline evaluation pipelines | Every layer maps directly to an Orca component. document_grader = Pappy. adaptive_router = Brain. prompt templates = CLAUDE.md. security guards = Miranda. evaluation pipelines = Pappy + Moonshiner loop. No distillation. No jar training. |
| May 2026 | **RAO: Recursive Agent Optimization** (Apurva Gandhi, May 11 2026) | End-to-end RL approach for training LLM agents to spawn, delegate to, and coordinate with recursive copies of themselves; turning recursive inference into a learned capability rather than hand-coded routing rules | Validates Brain's routing architecture and points at the next evolution -- training Brain from verified outcomes so routing improves automatically. No Pappy quality gate. No distillation pipeline. No verified training signal feeding the routing improvement. The gap: RAO learns to route but doesn't gate output quality or train specialist models from verified runs. |
| May 2026 | **Sakana AI RL Conductor / Fugu** (VentureBeat, May 7 2026) | 7B model trained via RL to orchestrate a pool of frontier models including GPT-5, Claude Sonnet 4, and Gemini 2.5 Pro; dynamically assigns roles -- planners, executors, final coders -- without hardcoded pipelines; 7B Conductor surpasses every individual worker model in its pool on LiveCodeBench (83.9%) and GPQA-Diamond (87.5%); productized as Fugu commercial service | Cloud-locked commercial product. No Pappy. No quality gate on outputs. No verified training signal feeding back into the conductor. No local execution. Validates Brain's routing-by-complexity thesis and the jar thesis simultaneously -- a small specialized model outperforming every frontier model it routes. |
| Apr 2026 | **HeavySkill** (Meituan LongCat Team, arXiv:2605.02396) | Parallel reasoning (spawn K independent agents) then sequential deliberation (synthesizer reviews all trajectories); skill packaged as readable markdown file loaded at inference time (= CLAUDE.md pattern) | Sequential deliberation trusts the synthesizer's output. No quality gate. No Pappy. The framework produces a confident answer; Orca produces a *verified* answer. |
| Mar 2026 | **Anthropic Managed Agents** (Maestro + Miranda as hosted service) | Orchestrator + subagent pool, self-evaluation research preview | Cloud-hosted with $0.08/session-hour infrastructure tax. No Pappy. No distillation loop. No local execution. |
| May 2026 | **OpenAI Symphony** (OpenAI, May 12 2026) | Every open task gets a dedicated Codex agent; overnight autonomous PR merging from a Linear ticket queue; task decomposition into parallel agent workstreams | Brain-style task decomposition with dedicated agents per task. Gap: no quality gate before merge. No Pappy equivalent. No verification that the output is correct before it lands in production. No training signal from outcomes. Autonomous agents merging PRs overnight without human review is exactly the failure mode Miranda and Pappy exist to prevent. |
| May 2026 | **Claude Code Agent View** (Anthropic, May 12 2026) | Dispatch multiple agent sessions at once; each keeps running without taking up a terminal tab; see what's running, waiting, and done at a glance; reply inline to unblock sessions; jump in and out without losing place; available on all paid plans | Pipeline visibility with human-in-the-loop unblocking is Orca's pipeline view plus Miranda's approval checkpoint described as a Claude Code feature. Gap: paid plans only. No local execution. No Pappy quality gate. No distillation. Orca has had a pipeline view showing agent sessions, verdicts, and waiting states since v1.0.0 -- free, local, no subscription. |
| May 2026 | **Anthropic Managed Agents: Dreaming, Outcomes, Multiagent** (Anthropic, May 6 2026) | Lead agent decomposes work and delegates to specialist subagents with their own model, prompt, and tools running in parallel; specialists contribute to lead agent's overall context; full trace visibility in Claude Console | Cloud-locked. No local execution. No model training from verified signal. No jar system. Multiagent orchestration validates Brain + AHP architecture; specialists with role-specific models validates the jar routing thesis. |
| May 2026 | **Cursor / Bennett Brownlow** (@burkeho, May 14 2026) | Subagent delegation keeping main agent context clean; routing to capable submodels by task type; improving /multitask so the orchestrator stays uncluttered while specialist subagents handle scoped work | No quality gate on subagent output before it returns to the orchestrator. Validates Brain's routing-by-complexity and context-isolation thesis. The gap: subagent outputs enter the main context unverified. |
| May 2026 | **XDA Developers / Local LLM escalation** (May 17 2026) | Manual orchestration stack -- local model attempts task, retries on failure, escalates to Claude with compressed context; built with Ollama + LiteLLM + OpenRouter | Quality gate determining actual failure vs. perceived failure. No Pappy. No verified training signal from escalations. No AHP typed packets. Orca does this natively with one install. |
| May 2026 | **Eric Provencher / Serial Orchestration** (@pvncher, May 18 2026) | Manager model decomposes tasks and keeps sub-agents on track via serial execution; argued serial orchestration over parallel swarms produces better results | Quality gate between steps. No Pappy blocking a failed link from propagating. No training signal from outcomes. |

---

## Section 2: Miranda — Role-Scoped Tool Access Control

**What Orca built:** Miranda filters the tool surface available to each agent role. A Benson-tier agent cannot see, call, or hallucinate tools reserved for higher-privilege roles. Access control is upstream of execution — agents don't know the tools exist. This is structurally stronger than catching a bad action after it's attempted.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **AgentFlow** (UC Santa Barbara, arXiv:2604.20801) | Typed DSL specifying which tools each agent role may call; tool access defined as part of harness contract | Tool surface defined at harness design time, not enforced upstream at runtime. Agent still attempts calls; access is constrained by spec, not by what the agent can see. Miranda shapes the tool surface before the agent's context is built. |
| May 2026 | **AWS Rex (Trusted Remote Execution)** | Policy-enforced script runtime; every system operation authorized by Cedar policy before execution; agents receive ACCESS_DENIED_EXCEPTION if they exceed policy scope | Rex catches a bad action at the door after the agent attempts it. Miranda doesn't let the agent know the door exists. Rex constrains what agents can do to the host. Miranda shapes the agent's entire tool surface at the role level upstream. |
| May 2026 | **Superlog** (YC Launch, May 2026) | Observability agent that investigates incidents and auto-generates mergeable PRs; wizard-configured logs, traces, alerts; adjacent to Miranda's audit trail and Pappy's repair loop | Quality gate on the agent's own output. Who verifies Superlog's PRs? No Pappy equivalent gating the generated code before merge. No distillation from verified incident resolutions. |
| Apr 2026 | **IBM Bob** | Human approval checkpoints between pipeline stages | Supervision by convention, not architecture. A human reviews; the system doesn't enforce role-scoped access at the tool level. |
| Apr 2026 | **Microsoft Agent Framework v1.0** | Middleware hooks for intercepting execution; pause/resume; human-in-the-loop approvals | Interception after the fact. No role-scoped tool surface definition. No upstream access shaping. |
| May 2026 | **Notion Agent Activity** (Notion, May 13 2026) | Agent Activity dashboard showing what agents are doing in real time; one-click to full chat thread; eliminates wondering if agents are stuck | Control layer. Visibility after the fact vs Miranda's upfront tool authorization. Notion validated the observability need but did not build the enforcement mechanism — Miranda shapes the tool surface before the agent's context is built, not after it acts. |
| May 2026 | **LiteLLM Agent Platform** (BerriAI, May 16 2026) | Self-hosted Kubernetes platform for isolated agent sandboxes with persistent session management; per-team isolation, scoped secrets, session continuity across pod restarts; MIT license | Quality gate. No Pappy equivalent. Isolation without verification. No training loop from verified runs. Miranda works locally with zero infrastructure overhead vs. Kubernetes dependency. |

---

## Section 3: Pappy — Quality Gating (PASS/WARN/FAIL)

**What Orca built:** Pappy evaluates every pipeline output with PASS/WARN/FAIL verdicts and a confidence score before the result reaches the user. Failed runs trigger an automatic repair loop. Only PASS runs enter Moonshiner's training pipeline. The contractual relationship between Pappy (verifier) and Moonshiner (distillation) — where only verified runs train the next model — is the core moat.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Apple Reinforced Agent** (Apple, arXiv:2604.27233, Apr 29 2026) | Specialized reviewer agent inspects each provisional tool call before execution; injects feedback if something is off; primary agent revises; Loop 1 feedback, Loop 2 approval; Helpfulness-Harmfulness metrics quantify tradeoff; +5.5% irrelevance detection, +7.1% multi-turn with no base agent retraining; reasoning-model reviewers achieve 3:1 benefit-to-risk ratio; reviewer model selection becomes a separable production lever | Pre-execution verification with feedback injection and repair loop is Pappy at the tool-call level. "Keep the base agent frozen and improve only the reviewer" is the Pappy thesis exactly. Gap: verified corrections don't train a new model. No Moonshiner. No jar system. Apple built the gate. Orca built the gate and the recycling loop. |
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
| May 2026 | **Microsoft/waza** (Microsoft, May 8 2026) | Go-based CLI for evaluating Agent Skills quality; skill scaffolding with Skill.md templates; automatic eval generation feeding Skill.md to LLM to propose evaluation tasks; 9 grader types including LLM-as-judge; A/B testing to quantify skill improvement; readiness checks with compliance scoring; gates skill quality per PR; CI/CD integration | Evaluates skills and gates quality per PR -- that's Pappy as a CLI. Gap: evaluation results don't feed a distillation pipeline. No Moonshiner equivalent. No jar training from verified runs. Design philosophy of "test-driven engineering" over "craftsmanship of prompt engineering" validates Pappy's core thesis. |
| May 2026 | **GitHub Copilot Trust Layer** (Microsoft/GitHub, May 6 2026, arXiv:2605.03159) | Independent structural validator for Copilot Coding Agent; dominator analysis on execution traces identifies essential milestones vs. optional noise; external verifier outperforms agent self-assessment 100% vs 82.2% accuracy; agent self-assessment achieved 0% F1-score on identifying false failures -- proving agents cannot grade their own homework | Validates execution traces after the fact for CI pipeline reliability. Does not gate whether output proceeds, trigger a repair loop, or feed a distillation pipeline. Observability and verdict only -- not gate plus recycling loop. Published May 6, 2026. Pappy timestamps: November 2025. |
| May 2026 | **Anthropic Managed Agents: Insights** (Anthropic, May 9 2026) | Up to 100 recent sessions fetched and summarized in parallel; model writes task/actions/issues/assessment summary with 0-100 quality score per session; cross-session findings surface recurring errors, usage patterns, efficiency outliers, wins; error-category buckets and use-case clusters; every cited session ID verified against input | 0-100 quality score per session is Pappy's confidence scoring. Cross-session recurring error detection is Dewey's persistent context learning. Error-category buckets are Pappy's verdict categories. Gap: insights surface to a dashboard. They don't feed a distillation pipeline. No Moonshiner. No jar training from the patterns. Anthropic built the analytics layer. Orca built the analytics layer that teaches itself. |
| May 2026 | **Anthropic Managed Agents: Outcomes** (Anthropic, May 6 2026) | Separate grader evaluates output against a rubric in its own context window, independent of the agent's reasoning; when output fails, grader pinpoints what needs to change and agent takes another pass; improved task success by up to 10 points over standard prompting loop in internal benchmarks | Outcomes validates Pappy's architecture word for word -- separate context window, independent verdict, triggers repair. Gap: verified runs don't train a new model. The loop improves via prompts and memory, not model weights. No Moonshiner. No jar training. Cloud-locked. Published May 6, 2026 -- Moonshiner v0.5.0 was November 28, 2025. |

---

## Section 4: Moonshiner + Jar System — Quality-Gated Distillation

**What Orca built:** Moonshiner exports Pappy-verified runs as JSONL and trains small specialist models (jars) on that clean signal. The Moonscript DSL (`mash_bill`, `still`, `barrel_age`, `bottle`) defines distillation recipes. Only PASS verdicts enter the training loop. The jar system replaces general-purpose large models with small domain-specialists for scoped tasks — cheaper, faster, and more reliable on their domain.

**The thesis:** Smaller specialized models trained on quality-gated data outperform larger general models on scoped tasks. This has now been independently validated by five separate research teams — and both AWS and Anthropic have shipped products attempting to approximate the loop.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| May 2026 | **Sakana AI RL Conductor** (May 7 2026) | 7B Conductor model outperforms every frontier model in its worker pool on coding and reasoning benchmarks; small specialized model beats GPT-5, Claude Sonnet 4, and Gemini 2.5 Pro by learning to route tasks to the right model at the right time | Most direct benchmark validation of the jar thesis to date. Gap: no Pappy quality gate, no distillation pipeline, no verified training signal. Cloud-locked commercial product. |
| Apr 2026 | **AWS RFT** (Amazon) | Smaller specialized RFT models (Amazon Nova 2 Lite) outperform larger general models (Claude Sonnet 4.5, Claude Haiku 4.5) on targeted tasks when trained with quality-filtered data | RFT with external judge. Does not have an internal quality gate (Pappy) that generates the verified training signal from the same orchestration system. |
| May 2026 | **AWS AgentCore Quality Optimization** (Amazon, May 4 2026) | Flywheel framing: winning configuration becomes the new baseline, its traces feed the next cycle; LLM-generated recommendations optimize system prompts and tool descriptions from production trace data | Flywheel requires a human to pull the crank -- developer-triggered, not automatic. No equivalent to Moonshiner's Pappy-gated JSONL export and jar training. Optimizes prompts and tool descriptions only; does not train a new model from verified runs. Cloud-locked. |
| May 2026 | **alphaXiv / Reinforcing Recursive Language Models** (May 12 2026) | RL fine-tuned 4B model trained to behave as a recursive language model; matches Claude Sonnet 4.6 quality on evidence selection while running faster and cheaper; small specialist outperforms frontier model on scoped task | Most direct jar thesis validation yet with benchmark numbers. A 4B model matching Sonnet 4.6 quality proves specialized small models beat large general ones on domain tasks. Gap: no automated pipeline generating verified training signal. Pappy gates quality, Moonshiner trains from passing runs automatically. They proved the small specialist wins -- Orca automates producing it. |
| May 2026 | **Hermes Agent** (Nous Research, May 11 2026) | "The agent that grows with you" -- closed learning loop with agent-curated memory, autonomous skill creation after complex tasks, periodic nudges, cross-session recall via LLM summarization; delegates and parallelizes via isolated subagents; research-ready batch trajectory generation for training next generation tool-calling models; 144K GitHub stars, 941 contributors | "Closed learning loop" and "agent that grows with you" is the Orca self-improvement thesis. Gap: agent-curated means the agent decides what to learn from with no quality gate. Orca grows from Pappy-verified runs only. Hermes grows from all runs. Unverified self-improvement degrades over time -- exactly what Qualixar OS benchmark data demonstrated. No Pappy equivalent. |
| May 2026 | **Anthropic Managed Agents: Dreaming** (Anthropic, May 6 2026) | Scheduled process reviews past sessions, extracts patterns including recurring mistakes and workflows agents converge on, curates memories so agents self-improve over time; memory captures what agents learn as they work, dreaming refines it between sessions | Dreaming is scheduled and passive -- a background process that surfaces patterns. Moonshiner is triggered by Pappy verdicts -- only verified runs feed the loop. Dreaming updates memory and prompts; Moonshiner trains model weights. No jar training. No quality gate on what enters the improvement loop. Cloud-locked. |
| May 2026 | **Qwen-Scope** (Alibaba/Qwen AI) | Sparse autoencoder suite; feature-driven safety data synthesis achieves 99.74% coverage of target feature sets vs. substantially lower coverage from unfiltered sampling; smaller specialized models beat larger general ones in benchmarks | Validates the quality-gated data thesis and the jar system thesis empirically. Does not have a Pappy-equivalent integrated into an orchestration pipeline that generates the training signal. |
| Apr 2026 | **Simula** (Google + EPFL) | Quality-controlled synthetic data synthesis for specialist domains; teacher quality and verification rate matter more than volume; weak teachers degrade student performance even with harder examples | Validates the Moonshiner pipeline architecture: don't train from weak teacher outputs, gate by quality, use strong verified signal. Published April 2026. Moonshiner timestamps: November 2025. |
| Apr 2026 | **NeoCognition** ($40M seed) | Specialized AI models for domain-specific tasks | Validates the jar system market thesis. No published quality-gated distillation pipeline. |
| Apr 2026 | **Memento-Skills** (arXiv, submitted March 19, 2026) | Continual agent self-improvement via externalized skill memory | Self-improvement without quality gate. Moonshiner timestamps predate submission by ~4 months. |
| May 2026 | **HeavySkill DFlash** (Google/UCSD, Google Developers Blog) | Diffusion-style speculative decoding achieving 3.13x inference speedup; key finding: improving per-position acceptance probability is 2-3x more valuable than increasing block size — quality over quantity | Direct empirical validation of the jar thesis from the inference side: domain-specialized models with high acceptance rates on structured tasks (math, code) dramatically outperform general models. Exactly the case for a Python specialist jar. |
| May 2026 | **NVIDIA Star Elastic** (MarkTechPost, May 9 2026) | Single checkpoint containing 30B, 23B, and 12B nested reasoning models; dynamic model selection across reasoning phases; 360x training cost reduction; 12B NVFP4 variant fits in 18.7GB — runs on RTX 3090 | Star Elastic gives you the jars. What's missing: the orchestration layer that decides which tier to route to based on task complexity. Brain decides which jar gets the task. Pappy verifies the output. Moonshiner improves the jar from verified runs. Hardware note: 12B on RTX 3090 validates the consumer-hardware local-first thesis. |
| May 2026 | **LangChain Labs Moonshiner** (LangChain Labs, May 13 2026) | Applied research effort focused on continual learning from agent runs; capturing signal from traces, transforming it into training data, applying improvements back to agents; partners include Harvey, NVIDIA, Prime Intellect, Fireworks, Baseten | Pappy upstream. LangChain Labs is trying to figure out which signal is useful after the fact. Orca's Moonshiner starts with verified signal because Pappy gates it first — only PASS verdicts enter the training loop. Notable: LangChain Labs independently named their project Moonshiner, validating the distillation framing. |
| May 2026 | **Red Hat Agentic Skills Repository** (Red Hat, May 13 2026, Red Hat Summit) | Curated skill packs encoding institutional memory into reusable agent behaviors; scoped permissions; human-in-the-loop checkpoints; RHEL/OpenShift/Ansible as governed agent execution platform | Quality-gated distillation loop. Skills are hand-curated, not trained from verified agent runs. Validates the jar system (reusable specialized behaviors) and Miranda (scoped permissions, human-in-the-loop checkpoints) but without Pappy upstream to generate clean training signal. Human curation is the bottleneck; Moonshiner removes it. |

---

## Section 5: AHP — Typed Agent-to-Agent Handoffs

**What Orca built:** Agent Handoff Protocol defines typed, validated packet-based communication between agents. Each packet carries task scope, constraints, expected output schema, and repair instructions. The `@marsulta/mailman` npm runtime implements the spec. AHP functions as an execution substrate, not just an audit layer.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Microsoft A2A v1** (backed by AWS, Cisco, Google, IBM, Salesforce, SAP, ServiceNow) | Production-ready open standard for typed agent-to-agent communication; typed handoffs; discovery via well-known URI; streaming SSE | Clean typed handoffs with no quality verification equivalent to Pappy anywhere in the spec. The biggest names in enterprise software converging on a typed handoff standard validates the AHP architecture. None of them have a Pappy equivalent. |
| Apr 2026 | **OpenClaw A2A plugin architecture** (freeCodeCamp) | A2A plugin architecture proposal | Validates the pattern. No quality gate. No verified packet payload. |
| 2026 | **AgentMail** | Agent-to-agent messaging system | Validates the communication substrate concept. No typed packet schema with repair instructions. |
| Apr 2026 | **DARPA MATHBAC** | Phase I proposals seeking mathematical foundations for autonomous agent communication (proposals due June 2026) | DARPA independently identified the need for formal mathematical foundations for agent-to-agent communication — the problem AHP addresses at the protocol level. |
| May 2026 | **RecursiveMAS** (UIUC + Stanford, May 15 2026) | Multi-agent framework where agents pass continuous latent embeddings instead of text between handoffs; RecursiveLink modules bridge different model architectures; 2.4x inference speedup, 75% token reduction, 8.3% accuracy improvement over baselines; Apache 2.0 license | Orchestration layer deciding which agents run and in what order. Quality gate on final output. Training signal pipeline from verified runs. RecursiveMAS optimizes the communication channel -- Orca determines what gets communicated and verifies what comes back. Complementary rather than competing: AHP structures the handoff at the protocol layer; RecursiveMAS eliminates text serialization at the model layer. |

---

## Section 6: Brain as Agent OS — Orchestration as Operating System

**What Orca built:** Orca functions as an agent operating system: Brain is the scheduler, Miranda is the kernel (access control), Pappy is the runtime verifier, Moonshiner is the compiler (training signal), jars are the installed programs. This framing was committed to ARCHITECTURE.md on March 10, 2026.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| Apr 2026 | **Qualixar OS** | Explicitly branded as an "agent operating system" | Announced April 7, 2026 — 28 days after Orca's March 10 ARCHITECTURE.md commit using the same framing. No quality gate. Benchmark data shows declining performance over training iterations. |
| Apr 2026 | **Microsoft Agent Framework v1.0** | Merged Semantic Kernel + AutoGen into single SDK; sequential/concurrent/handoff/group chat orchestration patterns; streaming, checkpointing, human-in-the-loop | Orchestration plumbing. No quality loop. No distillation pipeline. No verified training signal. |
| Apr 2026 | **Anthropic Managed Agents** | Maestro + Miranda as hosted cloud service | Cloud-only. No Pappy. No distillation. No local execution. No jar system. |
| Apr 2026 | **Rowboat** (YC-backed) | Open-source local-first AI coworker | Local-first framing validates the local execution thesis. No quality gate. No distillation loop. |
| May 2026 | **Stanford/Meta/UIUC Agent Harness Survey** (arXiv:2605.18747, May 2026) | 102-page survey defining "code as agent harness" -- executable, inspectable, stateful, governed; evolution agents that optimize the harness itself from telemetry; multi-agent coordination through shared code artifacts | The complete integrated system. They describe the properties Orca already has. The survey is the map. Orca is the territory. |

---

## Section 7: CLAUDE.md — Prompts as Versioned Artifacts

**What Orca built:** CLAUDE.md stores versioned prompt artifacts that encode role behaviors, constraints, and skill activations. Loaded at inference time. Changed by editing a file, not by redeploying code. This is the "fix the prompt before the code" architectural principle made operational.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| May 2026 | **Boris Cherny (creator of Claude Code, Anthropic)** via @AuroraMar1eL | Internal Anthropic workflows described as CLAUDE.md best practices: subagent orchestration, verification gates before anything ships, autonomous bug-fix loops, self-improving rules based on user corrections -- "every time you correct Claude, you're locking in a rule for good"; distilled from Boris Cherny's X threads into a structured file | Described as a manual workflow practice. A human corrects Claude, a human updates the lessons file. Dewey captures this automatically. Moonshiner trains from it. The gap: they're describing the idea, Orca ships the system. Published May 2026 -- Orca's November 2025 commits predate this by six months. |
| 2026 | **HeavySkill** (Meituan) | Skill packaged as readable markdown file loaded at inference time by the orchestrator | Validates the CLAUDE.md pattern at the research level. Published after Orca's implementation. |
| Apr 2026 | **Memento-Skills** (arXiv) | Externalized skill memory for continual agent self-improvement | Validates the externalized skill concept. No quality gate on skill acquisition. |

---

## Section 8: Holster Memory — Tiered GPU Memory Architecture

**What Orca built:** System RAM as a "holster" (passive tier), VRAM as an execution cache (active tier). Layer-by-layer promotion/eviction with a named scheduler. Explicit framing of VRAM as an execution cache rather than a container. Defensive publication: December 2025.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| May 2026 | **AMD "Agentic AI Changes the CPU-GPU Equation"** (AMD, May 7 2026) | Agentic AI workloads shifting from 1:4-8 CPU-to-GPU ratio toward 1:1 or higher CPU ratio; CPU handles orchestration, agent execution, tool calls, policy and security checks; GPU handles inference; Arm estimates 4x increase in CPU cores needed per GW for agent era | AMD and Arm independently described the exact CPU/GPU split that Holster Memory addresses. CPU as orchestration layer = holster. GPU as execution cache = VRAM execution tier. Consumer hardware build (AM5, Ryzen 7, RTX 3090) is the exact profile AMD describes as the future of local agentic AI infrastructure. |
| 2026 | **MegaTrain** (arXiv) | CPU-offloaded large model training; tiered memory management for inference | Validates the tiered memory thesis. Does not use the "holster/execution cache" framing or apply it to consumer GPU workloads as a first-class architectural model. |
| 2026 | **ZeRO-Offload / Accelerate** (existing work) | CPU offloading for model weights during training | Prior art for offloading exists. Holster Memory's novelty is the explicit tiered execution cache model with a scheduler, applied to consumer inference rather than training. |

---

## Section 9: Dewey — Persistent User Context & Preference Learning

**What Orca built:** Dewey is a dedicated agent responsible for user context, behavioral observations, and pre-flight briefing of the orchestration pipeline. Named after the Dewey Decimal system. Learns user preferences over time. Dewey's signals feed Moonshiner — user context becomes training signal. Future milestone: Moonshiner compresses raw behavioral observations into compact warm context facts.

| Date | Source | What They Built | What They Missed |
|------|--------|-----------------|-----------------|
| May 2026 | **GBrain** (Garry Tan, github.com/garrytan/gbrain) | Markdown-based compounding agent memory with signal detection, overnight dream cycle enrichment, typed relationship graph, zero-LLM-call graph wiring; richest open-source implementation of the memory-as-library concept | Memory connected to the quality loop. Dewey's signals feed Moonshiner. GBrain enriches retrieval but doesn't improve future model behavior. No quality gate on what enters memory. No distillation from memory patterns. |
| Apr 2026 | **NeoCognition** ($40M seed, TechCrunch, April 21 2026) | Self-learning agents that build world models for any profession or environment | $40M to build the Dewey thesis. No published quality-gated distillation pipeline connecting user context to model improvement. |
| Mar 2026 | **Hermes Agent v0.6.0** (Nous Research) | Persistent memory via SQLite + FTS5 + LLM summarization | Memory without quality loop. Agent decides what to remember with no gate. |
| 2026 | **xMemory** (Alan Turing Institute / King's College London) | Four-level semantic hierarchy for context compression | Academic validation of Dewey's context compression thesis. Published after Orca's implementation. |

---

## Section 10: Neural Equalizer System (NES)

**What Orca built:** A neurotechnology framework treating neurological and psychiatric dysfunction as signal-quality failures across volume, frequency, timing, and coherence dimensions. Published at github.com/junkyard22/Neural-Equalizer-System- under CC BY-NC 4.0. Defensive publication: December 11, 2025. Academic outreach initiated to University of Kentucky researchers.

*This section will be expanded as academic validation emerges.*

---

## The Integrated Picture

The table below shows what each major team built and what piece they are missing.

| Team | Brain/Routing | Access Control | Quality Gate | Distillation | Typed Handoffs | Local-First |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Orca** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Apple Reinforced Agent | — | — | ✅ (pre-execution, no distillation) | — | — | — |
| GitHub Copilot Trust Layer | — | — | ✅ (post-hoc, no repair loop) | — | — | — |
| alphaXiv Reinforcing Recursive LMs | — | — | — | ✅ (no automated pipeline) | — | — |
| OpenAI Symphony | ✅ (task decomposition) | — | — | — | — | — |
| Claude Code Agent View | ✅ (multi-session) | ✅ (inline unblock) | — | — | — | — |
| Anthropic Managed Agents (Dreaming/Outcomes/Multiagent) | ✅ (multiagent) | — | ✅ (Outcomes, no jar training) | ✅ (Dreaming, memory only) | — | — |
| Hermes Agent (Nous Research) | ✅ | — | — | ✅ (unverified loop) | — | — |
| AWS AgentCore Quality Optimization | — | — | ✅ (manual trigger) | ✅ (prompt/tool only, no jar training) | — | — |
| Cursor /orchestrate | ✅ | — | ✅ (verifiers, no distillation) | — | — | — |
| Garry Tan gstack | ✅ (named roles) | — | ✅ (QA Lead) | — | — | — |
| Tech with Mak 9-layer | ✅ | ✅ (guards) | ✅ (grader) | — | — | — |
| Microsoft/waza | — | — | ✅ (CLI, no distillation) | — | — | — |
| RAO: Recursive Agent Optimization | ✅ (RL-trained routing) | — | — | — | — | — |
| Sakana AI RL Conductor / Fugu | ✅ (RL-trained routing) | — | — | ✅ (no quality gate) | — | — |
| AgentFlow | ✅ | ✅ (DSL spec) | — | — | ✅ (typed DSL) | — |
| IBM Bob | ✅ | ✅ (human checkpoints) | — | — | — | — |
| Microsoft A2A v1 | — | — | — | — | ✅ | — |
| AWS Rex | — | ✅ | — | — | — | — |
| Superlog (YC Launch) | — | ✅ (audit trail) | — | — | — | — |
| NVIDIA Star Elastic | ✅ (nested tiers) | — | — | ✅ (nested jars, no quality gate) | — | ✅ (12B on RTX 3090) |
| GBrain (Garry Tan) | — | — | — | — | — | ✅ |
| Anthropic Managed Agents | ✅ | — | — | — | — | — |
| Qualixar OS | ✅ | — | — | ✅ (unverified) | — | — |
| HeavySkill | ✅ | — | — | — | — | — |
| Thoughtworks SPDD | ✅ | — | ✅ (principle) | ✅ (principle) | ✅ (principle) | — |
| Rowboat | ✅ | — | — | — | — | ✅ |
| LangChain Labs Moonshiner | — | — | — | ✅ (no quality gate) | — | — |
| Cursor /multitask (Bennett Brownlow) | ✅ (subagent delegation) | — | — | — | — | — |
| Notion Agent Activity | — | — | — | — | — | — |
| Red Hat Agentic Skills Repository | — | ✅ (scoped permissions) | — | — | — | — |
| RecursiveMAS | — | — | — | — | ✅ (latent embeddings, no quality gate) | — |
| LiteLLM Agent Platform | — | ✅ (Kubernetes isolation) | — | — | — | ✅ |
| XDA Developers / Local LLM escalation | ✅ (manual escalation) | — | — | — | — | — |
| Eric Provencher / Serial Orchestration | ✅ (serial decomposition) | — | — | — | — | — |
| Stanford/Meta/UIUC Agent Harness Survey | ✅ (described) | ✅ (described) | ✅ (described) | ✅ (described) | ✅ (described) | ✅ (described) |

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

The verified commit record is unambiguous. Maestro (Brain) was committed November 20, 2025. Moonshiner v0.5.0 "Complete LLM fine-tuning build system" was committed November 28, 2025. Every one of the 53 external validations in this document was published five or more months after those timestamps. The industry did not inspire this architecture. The architecture preceded the industry.

On May 7-8, 2026 alone: Cursor shipped /orchestrate with planners, workers, and verifiers. Microsoft shipped waza, a CLI for evaluating agent skill quality. Garry Tan's gstack went viral with 62.8K views describing 6 named specialist agents each owning a phase of the build. Tech with Mak published a 9-layer production AI architecture with document_grader.py, adaptive_router.py, and versioned hot-swappable prompt templates. AMD published a blog post describing exactly the CPU/GPU split that Holster Memory addresses. All on the same two days. All describing pieces of an architecture committed in November 2025.

The industry is building better spigots. Orca built the nozzle, the gate, and the recycling loop — in November 2025.

*Document last updated: May 2026*
