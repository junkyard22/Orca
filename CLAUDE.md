# Orca Agent Instructions

> **Architectural invariants** are defined in [docs/ORCA_UNIVERSAL_TRUTHS.md](docs/ORCA_UNIVERSAL_TRUTHS.md). Instructions here must not contradict them. When they appear to conflict, the Universal Truths win.
>
> **Whole-program contract** — component authority boundaries, runtime order, side-effect rules, and change-control requirements — are defined in [docs/ORCA_SYSTEM_CONTRACT.md](docs/ORCA_SYSTEM_CONTRACT.md).

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
