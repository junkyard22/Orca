# Pappy — Verifier Provenance and Independence

**Status:** implemented guardrail at the Orca Pappy port.

## Why this exists

A separate `reviewer` role does not guarantee an independent review. A fallback
can silently resolve the reviewer to the same underlying model that produced the
artifact. If the system then records that result as independently verified, the
review contract is false even when the reviewer output looks excellent.

The permanent rule is:

> **Role separation is not model independence. Independence is a provenance fact.**

## Important current-state distinction

Pappy itself is deterministic. `packages/pappy-core` evaluates receipts, tool
results, acceptance criteria, integrity checks, and other structured evidence;
it does not call an LLM to critique the producer.

Therefore the producer cannot currently "become Pappy" through a model fallback.
The provenance guard applies to any **upstream model-based critic/reviewer** whose
result is supplied to Pappy as additional verification evidence.

## Provenance contract

When a model-based review exists, `PappyInput.metadata.modelReview` records:

- the **producer** identity that actually executed;
- the **reviewer** identity that actually executed;
- whether the review path used a fallback;
- whether independence is required by the caller.

Model identity may include `role`, `provider`, `model`, and an optional
provider-independent `canonicalModelId`.

**Configured intent is not provenance.** Callers must record the model that
actually ran *after fallback resolution*, not the originally selected model.

## Pappy classification

The Orca Pappy port classifies the upstream model review as:

| Status | Meaning |
|---|---|
| `not_applicable` | No upstream model critic was supplied; Pappy is deterministic. |
| `independent` | Producer and reviewer resolve to different model identities. |
| `self_review` | Reviewer resolves to the same underlying model as the producer. |
| `unknown` | Required identity data is missing, so independence cannot be proved. |

The classification is returned as `PappyResult.reviewIndependence` and appended
to `internalSummary` for traces and diagnostics.

## Training / Moonshiner rule

Pappy verdict and training eligibility remain separate axes.

- `self_review` may still be useful as a review, but it cannot qualify the run as
  independently verified training data. An otherwise `eligible` run becomes
  `accepted_but_not_trainable`.
- `unknown` with `independentRequired=true` fails closed to
  `needs_human_review`.
- `independent` leaves Pappy's existing training eligibility unchanged.
- Existing `rejected` decisions are never weakened by provenance processing.

This specifically prevents a reviewer fallback from silently contaminating the
Moonshiner corpus.

## Fallback rule

Fallback is allowed only if its **actual resolved model** is recorded.

A fallback to a different model can remain independent. A fallback to the
producer's model is `self_review`. A fallback whose actual reviewer identity is
missing is `unknown` and, when independence is required, requires human review.

There is no path where fallback alone is interpreted as proof of independence.

## Future integration rule

If Orca adds a live semantic critic stage, that stage must populate
`metadata.modelReview` using post-resolution provider/model identity before the
artifact reaches Pappy. Do not infer independence from role names such as
`strong_model` and `reviewer`.
