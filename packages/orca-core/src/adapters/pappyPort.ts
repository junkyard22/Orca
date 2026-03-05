import { appendFileSync } from "node:fs";
import { evaluateWithPappy, traceEvaluation } from "@clawde/pappy-core";
import type { PappyPort } from "../types.js";

/** Strip ANSI escape codes so log files contain readable plain text. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

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
      return traceEvaluation(input);  // prints trace + returns real result
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

      return result;
    },
  };
}
