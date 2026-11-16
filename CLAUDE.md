# Orca Agent Instructions

> **Architectural invariants** are defined in [docs/ORCA_UNIVERSAL_TRUTHS.md](docs/ORCA_UNIVERSAL_TRUTHS.md). Instructions here must not contradict them. When they appear to conflict, the Universal Truths win.
>
> **Whole-program contract** — component authority boundaries, runtime order, side-effect rules, and change-control requirements — are defined in [docs/ORCA_SYSTEM_CONTRACT.md](docs/ORCA_SYSTEM_CONTRACT.md).
>
> **Development-time contract check** — before starting a coding task that touches orchestration, LLM call paths, tool execution, Miranda gates, Pappy QC, or role contracts, run the checklist in [docs/ORCA_CONTRACT_CHECK.md](docs/ORCA_CONTRACT_CHECK.md).

## Project State

[PROJECT_STATE.md](PROJECT_STATE.md) is the shared handoff between sessions and machines.

- **At the start of a session:** read it before doing anything else. Check its branch table against `git branch -a`, `git worktree list` and `git status`; if they disagree, trust git and say so.
- **At the end of a session** (before your final report, and before ending any session that changed code, branches or tests): update it.
  - Refresh **Last updated**, the machine, and the branch table (head commit, pushed or not, uncommitted work).
  - Move fixes into **Implemented and verified** only when you confirmed them in the code and tests — never from a commit message or someone's report alone. Reported-but-unchecked work goes under **Unverified**, naming who reported it.
  - Update **Outstanding problems**: close what you fixed (with the commit), add what you found.
  - Record **Last verified tests** only for commands you actually ran in this session: date, commit, machine, command, exact result. Don't carry forward results you didn't re-run; leave the previous row with its own date.
  - Add one line to the **Session log** (newest first, keep the last 10).
- Commit the update with the session's other changes. If nothing else changed, commit it on its own (`docs: update PROJECT_STATE`).
- Never record secrets, API keys, or personal paths in it.

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

## Workspace Authority, Shell Execution and Evidence

Details: [ARCHITECTURE.md](ARCHITECTURE.md#workspace-authority-shell-execution-and-execution-evidence). Rules for anyone changing this code:

- **Workspace authority is Miranda's and is structured.** The workspace root comes from the host's configuration or an explicit `context.workspaceRoot`, never from message text or tool arguments. Filesystem tools are refused (`workspace_required`) without a usable root. Do not add a fallback to `process.cwd()` or any other directory.
- **Path arguments are validated through links.** Keep every path-bearing argument inside the check; do not accept a JSON string in place of an array or object.
- **Shell execution is not sandboxed. Do not say or imply that it is.** `run_command` and MCP process tools are host processes with the user's access; the working directory is not a boundary. `tools/sandbox.ts` is a command policy that decides what may run without asking, not a confinement.
- **Unattended shell execution is limited to confined reads** (no shell syntax, a listed single-purpose reader, every operand inside the workspace) and host-configured allowances. Do not widen this by pattern-matching command strings; anything that cannot be vouched for goes to the user with the host-access warning, or does not run.
- **Approval is authorization, not isolation, and never session-wide for host-scoped tools.** Each execution of `run_command` or an MCP process tool gets its own approval request, bound to its exact arguments; the card must say the tool is not sandboxed and show every argument. Do not add "always approve", per-tool or per-session approval for these tools, and do not cache approvals. Denial, timeout, Stop and a missing handler fail closed.
- **Record authority and evidence on the tool event.** `_execAuthority` and `_fsEvidence` are written by the agent loop only. Underscore-prefixed keys in a model's tool arguments are dropped from the record; never copy model arguments into the record unfiltered.
- **Evidence has a scope.** `no_change` means no change among the watched workspace files (Git-ignored files, dependency/build directories and everything outside the workspace are not watched). Never present it as proof that nothing changed, and never credit a file change from a tool's `ok`, its output, or a model's claim.
- **Pappy judges; evidence informs.** Recorded evidence is input to Pappy. It does not replace, soften or override a Pappy verdict.

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
