# Parallel verification work vs. the core reliability plan

**Date:** 2026-10-09 · **Scope:** `wip/live-demo-verification-parallel` (`43edfda`, a snapshot of the 27 uncommitted files still present in `C:\Orca\Orca` on `fix/live-demo-verification`) compared with the core changes proposed in `ORCA-CORE-RELIABILITY-AUDIT.md`. Nothing was merged or discarded; both lines are preserved.

The parallel work was done on 2026-10-07 on the Summit line (`feature/summit-demo-mode` @ `1e87212`) to repair the first Live AI failure. It is unreviewed and was never run through the full suite on this machine. Its design note is `docs/LIVE_DEMO_VERIFICATION_FIX.md` on that branch.

## What it contains (27 files, +591 / −23)

| Area | Files | Summary |
|---|---|---|
| Verification evidence | `packages/orca-core/src/workspaceVerification.ts` (+test), `packages/pappy-core/src/checks/executionReceipts.ts` (+test), `pappy-core/src/types.ts` (`WorkspaceSnapshot`, `WorkspaceVerification`) | SHA-256 hash snapshots of the workspace at task start, before/after each whole-suite test command (observed through `tool.call`/`tool.result` trace entries), and at QC. Pappy derives test-execution, preservation, root-cause and bug-fix criteria receipts from them. |
| Wiring | `orca-core/src/{helpers,runtime,repairLoop}.ts`, `pappy-core/src/{pappy,ahp/evaluator,integrity,toolResults,index}.ts` | `buildPappyInput(…, workspaceVerification)`; AHP evaluator uses the same receipts; a resolved before-fix failure is excluded from failure checks; failed direct-worker AHP packets propagate to final QC; repair exhaustion keeps the last verdict/artifacts. |
| Loop receipts | `agent-loop-core/src/loop.ts`, `apps/desktop/src/agents/ReactAgentAdapter.ts` | `_outputForProof` kept for failed commands (still truncated to 4,000); `tool.call`/`tool.result` traces carry iteration, input and result; role added to shared-loop traces. |
| Shell | `workbench-core/src/tools/runCommandTool.ts`, `registry.ts`, `tools.test.ts` | Optional `shell: "powershell"` on Windows (explicit PowerShell execution with the original command still policy-checked); accurate cmd.exe description; enum values printed in tool prompts. |
| Miranda | `miranda-core/src/gate/mirandaGate.ts` (+test) | `echo` without redirection no longer counts as a mutating command. |
| Routing prompt | `maestro-core/src/decompose.ts` | Brain guidance: investigate/fix/test are one coding task; test criteria need captured output. |
| Tests/docs | `apps/desktop/src/liveDemoVerification.test.ts`, `docs/LIVE_DEMO_VERIFICATION_FIX.md` | End-to-end verification test and the design note. |

## Overlap with the core plan

| Core phase | Parallel work | Assessment |
|---|---|---|
| **1 Security** (Miranda classification, execution-time authorization, path boundaries) | none — only the `echo` relaxation in `MUTATING_COMMAND_RE` | No overlap. The `echo` relaxation is a *loosening* of Miranda's test-file protection and is **not** adopted in phase 1 (the parallel test shows `echo x > test/file` is still blocked via the `>` rule, but `echo` into a test file through other means would need separate review). |
| **2 Verification integrity** | strong overlap: hash snapshots (`workspaceVerification.ts`) vs content snapshots (1.6.1 `workspaceSnapshot.ts`); criteria receipts (`executionReceipts.ts`) vs defect-fix rules (1.6.1 `fixVerification.ts`) | Two different designs for the same problem. **Useful ideas from the parallel line:** (a) hashes instead of file contents — far cheaper, no 50 MB cap, no content in traces; (b) per-test-run before/after snapshots proving the suite ran against the final source with unchanged test/config/lockfile "control" files; (c) criterion-level receipts (test-run, preservation, root-cause, bug-fix) that plug into the existing acceptance-criteria ledger — this is close to the audit's §6.5 recommendation for reducing false rejects; (d) failed direct-worker AHP packets propagated to final QC; (e) repair exhaustion retaining the last verdict and artifacts. **Useful from 1.6.1:** before/after *contents* allow `testShape()` (case/assertion/skip counts) to detect weakened tests, which hashes cannot; explicit `TEST_FILE_DELETED`/`TEST_EDIT_PROHIBITED`/`FIX_TEST_COUNT_DROPPED` issues; `priorToolEvents` so a repair pass keeps the reproduction evidence; a documented-alternative path. **Recommendation for phase 2:** one implementation — hash-based snapshots for scope/preservation and test-run bracketing (parallel line), plus content capture *only for test files that changed* (1.6.1's weakening detection), feeding both the defect-fix rules and criterion receipts. Neither line should be merged as-is. |
| **3 Providers** | none | — |
| **4 Budget** | none | — |
| **5 Routing & failure handling** | `decompose.ts` Brain prompt guidance; repair-exhaustion verdict retention; failed direct-worker packets to QC | Complementary to 1.6.1's `routingPolicy` change (which acts when Brain is *absent*; the prompt guidance acts when Brain is present). Both are small and compatible; include with phase 5 after tests. |
| **6 UI accuracy** | enum values in tool prompts; `tool.call`/`tool.result` trace detail | Low-risk improvements; optional. |
| Shell execution (not in the plan) | explicit PowerShell option in `run_command` | Fixes a real Windows usability problem seen on 2026-10-07 (cmd.exe vs PowerShell syntax). Security-relevant: the original command is still policy-checked and approval-gated, and the PowerShell path uses `-NoProfile -NonInteractive -EncodedCommand`. Needs its own review (encoded command bypasses the `shell: true` cmd parsing that the sandbox policy was written against). Not part of phase 1. |

## Decision record

- Nothing from the parallel branch is merged in phase 1.
- Phase 2 should start from a short design note that combines the two approaches (see the recommendation above) rather than cherry-picking either.
- The 27 uncommitted files in `C:\Orca\Orca` remain untouched; `wip/live-demo-verification-parallel` remains the reference snapshot.
