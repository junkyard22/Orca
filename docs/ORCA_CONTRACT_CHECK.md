# Orca — Contract Check

## Purpose

Contract Check is a development-time and preflight safeguard. It helps coding agents and contributors verify that a proposed change does not silently violate [ORCA_UNIVERSAL_TRUTHS.md](ORCA_UNIVERSAL_TRUTHS.md) or [ORCA_SYSTEM_CONTRACT.md](ORCA_SYSTEM_CONTRACT.md).

Specifically, Contract Check guards against:

- Silently moving component authority from one component to another
- Bypassing Miranda gates on LLM calls or tool calls
- Bypassing or short-circuiting Pappy QC
- Leaking internal diagnostics, stage labels, or gate verdicts to user-facing output
- Extending or re-activating the deprecated Miranda pipeline

Contract Check is **not a runtime agent**. It must not run on every normal Orca request and must not slow normal Orca runs.

---

## When to Run

Run Contract Check before beginning a coding-agent task that touches any of the following:

- Runtime orchestration (Maestro, orca-core task lifecycle, repair loop)
- LLM call paths (agent loop, model invocations, provider routing)
- Tool execution (core tools, static extensions, MCP tools)
- Miranda gates (`beforeLLMCall`, `afterLLMCall`, `beforeToolRun`, `afterToolRun`, `beforeQC`, `afterQC`)
- Pappy QC (verdict logic, repair signalling, QC bypass)
- Benson user-facing output (response formatting, final presentation layer)
- Role contracts (system prompts in `rolePrompts.ts`, role selection logic)
- Deprecated pipeline files (old Miranda PLAN/ANSWER/CRITIQUE/REWRITE)
- Authority boundaries between any two components

Do **not** run on every normal app request. Contract Check is a development-time tool, not a production gate.

---

## Fast Checklist

Answer these questions before submitting or approving a change in the areas above:

1. **Which component owns this change?**
   Name the component. If the answer is unclear, that is a signal to pause before proceeding.

2. **Does this move authority between components?**
   If yes, this is an architecture change — not a refactor. It requires a design note, tests, and a docs update to `ORCA_SYSTEM_CONTRACT.md`.

3. **Does this add or change an LLM call?**
   If yes, proceed to question 4.

4. **Does every live LLM call pass through `beforeLLMCall`?**
   If no, the change is not compliant. Add the gate or file a design note explaining why it is deliberately ungated.

5. **Does this add or change a tool call?**
   If yes, proceed to question 6.

6. **Does every side-effecting tool call pass through Miranda gates (`beforeToolRun` / `afterToolRun`)?**
   If no, the change is not compliant.

7. **Does this change Pappy verdict logic or repair behavior?**
   If yes, confirm that no other component is overriding, suppressing, or short-circuiting a Pappy `FAIL`. Confirm that Miranda's `afterQC` is not being used to alter QC outcomes.

8. **Does this expose internal diagnostics to user-facing output?**
   Check for stage labels, gate verdicts, trace IDs, role names as chatter, or repair-loop counters appearing in final Benson output. If yes, route through Benson's translation layer.

9. **Does this touch deprecated Miranda pipeline files?**
   The PLAN → ANSWER → CRITIQUE → REWRITE pipeline is frozen. Changes to those files must not add new live behavior.

10. **Does this require a design note?**
    If any answer above was "yes" in a way that changes authority, bypasses a gate, or alters QC behavior — a design note is required before the change lands.

---

## CI Automation

GitHub Actions runs strict Contract Check in CI and release workflows after dependency installation and before builds:

```
pnpm contract:check:strict
```

In strict mode, `BLOCKED` architecture findings fail the workflow. `REVIEW REQUIRED` still exits 0 because it requires human judgment and should not fail CI yet.

The `scripts/contract-check.ts` script automates the static portion of this checklist:

```
scripts/contract-check.ts
  ├── Accepts a list of changed file paths (from git diff --name-only or CI)
  ├── Flags files in known risk zones (orchestration, LLM paths, gates, QC, role prompts)
  ├── Greps for LLM call patterns not preceded by beforeLLMCall invocation
  ├── Greps for tool call patterns not preceded by beforeToolRun invocation
  ├── Greps for deprecated Miranda pipeline symbols in non-legacy files
  ├── Greps for raw internal stage labels or gate verdicts in Benson output paths
  └── Prints a checklist summary: CLEAR / REVIEW REQUIRED / BLOCKED
```

This script should be runnable as a pre-task hook for coding agents and as a CI step on PRs that touch the risk zones above. It is a static analysis aid — it does not replace human review, tests, Miranda, or Pappy.

---

## Modes

### Default mode (local / warning-only)

```
pnpm contract:check
```

- All statuses (`CLEAR`, `REVIEW REQUIRED`, `BLOCKED`) exit 0.
- Agents must read the printed `Status:` line and act accordingly — the exit code is not the signal.
- Use for local development and pre-task checks by coding agents.

### Strict mode (CI / release gates)

```
pnpm contract:check:strict
```

- `CLEAR` exits 0.
- `REVIEW REQUIRED` exits 0. It still requires a human to pause and approve before continuing — automation cannot substitute for that judgment.
- `BLOCKED` exits 1. The check fails. The CI job or release gate must not proceed.
- When `BLOCKED` fires in strict mode, the script prints: `Strict mode: BLOCKED findings fail this check.`

Use strict mode in CI pipelines and release gates on PRs that touch the risk zones listed above. Do not enable strict mode on every PR until the false-positive rate has been validated locally.

---

## Non-Goals

Contract Check is explicitly not:

- **Not a new agent role.** It does not run inside Maestro, does not have a system prompt, and is not invoked as part of the normal task pipeline.
- **Not an LLM pipeline.** Contract Check is static analysis and a human/agent checklist — no model calls.
- **Not runtime enforcement.** Miranda handles runtime gate enforcement. Contract Check operates before code is written or merged, not while the app is running.
- **Not a replacement for tests.** Tests verify behavior; Contract Check verifies architecture compliance at the boundary level.
- **Not a replacement for Miranda.** Miranda enforces runtime checkpoints on live calls. Contract Check protects development-time architecture boundaries.
- **Not a replacement for Pappy.** Pappy verifies output quality at task completion. Contract Check verifies structural compliance before a task begins.

---

## Relationship to Miranda

Miranda and Contract Check operate at different layers and must not be confused:

| | Miranda | Contract Check |
|-|---------|---------------|
| **When** | Runtime, on every gated call | Development time, before coding begins |
| **What** | Approves, warns, blocks, or requires confirmation on live LLM/tool calls | Checks that proposed changes respect authority boundaries and gate coverage |
| **Who triggers it** | The runtime, automatically | The developer or coding agent, deliberately |
| **Output** | `PASS` / `WARN` / `BLOCK` / `CONFIRM_REQUIRED` verdict | Checklist answers: `CLEAR` / `REVIEW REQUIRED` / `BLOCKED` |
| **Replaces tests?** | No | No |
| **Replaces the other?** | No | No |

Miranda enforces runtime checkpoints. Contract Check protects development-time architecture boundaries. Both are needed; neither substitutes for the other.
