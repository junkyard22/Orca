import { evaluateWithPappy } from "@clawde/pappy-core";
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
