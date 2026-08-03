# Miranda Core

Miranda is Orca's compliance gate layer. In the live Orca runtime, Miranda validates whether calls may proceed and records diagnostics. Miranda is not the response pipeline and is not the quality verifier.

## Architecture Lock

Rules:

- Miranda is a gate, not a pipeline.
- Miranda does not plan, answer, critique, rewrite, synthesize, or judge output quality.
- The deprecated Miranda multi-stage PLAN -> ANSWER -> CRITIQUE -> REWRITE pipeline is legacy. Do not extend it for live Orca behavior.
- Live LLM calls must pass through `beforeLLMCall` and `afterLLMCall`.
- Tool execution must pass through `beforeToolRun` and `afterToolRun`.
- Every Pappy QC invocation must receive `beforeQC` approval, then pass through `afterQC` for diagnostics and checkpointing.
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

## Live Gate API

Use `createMirandaGate()` for live Orca runtime wiring.

Checkpoint methods:

- `beforeLLMCall(ctx)` checks the LLM call context before the provider call.
- `afterLLMCall(ctx, output, validation)` validates output shape after every live provider call.
- `beforeToolRun(ctx)` validates tool allowlists, argument shape, protected paths, and workspace containment before execution. Live callers should provide `workspaceRoot` in the tool gate context.
- `afterToolRun(ctx, result)` records/validates tool receipts after execution.
- `beforeQC(ctx)` validates that output is present before Pappy QC.
- `afterQC(ctx, verdict, issueCount)` records diagnostics after Pappy returns its verdict.

`afterQC` is diagnostic-only in the current architecture. It must not override Pappy, downgrade `FAIL`, skip repair, or change final verdict logic.

## Legacy Pipeline

This package still contains older pipeline modules and exports such as `runPipeline()`, `createDefaultConfig()`, stage contracts, model routing helpers, and cost utilities. Those exist for compatibility and tests. They are not the live Orca task path.

Do not add new live behavior to the legacy pipeline. New compliance, permission, checkpoint, or budget-gate work belongs in the gate path, primarily `src/gate/mirandaGate.ts` and the runtime call sites that supply gate context.

## Development Guardrails

- If adding a live LLM call, add a distinct `beforeLLMCall` stage label.
- If adding a live tool path, route it through `beforeToolRun` and `afterToolRun`.
- If adding QC observability, route it through `afterQC` and keep Pappy in charge of quality verdicts.
- If adding real budget enforcement, first wire live cost accounting into gate context. Do not treat neutral placeholder values as enforcement.
- Budget exhaustion must never convert an unresolved Pappy `FAIL` into `WARN`.
