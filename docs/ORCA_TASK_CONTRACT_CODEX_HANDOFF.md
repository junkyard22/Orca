# Orca — Task Contracts: implementation handoff

**For:** the coding agent implementing [ORCA_TASK_CONTRACT_DESIGN.md](ORCA_TASK_CONTRACT_DESIGN.md).
**Baseline:** `main` at `2475092`. Re-check line numbers before editing; they drift.

> **Revised 2026-11-16 after adversarial review** (design §14). Assignment scopes changed: 1 is narrower, 1b is new and conditional, 4 now carries the permission change, 8 deletes `extractPermissions`. Tests T1–T15 are defined in design §14 and assigned below.

Do the assignments **in order, one per branch and pull request**. Each is small enough to review alone and leaves `main` releasable. Do not start an assignment until the previous one is merged.

---

## Rules for every assignment

1. **Read first:** `CLAUDE.md`, `PROJECT_STATE.md`, the design document, then only the files the assignment names.
2. **Contract check:** run `pnpm contract:check` before coding. `CLEAR` → continue. `REVIEW REQUIRED` → stop, summarise the findings, wait for a human. `BLOCKED` → stop.
3. **Tests first.** Write the regression tests named in the assignment, run them, and confirm they fail for the stated reason before changing behaviour. Record the before/after counts.
4. **Scope.** Change only the files listed. No renames, reformatting, dependency changes or "while I'm here" edits. If a listed file needs a change the assignment did not foresee, stop and report.
5. **Never:**
   - add a fallback to `process.cwd()` or any workspace not explicitly established;
   - let anything Brain or a worker writes add a capability, permission or approval;
   - count a worker's statement, a tool's `ok`, or tool output as evidence of a change or an inspection;
   - describe shell execution as sandboxed;
   - weaken, skip or delete an existing test to get green (changing a test that asserted behaviour the assignment removes is allowed — say which and why in the commit);
   - add a model call, a provider-specific API, or a hardcoded model name.
6. **Validation, every assignment:**
   - the new tests, then the test suite of each package touched (`npx vitest run` in that package);
   - `pnpm -r build`;
   - `pnpm -r exec tsc --noEmit` and `pnpm typecheck:scripts`;
   - `pnpm contract:check:strict`.
   Do not run benchmarks or unrelated suites.
7. **Known failures:** three tests in `packages/workbench-core/src/tools/survivingProcesses.test.ts` fail on hosts whose PID 1 does not reap orphans. They are not yours; report them separately and do not touch them.
8. **Desktop type shims:** when you export something new from `orca-core`, `miranda-core` or `maestro-core` that the desktop imports, update `apps/desktop/src/types/*.d.ts` in the same commit.
9. **Finish:** update `PROJECT_STATE.md` as `CLAUDE.md` describes, commit, push the branch, open the pull request only if asked. Never merge or deploy.
10. **Stop conditions (all assignments):** contract check not `CLEAR` without approval; a required change outside the listed files; an existing test fails for a reason you cannot tie to the assignment; the design and the code disagree in a way the assignment does not resolve. Report and wait.

Legend: **[DEFECT]** = reproduced in the November audit; **[DESIGN]** = improvement proposed by the design.

---

## Assignment 0 — Contract types and pure builders **[DESIGN]**

**Goal:** introduce the types and two pure functions. No behaviour changes anywhere.

**Files**
- Add `packages/orca-core/src/taskContract.ts` — the interfaces in design §3.1; `validateContractProposal(raw: unknown): BrainContractProposal` (throws with a reason string); `buildTaskContract(input): TaskContract` implementing §3.3; `buildFallbackContract(task, workspaceStatus, ceiling): TaskContract` implementing §3.4.
- Add `packages/orca-core/src/delivery.ts` — `DeliveryEnvelope` and `buildDeliveryEnvelope({ contract, result, qcResult, lifecycle, workspaceAuthority })` implementing the table in design §5.8. Status lines are fixed strings in this file.
- Add `packages/orca-core/src/taskContract.test.ts`, `delivery.test.ts`.
- Edit `packages/orca-core/src/index.ts` — export the new symbols.

**Behaviour**
- `buildTaskContract` takes `{ task, proposal, ceiling: CapabilityGroup[], workspace: WorkspaceAuthorityStatus, workspaceRoot?: string, attachedFiles?: boolean }`.
- Kind floor and dispute tripwire (design §3.3 rules 8 and 9): raise `conversation` to `inspect` when the request names a path that exists inside `workspaceRoot` or `attachedFiles` is true; set `kindDisputed` when `classifyTaskKind(request)` reports a change kind and the proposal is `conversation`, `inspect` or `execute`. Neither rule ever makes a capability available.
- `buildDeliveryEnvelope` must work with no contract and with no Pappy verdict (design R12), and takes `refusals` (from the authorization record) and blocked/unknown tool events to fill `notDone`.
- Kind-implied outcomes, relatedness (reuse `relatesToRequest` from `acceptanceContract.ts`), path bounding (reject absolute paths, `..`, and paths that resolve outside `workspaceRoot` through links), `prohibits` over `needs`, kind narrowing, `evidence` derivation — all as §3.3.
- `acceptance` is produced by the existing `buildAcceptanceContract`; do not reimplement it.
- The returned object is frozen (`Object.freeze`, deep).

**Tests (must cover)** design matrix B1–B10, plus: frozen result; `prohibits` wins; kind floor (existing path raises, non-existent path does not, a path outside the workspace does not); dispute flag; each row of the §5.8 table including `inspected` and the disputed row; `failed` and `blocked` envelopes always carry non-empty `status`; envelope with no contract / no verdict (T13, pure part).

**Must not change:** any existing file except `index.ts`. No caller uses the new functions yet.

**Done when:** new tests pass; every existing test passes unchanged; contract check `CLEAR`.

---

## Assignment 1 — Intake recognises only social messages **[DEFECT F-01]**

**Goal:** Benson's conversational shortcut applies only to closed-form social messages. Nothing else in intake changes.

**Files**
- `packages/benson-core/src/classify.ts`
- Tests: add `packages/benson-core/src/routingCorpus.test.ts`; adjust existing `benson-core` tests only where they assert the removed patterns.

**Behaviour**
- `CONVERSATIONAL_PATTERNS`: delete the seven open-ended patterns (the block after the comment "Opinion / discussion questions", currently `classify.ts:35-41`). Keep the anchored social patterns above it unchanged.

**Tests first — must fail before the change**
- The five audit messages are not `CONVERSATIONAL`: "Why is the login test in auth.test.ts failing?", "Can you explain how the auth module in this repo works?", "What is in package.json?", "Tell me about the retry logic in src/http.ts", "How does it handle cancellation in runtime.ts?".
- Social messages ("hi", "thanks!", "ok", "sounds good") remain `CONVERSATIONAL` (guard).
- A corpus table (at least 40 rows: social, codebase questions, general questions, edits, mixed, ambiguous) with the expected class for each.
- T2 (guard): "What is in package.json?" still yields read-only inferred permissions — this assignment must not change them.

**Must not change:** `intent.ts` (`extractPermissions`, `isProjectAuditRequest`, `extractIntent` all stay); `NEEDS_CLARIFICATION` rules; `claire-core`; the runtime; Miranda.

**Why permissions are not touched here (design R1):** removing the inference now would leave read-shaped requests with write access until assignment 4. Do not "tidy" it.

**Expected side effect to state in the PR:** general questions such as "What is a monad?" now go to the pipeline (Brain + worker + the existing narrator rewrite) until assignment 3 gives them the short path. Slower for one step; accepted. Do not work around it here.

---

## Assignment 1b — Remove the keyword audit trigger **[DEFECT F-05, audit half] — only if decision D3 is authorized**

Skip this assignment entirely unless the product owner has authorized D3. It can be done at any point after assignment 1.

**Files:** `packages/benson-core/src/intent.ts` (`isProjectAuditRequest` and its two uses), `packages/orca-core/src/audit/pipeline.ts` (the `asksForAudit` text test inside `isProjectAuditTask`), their tests.

**Behaviour:** `buildTaskSpec` always emits `mode: "default"`; `extractPermissions` keeps its other rules. `mode: "project_audit"` set by a structured caller is still honoured.

**Tests first:** "Review my project and fix the failing login test" → `mode: "default"` (fails before); a task with `mode: "project_audit"` set structurally still runs the deterministic audit (guard).

**Stop if:** a test drives the audit through message text only and has no structured alternative — report it.

---

## Assignment 2 — Brain proposes the contract; the runtime fixes it **[DESIGN]**

> **Approved ownership correction (product owner, 2026-11-17).** As first written, this assignment had `maestro-core`'s `parseBrainDecision` call `validateContractProposal`, which assignment 0 had placed in `orca-core`. `orca-core` depends on `maestro-core`, so that import would have been a cycle. The approved resolution:
>
> - The **pure proposal schema and its validator** — `TaskIntentKind`, `ChangeKind`, `ExpectedOutcome`, `BrainContractProposal`, `validateContractProposal` and its private helpers — live in `packages/maestro-core/src/contractProposal.ts`, use Maestro's own `CapabilityGroup` / `isCapabilityGroup`, and are exported from `maestro-core`'s index.
> - The **resolved `TaskContract`**, authority resolution, workspace path bounding, the kind floor and dispute rules, and acceptance-contract handling stay in `packages/orca-core/src/taskContract.ts`, which imports the proposal definitions from `maestro-core` and re-exports them unchanged, so existing `orca-core` importers are unaffected.
> - There is exactly one validator. Do not copy it, and do not add a package dependency or change a manifest to get around a direction problem — stop and report instead.
> - This moves code; it grants nothing and changes no rule. Miranda and Pappy are untouched.
>
> Two smaller clarifications made while implementing, both within the listed files:
> - The routing-context filter is a pure function, `routingPromptContext`, in `maestro-core/src/decompose.ts` (testable there; `main.ts` cannot be imported by a unit test). `brainRoute` calls `buildTaskPrompt({ ...task, context: routingPromptContext(task.context) })`.
> - `ctx.acceptanceContract` is left **exactly as it was** (`buildAcceptanceContract(task, doneCriteria)`), not replaced by `contract.acceptance`: assignment 0's builder has no input for Brain's derived criteria, so `contract.acceptance` currently holds the user goals only. Reconciling the two is deferred to assignment 5, which is the first consumer; do not change Pappy's goals before then.

**Goal:** the contract exists, is validated, fixed once, traced and returned. Nothing consumes it yet.

**Files**
- `packages/maestro-core/src/contractProposal.ts` (new) — proposal schema and validator, moved from `orca-core` (see the correction above); `packages/maestro-core/src/index.ts`; `packages/orca-core/src/taskContract.ts` (imports and re-exports them).
- `packages/maestro-core/src/decompose.ts` — types, prompt, parser.
- `apps/desktop/src/main.ts` — `brainRoute` and the two places it builds the Maestro result (`metadata`).
- `packages/orca-core/src/types.ts` — `OrcaRunCtx.taskContract`, `OrcaMaestroResult.metadata.contractProposal`, `OrcaExecutionResult.contract`.
- `packages/orca-core/src/runtime.ts` — fix the contract where `ctx.acceptanceContract ??=` is set today.
- `apps/desktop/src/types/maestro-core.d.ts`, `orca-core.d.ts`.
- Tests: `packages/maestro-core/src/decompose.test.ts` (extend), `packages/orca-core/src/runtime.test.ts` (extend).

**Behaviour**
1. `DirectRouting` and `DecomposeRouting` gain optional `contract?: BrainContractProposal`. Add `'contract'` to `DIRECT_VALID_KEYS` and `DECOMPOSE_VALID_KEYS`. `parseBrainDecision` validates it with `validateContractProposal` and throws `BrainDecisionValidationError` with the reason on failure, so the existing single repair attempt applies. A decision with no `contract` remains valid.
2. `BRAIN_DECOMPOSE_SYSTEM`: add a `contract` object to both schemas and a short rules block:
   - `kind` definitions exactly as design §3.1, with the ordering rule ("if two apply, choose the later").
   - `needs` lists capabilities the work requires; it is not a permission and granting is not Brain's decision.
   - `prohibits` only for restrictions the user stated.
   - `expects`: at most 6; name a `path` only when the user named that file.
   - Keep the instruction that the whole response is one bare JSON object.
   Do not name any model or provider in the prompt.
3. `brainRoute`: raise `maxTokens` from 512 to 768. Return the parsed proposal with the route. On the fallback route return no proposal.
   - **Routing prompt input (design R2):** the prompt sent to Brain must not contain `task.context.deweyBrief` (resolved resource summaries are text the user did not write). Add that key to the keys `buildTaskPrompt` already strips, for the Brain call only — workers still receive the brief as now. Add to the prompt rules: "Decide `kind` from the Request section only."
4. Maestro result `metadata.contractProposal` carries it out.
5. Runtime: on the first pass, if `ctx.taskContract` is unset, `ctx.taskContract = proposal ? buildTaskContract(...) : buildFallbackContract(...)`. In this assignment the runtime is the only builder; `ceiling` is derived from the tool names in `ctx.toolNamesAllowed` when present, else from the names the adapter reports in `metadata` (add `metadata.roleToolNames: string[]` in `runRoleWorker`), mapped with `classifyToolCapability` — never "every capability" (design R11). `workspace` is the existing `workspaceAuthority.status`. Record trace stage `task.contract` once. Attach `contract` to the returned result. Keep `ctx.acceptanceContract` populated exactly as now (use `contract.acceptance`).
6. A repair pass does not rebuild the contract.

**Tests first**
- Parser: valid contract accepted; unknown key inside `contract` rejected; top-level `authority`/`permissions` rejected (already true — assert it); decision without `contract` accepted; more than 6 `expects` rejected (matrix B2, B7, B9, B10).
- Runtime with a stub Maestro: proposal → `task.contract` traced once with `source: "brain"`; none → `source: "fallback"`; after a repair pass the same object identity is on `ctx`.
- Existing acceptance-contract tests pass unchanged.
- T14: `deweyBrief` text is absent from the prompt sent to Brain and still present in the worker's task prompt.
- T15: `contract.authority`, `contract.workspaceRoot`, `contract.approved` → validation error → fallback contract.
- T7 (contract half): request "Fix the off-by-one bug in src/parse.js" with a proposal of `inspect` → `kindDisputed: true`, `filesystem-write` withheld.

**Record in `PROJECT_STATE.md`:** character and estimated token count of `BRAIN_DECOMPOSE_SYSTEM` before and after.

**Must not change:** tool selection, gates, Pappy input, delivery, Claire. No enforcement in this assignment.

---

## Assignment 3 — Conversation short path and workspace pre-check **[DEFECT F-01, second half]**

**Goal:** a `conversation` task is answered without tools and delivered without the narrator rewrite; an inspection with no usable workspace stops after Brain.

**Files**
- `apps/desktop/src/main.ts` — inside `buildMaestroAdapter().run`, after `brainRoute` returns.
- `packages/claire-core/src/claire.ts` — `presentResult` only.
- `packages/claire-core/src/types.ts` — optional `contract?: { kind: string }` on `ExecutionResult`.
- Tests: `apps/desktop/src/agents/agentDispatch.test.ts` or a new `apps/desktop/src/contractRouting.test.ts`; `packages/claire-core/src/claire.test.ts`.

**Behaviour**
1. The adapter needs the contract before it starts a worker. Build it in the adapter from the proposal with the same `buildTaskContract` call (ceiling from the routed role's `selectToolsForRole` result; `attachedFiles` from the Cargo manifest) and put it on `ctx.taskContract` **only if unset**. The runtime then keeps it. On a repair pass `ctx.taskContract` is already set: never rebuild it, and never build one from a repair spec (its message is the repair instruction, not the user's request).
2. `kind === "conversation"`: run the routed role (default `narrator`) with **an empty tool list**. No workspace is required.
   - In `ReactAgentAdapter.run`, the two in-loop nudges that demand a tool call (`taskImpliesToolUse`, and the write nudge) must be skipped when the worker was given **zero tools** (design R4). Change only that condition.
   - The runtime's "unknown tool" follow-up must not be raised for a worker that had no tools.
   - **Repair for `conversation`:** leave as it is unless decision D8 is authorized. If D8 is authorized: a Pappy FAIL on a `conversation` contract is traced and not repaired (`repair.skipped`, reason `conversation`).
3. `contract.evidence.workspace === true` and `contract.authority.workspace !== "ok"`: do not start a worker. Return a Maestro result with empty output and one failed tool event whose summary starts with `WORKSPACE_REQUIRED_PREFIX` (from `@clawde/miranda-core`) followed by `assessWorkspaceRoot(...).message`. The runtime's existing stage 2 path then skips repair and sets the fixed `followUpQuestion`. Do not write new user-facing wording.
4. `presentResult`: when `result.contract?.kind === "conversation"`, the contract is not disputed and status is not FAIL, return `result.userFacingText` followed by the fixed line "Answered without reading any files." without calling `deps.complete`.

**Tests first**
- Scripted Brain returns `conversation`: the worker receives zero tools; a scripted tool call from the worker results in "Unknown tool" and nothing executes (matrix C8); exactly two model calls happen (Brain, answer); `deps.complete` (narrator) is not called.
- Scripted Brain returns `inspect` with `needs: ["filesystem-read"]`, no workspace: exactly one model call; result has the workspace `followUpQuestion`; no worker ran (matrix C4).
- Same with a missing configured workspace path.
- An `inspect` task with a usable workspace is unaffected.
- T3: Brain proposes `conversation` for a request naming a file that exists in the workspace → the worker gets read tools (kind floor).
- T4: the fixed "Answered without reading any files." line is present.
- T6: "How do I create a list in Python?" with a `conversation` contract → exactly two model calls and no tool-demand message.

**Must not change:** Miranda; the workspace-authority gate; the wording of the workspace explanation; the social fast path in `claire.ts`.

---

## Assignment 4 — Narrowing by kind; the contract supersedes inferred permissions **[DEFECT F-05, permission half + DESIGN]**

**Goal:** for a Brain-sourced contract, what a worker may do follows the contract, enforced by Miranda's existing task-permission gate. Both halves land in this one change so that no state exists in which a read-shaped request can write.

**Files**
- `apps/desktop/src/main.ts` — `runRoleWorker` (where `workerGate` is composed), `createWorkerPacket`, `selectToolsForRole`, and the `executeTask` wrapper that calls `enrichTaskWithCargo`.
- `apps/desktop/src/workerConstraints.ts` — add `taskPermissionsForContract(contract)`.
- `packages/orca-core/src/runtime.ts`, `types.ts` — expose `hostGate` on `OrcaRunCtx` (the workspace-authority gate composed with `deps.gate`, without the task-permission gate). No other runtime change.
- `apps/desktop/src/types/orca-core.d.ts`.
- Tests: `apps/desktop/src/workerConstraints.test.ts`, `apps/desktop/src/agents/verifiedToolExecution.test.ts` (extend) or a new `contractAuthority.test.ts`.

**Behaviour**
1. `taskPermissionsForContract` returns Miranda `TaskToolPermissions`: `fileRead: true`; `fileWrite: false` when `filesystem-write` is withheld; `shellExec: true` unless `shell` is prohibited; `networkAccess` exactly as today's rule (Benson's inferred value) **unless decision D2 is authorized**.
2. In `runRoleWorker`: `workerGate = composeMirandaGates(ctx.gate, constraintGate, createMirandaGate({ taskPermissions, connectorTools }))` when the contract's `source` is `"brain"`. This is the enforcement (design R3): `no_file_writes` alone only refuses the tool named `write_file`. Still add the `no_file_writes` packet constraint for the record.
3. **Superseding inferred permissions:** when — and only when — `ctx.taskContract.source === "brain"`, the task's Benson-inferred restrictive permissions must not also apply. The runtime builds its permission gate before Brain runs (`runtime.ts:242`), so do it at the worker: compose the worker gate from the **host** gate and the workspace-authority gate plus the contract gate, not from the task-permission gate. Expose the host gate on `OrcaRunCtx` as `hostGate` (set in `runtime.ts` next to `gate`) for this purpose. With `source: "fallback"` or no contract, use `ctx.gate` exactly as today.
4. `selectToolsForRole` additionally removes tools whose capability (`classifyToolCapability`) is in `authority.withheld`. A tool with no classification is left as it is today.

**Tests first**
- T1: `inspect` contract; `desktop-commander_write_file` and `desktop-commander_edit_block` inside the workspace are refused and never execute (fails before: the packet constraint lets them through).
- C3, B1, B4 from the design matrix.
- T5: fallback contract → Benson's inferred permissions still enforced; Brain contract `modify` for "Correct the typo in README.md" → a workspace write passes although Benson inferred read-only (fails before).
- A6: "Explain add(), don't change anything" with an `inspect` contract → write refused although Benson matched a write verb.
- Guard: the workspace-authority refusal still fires first with no workspace; approval is still requested for a non-confined shell command under every kind.

**Must not change:** `packages/miranda-core/**`; `constraintGateFor`; approval behaviour; `benson-core` (inference stays until assignment 8); the runner.

**Stop if:** giving the worker a gate that omits the task-permission gate would also drop any check other than Benson's inferred permissions. The composed gate must still contain the workspace-authority gate and the host gate; verify by test, and report if `ctx.gate` carries anything else.

---

## Assignment 5 — Pappy judges the contract **[DESIGN — requires human approval D1]**

`pnpm contract:check` will report `REVIEW REQUIRED` for Pappy files. **Stop and obtain approval before coding.**

**Goal:** Pappy uses the contract's kind and checks its required outcomes against host evidence.

**Files**
- `packages/pappy-core/src/types.ts` — `PappyInput.contract?`, declared with types defined **in `pappy-core`** (a structurally identical copy of `ContractOutcome`). `pappy-core` must not import `orca-core` (design R10); `orca-core` passes its own objects, which are assignable.
- `packages/pappy-core/src/checks/workspaceVerification.ts` — one line: `const kind = input.contract ? mapContractKind(input.contract) : classifyTaskKind(task);`.
- Add `packages/pappy-core/src/checks/contractOutcomes.ts` and its test.
- `packages/pappy-core/src/pappy.ts` — call `runContractOutcomeChecks(input)` alongside the other checks.
- `packages/orca-core/src/helpers.ts` — `buildPappyInput` passes `{ kind, changeKind, expects }` from `ctx.taskContract` (add a parameter; callers in `runtime.ts` and `repairLoop.ts` pass it).
- `apps/desktop/src/verificationGuidance.ts` — take `changeKind` when a contract exists.

**Behaviour**
- Kind mapping: `conversation` → `other`; `inspect`, `execute` → `inspect`; `modify` → `changeKind` (`other` when absent → fall back to `classifyTaskKind`).
- `runContractOutcomeChecks`, for each **required** outcome:
  - `inspection`: Pappy only establishes that reading happened, never that the explanation is right — it must not raise the evidence status to `verified` on this outcome alone. It needs at least one tool event with `ok === true` that is a read by Miranda's classification (file read, search, list, or a `run_command` whose `_execAuthority.approval === "confined_read"`), and — when `paths` are given and exist in the workspace evidence — one that names each path. Otherwise issue `INSPECTION_NOT_PERFORMED`, severity HIGH, category Proof.
  - `file_change`: needs a matching entry in `input.workspace.changes` (path and status). Otherwise `EXPECTED_CHANGE_MISSING`, HIGH. When `workspace` is absent or unavailable: `Not verified (insufficient evidence)` wording, HIGH, as the existing evidence issues use.
  - `no_file_change`: already covered by `INSPECT_UNREQUESTED_CHANGE`; add nothing.
  - `command`: needs an observed run in `workspace.testRuns` of the stated purpose; with `mustPass`, on the final source state and `ok`. Otherwise `EXPECTED_COMMAND_MISSING` / reuse existing test-evidence issues where they already fire (do not double-report).
  - `answer`: no new check (the criteria ledger handles it).
- Advisory (non-required) outcomes produce no issue.
- Tool events are read from `input.toolEvents` and `input.priorToolEvents`. Only host-written fields are consulted; `outputText` is never evidence for an outcome.

**Tests first**
- Matrix C1, C2, C5, C6, C9, D3, D5, D6 with the real `createPappyPort` and the real evidence collector on a temporary workspace.
- With no `input.contract`: run the existing `pappy-eval` evidence corpus tests and the 423 `pappy-core` tests — all pass unmodified.

**Must not change:** `deriveVerdict`; training-eligibility rules; any existing issue code's severity; Miranda's `afterQC`. Pappy stays deterministic — no model call.

**Stop if:** an existing corpus expectation changes when no contract is supplied.

---

## Assignment 6 — Delivery envelope **[DEFECT F-04]**

**Goal:** what the user is told is built from the verdict by code. A narrator can add a lead-in and nothing else.

**Files**
- `packages/orca-core/src/runtime.ts` — attach `delivery: buildDeliveryEnvelope(...)` to the result at the end of `executeTask`.
- `packages/orca-core/src/types.ts` — `OrcaExecutionResult.delivery`.
- `packages/claire-core/src/claire.ts`, `voice.ts`, `types.ts`.
- `apps/desktop/src/types/orca-core.d.ts`.
- Tests: `packages/claire-core/src/claire.test.ts`, `packages/orca-core/src/delivery.test.ts` (extend), `packages/orca-core/src/runtime.test.ts`.

**Behaviour**
1. `presentResult` with a `delivery` envelope renders, in order: optional lead-in → `body` verbatim → `status` lines → `issues` (code and description) → `notDone` → `needsUser` → `followUpQuestion`.
2. Lead-in: a model-written sentence is allowed **only for `verified`** (`delivery.narration === "lead_in"`); one narrator call asked for a single sentence, not asked to restate the result; wrapped in try/catch — any failure or budget refusal means no lead-in. Every other outcome uses fixed copy or nothing.
3. `followUpQuestion` no longer replaces the reply (design R8): it is appended last. The one exception is `blocked` with no body, where it is the reply. Today `claire.ts:72-73` returns it alone, which hides a successful result whenever a worker also tried an unavailable tool.
   - `status` for `inspected` lists the files the host recorded as read and states that the explanation was not independently checked; it never contains the word "verified".
   - `issues` are included for `completed_unverified` (MEDIUM and above) as well as `failed`.
   - `notDone` lists denied or timed-out approvals (authorization record) and Miranda-blocked or unavailable tools.
4. History (`pushHistory`) stores `body` plus status lines, not the lead-in.
5. Without an envelope (legacy caller): existing behaviour.
6. Remove `buildPresentPrompt` and `buildFailurePrompt` once no caller remains.

**Tests first**
- Matrix E1–E5, D7, D8.
- Narrator throws after a SUCCESS: reply equals body + status (audit probe E).
- FAIL: reply contains each blocking issue description and the failure status line; never "The work is done".
- WARN / unverified PASS: reply contains the "not verified" status line.
- Body of 20,000 characters is delivered intact.
- T8, T9, T10, T11, T13 and the delivery half of T7 (design §14).

**Must not change:** Pappy; the verdict → `status` mapping in the runtime (`SUCCESS`/`FAIL`); `reviewNarration` provenance checks (still applied to the body); approval or progress UI.

---

## Assignment 7 — Contract-driven write requirement; delete the heuristics **[DESIGN]**

**Goal:** the agent loop's "has the required action happened" logic reads the contract and host evidence.

**Files**
- `apps/desktop/src/agents/ReactAgentAdapter.ts`
- `apps/desktop/src/agents/AgentAdapter.ts` — `AgentTask.contract?`.
- `apps/desktop/src/main.ts` — pass `ctx.taskContract` into `agentTask`; remove `maestroCore.orchestrate(task.intent)` after confirming nothing reads `classification`/`risk` except the trace; compute Dewey's brief once.
- `apps/desktop/src/workerConstraints.ts`, `routingPolicy.ts`, `verificationGuidance.ts` — deletions listed in design §10 items 4, 6, 7.
- Tests: `toolExecutionIntegrity.test.ts`, `verifiedToolExecution.test.ts`, `workerEditProtocol.test.ts`, `routingPolicy.test.ts`.

**Behaviour**
1. With a contract:
   - "Write required" = a required `file_change` outcome exists.
   - Satisfaction is **cumulative across passes** (design R9): consult the task's host record (`ctx.lastWorkspaceEvidence.changes`) as well as this pass's `filesChanged`, and keep honouring `task.sourceChangeRequired === false`.
   - "Write satisfied" = a confirmed host change matching it (`filesChanged` derived from `_fsEvidence`), or — with no host observer — a successful write-tool event (the stage 2 legacy rule), or an `unverified` successful modifying call (neither satisfied nor failed; do not raise `required_action_incomplete`).
   - The "ACTION REQUIRED" directive and in-loop nudges are generated from the outcome's text and path.
   - "Tools required before a final answer" = `contract.evidence.workspace` and kind `inspect`; satisfied by one successful read event.
2. Without a contract: keep the current functions for one release, marked deprecated; delete them only when no test or caller builds an `AgentTask` without a contract.
3. `fallbackExecutionRole` reads the fallback contract's `kind`/`changeKind`.

**Tests first**
- Matrix C5–C7 with contracts and **no** save-verb in the task text (for example "Make the bound exclusive in src/parse.ts").
- A task whose text contains "write a summary of src/a.ts" with an `inspect` contract is **not** forced to call `write_file`.
- T12: pass 1 confirms the change; a repair pass that only runs tests does not end `required_action_incomplete`.
- All stage 1–2.2 integrity tests pass; where a test relied on the keyword heuristic, supply a contract and say so in the commit.

**Must not change:** the loop's gate calls, lifecycle tracking, evidence recording, `toolInputForRecord`, turn-limit behaviour.

**Stop if:** deleting a heuristic changes the outcome of a stage 1–2.2 security test in any way other than needing a contract supplied.

---

## Assignment 8 — Persistence, export prompt, runner **[DEFECT F-13 + migration]**

**Goal:** the user's message and the contract are stored; the training export uses the real prompt; the CLI path produces contracts.

**Files**
- `packages/orca-core/src/persistence/types.ts`, `migrations.ts`, `sqliteStore.ts` — nullable `original_user_message`, `contract_json` (idempotent migration, same pattern as `brain_decision`).
- `packages/orca-core/src/runtime.ts` — save both.
- `packages/orca-core/src/export/exportTrainingData.ts` — `prompt: run.originalUserMessage ?? run.intent`; skip the `brain` record when the contract's `source` is `fallback`.
- `apps/runner/src/adapters/maestroAdapter.ts` — pass Brain's proposal out in `metadata.contractProposal`; apply the same contract task-permission gate as the desktop (assignment 4).
- `packages/benson-core/src/intent.ts` — **last step, after the runner tests pass:** `extractPermissions` returns `undefined`; `buildTaskSpec` omits `permissions`. Before this step, confirm by test that both the desktop and the runner narrow from the contract and fall back to a read-only fallback contract when Brain fails.
- Tests: `persistence/store.test.ts`, `export/*.test.ts`, `apps/runner/src/adapters/maestroAdapter.test.ts`.

**Behaviour**
- Old databases open and read with nulls.
- Export eligibility rules are unchanged.
- The runner does not gain an approval handler or new permissions.
- After `extractPermissions` is removed, a fallback contract (Brain unavailable) for a request `classifyTaskKind` reads as `inspect`/`other` must still withhold `filesystem-write`.

**Tests first**
- A 200-character message not starting with a verb is stored and exported verbatim (matrix A8).
- A run with a fallback contract exports no `brain` record.
- A pre-migration database file opens.

**Must not change:** Moonshiner eligibility and evidence filters; Dewey.

---

## After all assignments

- Run the routing corpus (assignment 1) and report the class distribution.
- Report measured Brain prompt size and, from one scripted run per kind, the number of model calls — compare with design §9.
- Windows and packaged-build validation remain release-blocking (see `PROJECT_STATE.md`).

## Decisions — what you may and may not assume

Full register: design §11.

| ID | Needs product-owner authorization | Until authorized |
|---|---|---|
| D1 Pappy contract checks | **Yes** | Do not start assignment 5 |
| D2 Network / connector default | **Yes** | Keep today's keyword rule for `networkAccess` (assignment 4, item 1) |
| D3 Remove keyword audit trigger | **Yes** | Skip assignment 1b |
| D8 No repair for `conversation` | **Yes** | Leave repair as it is (assignment 3, item 2) |
| D4 Conversation answers skip the rewrite | No — proceed | — |
| D5 Model lead-in only for `verified` | No — proceed | — |
| D6 Desktop capability ceilings | Settled: out of scope | Ceiling = the role's actual tool list |
| D7 `before_qc` empty-output stop | Settled: out of scope | Render as `failed` |
| D9 Kind dispute | Settled | Narrow authority; say nothing was changed |

If an assignment depends on an unauthorized item, do the rest of the assignment and state plainly what was left out.
