# Design — a fourth Pappy verdict for "needs human review"

**Status:** proposal, not implemented. ROADMAP 4.6.
**Blocks:** scope-drift runs going to a person instead of to a repair pass.
**Requires:** a decision on the Miranda `CONFIRM_REQUIRED` question in §6.

---

## 1. The problem

Pappy already detects scope drift. An out-of-scope edit to `.env` or
`.github/workflows/` raises `FORBIDDEN_PATH_ACCESSED`, and
`deriveTrainingEligibility` correctly caps the run at `needs_human_review`.

But `Verdict` is `PASS | WARN | FAIL`, and `FORBIDDEN_PATH_ACCESSED` is MEDIUM,
so the verdict collapses to `WARN`. `WARN` means "repair". The run is handed
back to the agent to fix, when the correct action is to stop and ask a person
whether the out-of-scope change was intended.

Measured on the eval suite: `scope_drift-001` and `scope_drift-002` both expect
`needs_human_review` and both return `repair`. They are two of the four
remaining failures, and they are the only two that cannot be fixed by improving
a heuristic — the state they need does not exist.

An agent cannot repair its way out of "a human needs to look at this". Sending
it back is a wasted LLM round-trip that ends in the same place.

## 2. Why this is not a small change

`verdict` is consumed at twelve decision points, and the dangerous shape is
`!== "PASS"` rather than `=== "FAIL"`:

| Site | Test | Effect on a new state |
|---|---|---|
| `orca-core/src/repairLoop.ts:28` | `packet.verdict !== "PASS"` | **triggers a repair pass** |
| `pappy-core/src/pappy.ts:526` | `verdict !== "PASS"` | **builds a repair task** |
| `orca-core/src/runtime.ts:635` | `verdict === "FAIL"` | falls through as success |
| `orca-core/src/runtime.ts:466` | `verdict === "FAIL" ? "FAIL" : "SUCCESS"` | **reported as SUCCESS** |
| `orca-core/src/export/exportTrainingData.ts:110,125` | `verdict !== targetVerdict` | excluded from export (correct by luck) |
| `exportTrainingData.ts:180` | `SCORE_BY_VERDICT[verdict] ?? 7` | scores 7, same as WARN |
| `sqliteStore.ts:256,305,477` | cast to `'PASS'\|'WARN'\|'FAIL'` | **type lie on read-back** |
| display: `runAnalysis.ts:548`, `pappy-trace.ts:254`, `runner/index.ts:341`, `runner/tracer.ts:211`, `desktop/orca-tracer.ts:1383` | ternaries defaulting to the failure branch | renders as ✗ / ❌ |

Adding a fourth enum member without touching these would produce the worst
outcome available: a run that needs human review would be **reported as
SUCCESS** by `runtime.ts:466` while **also** triggering a repair pass at
`repairLoop.ts:28`. Both wrong, in opposite directions, silently.

The three `sqliteStore` casts matter separately. Existing rows are already
persisted as `TEXT`; the casts assert a union the data will no longer satisfy.
That is not a runtime failure, it is a type assertion that becomes false —
which is worse, because nothing will report it.

## 3. Options

### Option A — add `REVIEW` to `Verdict`

```ts
export type Verdict = "PASS" | "WARN" | "FAIL" | "REVIEW";
```

*For:* one concept, one field. Every consumer is forced by `tsc` to decide what
it means, provided the ternaries are converted to exhaustive switches.

*Against:* the `!== "PASS"` sites are **not** caught by the compiler. They keep
compiling and quietly do the wrong thing. Every one must be found by hand — the
table in §2 is that list, and it must be treated as load-bearing rather than
indicative.

*Migration:* `sqliteStore` casts widened; `SCORE_BY_VERDICT` given an explicit
entry; five display sites converted from ternary to switch.

### Option B — keep three verdicts, add a separate `requiresHumanReview: boolean`

*For:* no existing consumer changes behaviour. `verdict` keeps its meaning and
its persisted values. Additive in the same way `trainingEligibility` was, which
is the precedent that already worked in this codebase.

*Against:* two fields now encode one decision, and nothing forces a caller to
read the second. `repairLoop` would still see `WARN` and repair unless
explicitly taught otherwise — the bug is not fixed by the type, only by
remembering.

### Option C — reuse `trainingEligibility`

`needs_human_review` already exists there and is already set correctly for
scope drift.

*For:* zero new surface. The signal is already produced and already correct.

*Against:* conflates two genuinely separate questions, which is the exact
mistake the training-eligibility split was made to undo. "Do not train on this"
and "do not accept this without a human" are not the same claim: an embedded
credential is the first and not the second.

**Recommendation: Option A**, on the condition that §2's table is worked through
explicitly rather than trusting the compiler. Option B is the safer change and
the worse design — it leaves the defect intact and depends on every future
caller remembering a second field. Option C should be rejected outright; it
re-merges what was just separated.

## 4. Semantics to fix before writing code

- **`REVIEW` is terminal.** It does not trigger a repair pass. `repairLoop`
  must treat it as a stop, not as "not PASS".
- **`REVIEW` is not failure.** `runtime.ts:466` must not report SUCCESS, and
  must not report FAIL either. A third status is needed at that boundary, or the
  run must be marked as blocked.
- **`REVIEW` never exports as training data.** `trainingEligibility` already
  handles this; the export gate must not infer eligibility from verdict.
- **Precedence against FAIL.** A run with both a `FORBIDDEN_PATH_ACCESSED` and a
  CRITICAL integrity violation is a FAIL. Review is for ambiguity, and there is
  nothing ambiguous about tampering. `deriveVerdict` must check hard-fail codes
  first.

## 5. What produces `REVIEW`

Initially only the codes already classified as review signals in
`deriveTrainingEligibility`:

- `FORBIDDEN_PATH_ACCESSED`
- `PACKAGE_SCRIPTS_CHANGED`

Both are currently MEDIUM. They would need to drive the verdict directly rather
than through severity, since MEDIUM must continue to mean WARN for everything
else.

## 6. The Miranda question — decide this first

`docs/ORCA_SYSTEM_CONTRACT.md` and `CLAUDE.md` define a Miranda gate verdict
`CONFIRM_REQUIRED`, described as "Pause until user approval; reserved until
wired". That is the same concept at a different layer.

Two coherent answers, and the choice must be made before any code is written:

1. **They are the same pause.** Pappy returning `REVIEW` should surface through
   Miranda's `CONFIRM_REQUIRED` so there is one confirmation path. This makes
   `REVIEW` a Pappy-side input to an existing Miranda state.
2. **They are different pauses.** Miranda confirms *before* an action;
   Pappy reviews *after* one. Wiring them together would mean Miranda is
   judging output quality, which the Miranda Architecture Lock in `CLAUDE.md`
   explicitly forbids: *"Miranda does not plan, answer, critique, rewrite,
   synthesize, or judge output quality."*

Reading the lock literally, (2) is correct and the two must stay separate. But
that leaves two independent human-confirmation paths, which is worth accepting
deliberately rather than by accident.

`CLAUDE.md` also states: *"Do not implement Step 4B behavior or Miranda QC
override behavior without an explicit design document."* This document is
scoped to Pappy's verdict only. It does not authorise any change to Miranda,
and §6 must be answered separately before that boundary is touched.

## 7. Verification

The eval suite already encodes the target: `scope_drift-001` and
`scope_drift-002` expect `verdict=needs_human_review`. They are currently two of
four failures, so success is measurable as 19/23 → 21/23.

The metrics that must **not** move: cheat catch 100%, false accept 0%. A fourth
state that quietly reclassifies failures as "review" would show up as a false
accept, which is the specific regression to watch for.

Run `pnpm pappy:eval:raw-real-pappy` before and after.
