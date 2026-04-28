# Orca Agent Instructions

> **Architectural invariants** are defined in [docs/ORCA_UNIVERSAL_TRUTHS.md](docs/ORCA_UNIVERSAL_TRUTHS.md). Instructions here must not contradict them. When they appear to conflict, the Universal Truths win.
>
> **Whole-program contract** — component authority boundaries, runtime order, side-effect rules, and change-control requirements — are defined in [docs/ORCA_SYSTEM_CONTRACT.md](docs/ORCA_SYSTEM_CONTRACT.md).
>
> **Development-time contract check** — before starting a coding task that touches orchestration, LLM call paths, tool execution, Miranda gates, Pappy QC, or role contracts, run the checklist in [docs/ORCA_CONTRACT_CHECK.md](docs/ORCA_CONTRACT_CHECK.md).

## Contract Check

`pnpm contract:check` is the development-time approval gate for architecture-sensitive changes. Run it before beginning any coding task that touches orchestration, LLM call paths, tool execution, Miranda gates, Pappy QC, Benson output, role contracts, or system contract documents.

**Status meanings — the printed status is the authoritative signal:**

| Status | Required action |
|--------|----------------|
| `CLEAR` | No findings. Continue automatically. |
| `REVIEW REQUIRED` | Pause. Summarise the findings for the user and wait for explicit approval before continuing. |
| `BLOCKED` | Stop. Fix the issue or request an explicit user override. Do not proceed with the coding task. |

**Modes:**

| Command | When to use | BLOCKED exit code |
|---------|-------------|-------------------|
| `pnpm contract:check` | Local development, pre-task agent checks | 0 (warning-only) |
| `pnpm contract:check:strict` | CI pipelines, release gates | 1 (fails the check) |

**Exit-code rule:** In default mode all statuses exit 0 — read the printed `Status:` line, not the exit code. In strict mode `BLOCKED` exits 1; `REVIEW REQUIRED` exits 0 in both modes because it requires human judgment that automation cannot substitute.

Contract Check is development-time approval control, not runtime enforcement. It does not run on normal Orca requests and has no effect on the production pipeline. Miranda handles runtime gate enforcement; Contract Check protects architecture boundaries before code is written or merged.

## Miranda Architecture Lock

Miranda is the compliance officer of the team. She enforces rules at checkpoints; she does not run the team. Miranda can approve, warn, block, or require confirmation. She cannot plan, execute work, judge output quality, or become the user-facing voice. She does not replace Brain, Pappy, Benson, Maestro, or any worker.

Miranda enforces boundaries; she does not perform the work inside the boundary.

Miranda is Orca's compliance gate layer, not a response pipeline.

Rules:

- Miranda does not plan, answer, critique, rewrite, synthesize, or judge output quality.
- The deprecated Miranda multi-stage PLAN -> ANSWER -> CRITIQUE -> REWRITE pipeline is legacy. Do not extend it for live Orca behavior.
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

## Where Miranda Is Wired Today

Live LLM call stages:

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

Do not implement Step 4B behavior or Miranda QC override behavior without an explicit design document.
