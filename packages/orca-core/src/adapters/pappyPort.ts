import { evaluateWithPappy, traceEvaluation } from "@clawde/pappy-core";
import type { PappyPort } from "../types.js";

/**
 * Wraps pappy-core's pure evaluateWithPappy function as a PappyPort.
 *
 * Usage (app shell):
 *   import { createPappyPort } from "@clawde/orca-core";
 *   const pappy = createPappyPort();
 */
export function createPappyPort(): PappyPort {
  return { evaluate: evaluateWithPappy };
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
      traceEvaluation(input);           // prints the step-by-step trace
      return evaluateWithPappy(input);  // still returns the real result
    },
  };
}
