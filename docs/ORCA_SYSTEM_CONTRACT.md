# Orca — System Contract

## Purpose

This document defines Orca's whole-program contract: the runtime relationships between components, their authority boundaries, the order in which they operate, and the change-control expectations that keep the system coherent. It turns the abstract invariants in `ORCA_UNIVERSAL_TRUTHS.md` into concrete, runtime-level rules.

Implementers, reviewers, and future contributors should treat this document as the authoritative answer to: "Who owns this, and what are they allowed to do?"

---

## Relationship to Universal Truths

[docs/ORCA_UNIVERSAL_TRUTHS.md](ORCA_UNIVERSAL_TRUTHS.md) is the higher authority. This contract may not contradict it. When they appear to conflict, the Universal Truths win and this document must be corrected.

---

## Canonical Runtime Order

```
User input
  └── Benson              parse conversation context; prepare task handoff
        └── Secretary     translate raw intent into structured task spec
              └── Maestro   orchestrate the task; engage Brain for routing
                    ├── Brain           plan and assign roles
                    ├── Dewey           provide/update context as needed
                    ├── Miranda gates   approve/block each LLM call and tool call
                    ├── Workers/tools   execute assigned, gated work
                    └── Pappy QC        verify output; PASS / WARN / FAIL
  └── Benson              format and deliver final user-facing response
```

The exact call graph of a given implementation may vary (eager vs. lazy context fetch, parallel vs. sequential role execution, etc.). The authority boundaries must not vary. Each component's lane is fixed regardless of execution shape.

---

## Component Responsibilities

### Benson
The user-facing voice of Orca. Owns the conversation boundary in both directions: interprets what the user said (in coordination with Secretary) and presents what the system produced. No other component writes the final user-facing output.

### Secretary
Translates raw user input into a structured task spec (intent, scope, constraints, parameters). Downstream components receive a parsed spec; they do not re-parse or reinterpret user intent.

### Maestro
The orchestration engine. Routes tasks to the right roles, manages the agent loop, coordinates multi-step work, and handles repair-loop retries when Pappy fails output. Maestro does not execute work itself.

### Brain
Plans and routes. Decomposes a task into sub-tasks, decides which roles handle which parts, and emits a routing plan. Brain does not execute work and does not self-certify final output quality.

### Dewey
Stewards session context. Maintains, retrieves, and manages context across a session so workers and Brain have the information they need. Components that need context request it from Dewey; they do not own or mutate context independently.

### Miranda
Miranda is the compliance officer of the team. She enforces rules at checkpoints; she does not run the team.

Miranda approves, warns, blocks, or requires confirmation at defined gates. That is the full extent of her authority. She does not replace Brain (planning), Pappy (quality), Benson (user voice), Maestro (orchestration), or any worker (execution). She cannot plan, execute work, judge output quality, or become the user-facing voice.

Miranda enforces boundaries; she does not perform the work inside the boundary.

In concrete terms: the compliance, permission, budget, and safety gate layer. Approves or blocks LLM calls and tool calls; records post-QC diagnostics.

### Workers
The execution layer inside Maestro: `strong_model`, `cheap_model`, `narrator`, `reviewer`, `debugger`, `utility`, `vision`, `reader`, `planner_deep`. Workers execute assigned, scoped tasks. They do not route, gate, orchestrate, or verify final quality.

### Tools
The side-effect mechanism. Tools (core workbench tools, static extensions, MCP servers) perform actions with real-world consequences: file writes, shell commands, network calls. Every tool call must pass through Miranda's `beforeToolRun` / `afterToolRun` gates.

### Pappy
The quality verifier. Produces the authoritative PASS / WARN / FAIL verdict on worker output. No other component may override, suppress, or short-circuit a Pappy FAIL. Pappy does not repair output; it signals repair to Maestro.

### Moonshiner
Trains and improves role behavior using verified traces — traces that have passed Pappy QC. Moonshiner does not alter live system behavior unless explicitly wired into the runtime by a deliberate design decision.

---

## Authority Matrix

| Action | Benson | Secretary | Maestro | Brain | Dewey | Miranda | Workers | Tools | Pappy | Moonshiner |
|--------|:------:|:---------:|:-------:|:-----:|:-----:|:-------:|:-------:|:-----:|:-----:|:----------:|
| Interpret user-facing communication | **Yes** | — | — | — | — | — | — | — | — | — |
| Translate intent into task spec | — | **Yes** | — | — | — | — | — | — | — | — |
| Coordinate runtime flow | — | — | **Yes** | — | — | — | — | — | — | — |
| Plan and route work | — | — | — | **Yes** | — | — | — | — | — | — |
| Provide session context | — | — | — | — | **Yes** | — | — | — | — | — |
| Approve / block LLM calls | — | — | — | — | — | **Yes** | — | — | — | — |
| Approve / block tool calls | — | — | — | — | — | **Yes** | — | — | — | — |
| Execute tools (side effects) | — | — | — | — | — | — | — | **Yes** | — | — |
| Judge output quality | — | — | — | — | — | — | — | — | **Yes** | — |
| Trigger or recommend repair | — | — | **Yes** ¹ | — | — | — | — | — | **Yes** ² | — |
| Produce final user-facing output | **Yes** | — | — | — | — | — | — | — | — | — |
| Train / improve role behavior | — | — | — | — | — | — | — | — | — | **Yes** |

¹ Maestro manages the repair loop; it acts on Pappy's signal.
² Pappy signals FAIL; Maestro decides whether and how to repair.

---

## Cross-Component Boundary Rules

**Miranda is the compliance officer of the team, not its manager.** Miranda enforces rules at checkpoints — she does not run the team. She approves, warns, blocks, or requires confirmation. She does not replace Brain, Pappy, Benson, Maestro, or any worker. She cannot plan, execute, judge quality, or speak to the user. Miranda enforces boundaries; she does not perform the work inside the boundary.

**Miranda is a gate, not a pipeline.** Miranda's job is to approve or block. It does not produce answers, critique output, rewrite responses, or coordinate workflow. Any Miranda behavior that looks like planning, answering, or quality judgement is out of bounds.

**Pappy is the quality verifier, not Miranda.** Miranda's `afterQC` checkpoint records diagnostics. It does not change, downgrade, or override the Pappy verdict. The Pappy FAIL is final from a quality standpoint; Miranda must not suppress it.

**Brain plans but does not self-certify final quality.** Brain's routing plan is an input to execution, not a guarantee of output correctness. Pappy verifies the finished result.

**Benson is the only normal user-facing voice.** Role chatter, gate verdicts, trace IDs, repair-loop state, and internal stage labels are not user-facing output. Benson translates outcomes; it does not pass raw system signals through to the user.

**Workers execute scoped tasks and do not own orchestration.** A worker may flag a concern in its output. It may not reroute, gate, or modify another component's output. Workers are hired hands, not coordinators.

**Moonshiner trains from verified traces and does not alter live behavior unless explicitly wired.** Moonshiner consumes traces after the fact. It has no live authority over task execution, routing, or output unless a deliberate design decision connects it to the runtime.

**No final completion should claim success without verification when QC is required.** If Pappy QC is part of the task lifecycle, a response that bypasses or short-circuits QC must not be presented to the user as a successful completion.

---

## Side-Effect Rules

A side effect is any action that modifies state outside the current in-memory task: writing a file, running a shell command, calling a network endpoint, invoking an MCP tool, or destroying/overwriting existing data.

All side effects must be routed through approved Miranda gates before execution. This applies to:

- File writes (`write_file` and equivalents)
- Shell / terminal commands (`run_command` and equivalents)
- MCP tool calls (`desktop-commander_*`, `github-mcp_*`, and any future MCP server tools)
- Networked tools (web fetch, API calls)
- Destructive actions (delete, overwrite, truncate)
- Provider / model calls where Miranda gate coverage is enabled

There are no categories of side effect that are pre-approved to bypass Miranda. If a gate does not yet exist for a new class of side effect, the correct response is to add the gate — not to proceed without one.

---

## Quality and Repair Rules

Pappy owns quality verdicts. The three valid outcomes are:

| Verdict | Meaning |
|---------|---------|
| `PASS` | Output meets quality criteria. Continue. |
| `WARN` | Output has issues but is acceptable. Continue with diagnostic. |
| `FAIL` | Output does not meet criteria. Maestro should trigger repair. |

Miranda's `afterQC` checkpoint may record diagnostics and trace state after Pappy issues its verdict. It must not:

- Downgrade a Pappy `FAIL` to `WARN` or `PASS`
- Skip the repair loop that a `FAIL` would normally trigger
- Alter final QC behavior in any way

Any future design that grants Miranda influence over QC outcomes requires an explicit design document, tests, and an update to this contract.

---

## Failure and User-Facing Rules

`gate_blocked`, `repair_exhausted`, `budget_exceeded`, `confirm_required`, and similar are **internal diagnostic states**. They are controlled-stop signals for the runtime, not phrases for the user.

Benson is responsible for translating internal failure states into user-safe language. The translation should be honest (prefer honest failure over false success) without exposing implementation internals.

The following must not appear in normal user-facing output:
- Internal stage labels (`agent_loop_main_stream`, `maestro_brain_route_complete`, etc.)
- Gate verdicts in raw form (`BLOCK`, `gate_blocked`)
- Role names used as diagnostic chatter
- Trace IDs, run IDs, repair-loop counters
- Raw Miranda checkpoint metadata

These signals may be exposed in debug mode when the user has explicitly requested verbose or diagnostic output.

---

## Legacy Rules

The deprecated Miranda PLAN → ANSWER → CRITIQUE → REWRITE multi-stage pipeline is frozen. It must not be extended, re-activated, or used as a template for new live Orca behavior. Any code that implements this pipeline exists for historical reference only.

---

## Change-Control Rules

A change that moves authority from one component to another is an **architecture change**, not a refactor. It requires:

1. An explicit design note explaining what is moving, why, and what the new boundary is.
2. Tests that verify the new authority boundary holds.
3. A docs update to this contract reflecting the new component responsibilities and authority matrix.
4. A corresponding update to [ORCA_UNIVERSAL_TRUTHS.md](ORCA_UNIVERSAL_TRUTHS.md) if an invariant is affected.

Routine refactors, bug fixes, new roles, new tools, and provider swaps do not require changes here unless they cross an authority boundary.
