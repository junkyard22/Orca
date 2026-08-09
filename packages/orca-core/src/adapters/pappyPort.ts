import { appendFileSync } from "node:fs";
import { evaluateWithPappy, traceEvaluation } from "@clawde/pappy-core";
import type {
  ModelIdentity,
  ModelReviewProvenance,
  PappyInput,
  PappyResult,
  ReviewIndependence,
  TrainingEligibility,
} from "@clawde/pappy-core";
import type { PappyPort } from "../types.js";

/** Strip ANSI escape codes so log files contain readable plain text. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeIdentityValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

/**
 * Return identifiers that can safely be compared for exact model identity.
 *
 * `canonicalModelId` wins when an adapter can resolve one. The leaf model name
 * also catches common aliases such as `openai/gpt-4o` vs `gpt-4o`. We do not
 * attempt fuzzy family matching here: uncertain aliases must remain UNKNOWN
 * rather than being guessed independent.
 */
function modelIdentityKeys(identity: ModelIdentity): Set<string> {
  const keys = new Set<string>();
  const canonical = normalizeIdentityValue(identity.canonicalModelId);
  const model = normalizeIdentityValue(identity.model);

  if (canonical) keys.add(canonical);
  if (model) {
    keys.add(model);
    const leaf = model.split("/").filter(Boolean).at(-1);
    if (leaf) keys.add(leaf);
  }

  return keys;
}

function isSameUnderlyingModel(a: ModelIdentity, b: ModelIdentity): boolean {
  const aKeys = modelIdentityKeys(a);
  const bKeys = modelIdentityKeys(b);
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
}

/**
 * Classify an upstream LLM review using the identities that ACTUALLY executed.
 * Pappy itself is deterministic, so no model-review provenance means the
 * independence question is simply not applicable.
 */
export function assessModelReviewIndependence(
  review: ModelReviewProvenance | undefined,
): ReviewIndependence {
  if (!review) {
    return {
      status: "not_applicable",
      fallbackUsed: false,
      independentRequired: false,
      reason: "Pappy is deterministic; no upstream model critic was supplied.",
    };
  }

  const independentRequired = review.independentRequired ?? true;
  const fallbackUsed = review.fallbackUsed ?? false;
  const producer = review.producer;
  const reviewer = review.reviewer;

  if (!producer?.model || !reviewer?.model) {
    return {
      status: "unknown",
      producer,
      reviewer,
      fallbackUsed,
      independentRequired,
      reason: fallbackUsed
        ? "Reviewer fallback occurred, but the actual producer/reviewer model identity is incomplete."
        : "Producer/reviewer model identity is incomplete; independence cannot be proven.",
    };
  }

  if (isSameUnderlyingModel(producer, reviewer)) {
    return {
      status: "self_review",
      producer,
      reviewer,
      fallbackUsed,
      independentRequired,
      reason: fallbackUsed
        ? "Reviewer fallback resolved to the same underlying model as the producer."
        : "Reviewer resolved to the same underlying model as the producer.",
    };
  }

  return {
    status: "independent",
    producer,
    reviewer,
    fallbackUsed,
    independentRequired,
    reason: fallbackUsed
      ? "Reviewer fallback resolved to a different model; independence was preserved."
      : "Producer and reviewer resolved to different models.",
  };
}

function guardTrainingEligibility(
  current: TrainingEligibility,
  review: ReviewIndependence,
): TrainingEligibility {
  // Never weaken an existing integrity decision from deterministic Pappy.
  if (current === "rejected") return current;

  // A same-model critic may still be useful as a self-review, but it must never
  // masquerade as independent evidence for Moonshiner training eligibility.
  if (review.status === "self_review") {
    if (current === "needs_human_review") return current;
    return "accepted_but_not_trainable";
  }

  // When independence is part of the contract, missing provenance fails closed:
  // a person must decide rather than silently treating the review as independent.
  if (review.status === "unknown" && review.independentRequired) {
    return "needs_human_review";
  }

  return current;
}

function finalizePappyResult(input: PappyInput, result: PappyResult): PappyResult {
  const reviewIndependence = assessModelReviewIndependence(input.metadata?.modelReview);
  const trainingEligibility = guardTrainingEligibility(
    result.trainingEligibility,
    reviewIndependence,
  );

  const internalSummary = [
    result.internalSummary,
    `review_independence=${reviewIndependence.status}`,
    reviewIndependence.fallbackUsed ? "review_fallback=true" : "review_fallback=false",
  ].join(" ");

  return {
    ...result,
    trainingEligibility,
    reviewIndependence,
    internalSummary,
  };
}

function evaluateWithProvenance(input: PappyInput): PappyResult {
  return finalizePappyResult(input, evaluateWithPappy(input));
}

/**
 * Wraps pappy-core's pure evaluateWithPappy function as a PappyPort.
 *
 * The wrapper also classifies any upstream model-review provenance. This keeps
 * role separation from being mistaken for model independence: a reviewer that
 * falls back to the producer's model can still review, but the run cannot be
 * exported as independently verified training data.
 *
 * Usage (app shell):
 *   import { createPappyPort } from "@clawde/orca-core";
 *   const pappy = createPappyPort();
 */
export function createPappyPort(): PappyPort {
  return { evaluate: evaluateWithProvenance };
}

/**
 * Debug variant — prints the full Pappy trace to stdout every time a prompt
 * is evaluated.  Swap this in instead of createPappyPort() while troubleshooting.
 *
 * Usage (app shell / orca-tracer.ts):
 *   const pappy = createDebugPappyPort();
 */
export function createDebugPappyPort(): PappyPort {
  return {
    evaluate(input) {
      return finalizePappyResult(input, traceEvaluation(input));
    },
  };
}

/**
 * Logging variant — prints the full Pappy trace to stdout AND appends a
 * plain-text copy (ANSI codes stripped) to `logFile` with a timestamp
 * separator between evaluations.
 *
 * Usage (app shell):
 *   const pappy = createLoggingPappyPort("orca-pappy.log");
 *
 * The log file is appended (never truncated), so you can tail -f it while
 * the app runs:
 *   tail -f orca-pappy.log
 */
export function createLoggingPappyPort(logFile: string): PappyPort {
  return {
    evaluate(input) {
      // Capture every console.log line emitted by traceEvaluation.
      // traceEvaluation is fully synchronous, so this is safe.
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        origLog(...args);
        lines.push(args.map(String).join(" "));
      };

      let result;
      try {
        result = traceEvaluation(input);
      } finally {
        console.log = origLog;
      }

      const plain = lines.map(stripAnsi).join("\n");
      appendFileSync(logFile, plain + "\n", "utf8");

      return finalizePappyResult(input, result);
    },
  };
}
