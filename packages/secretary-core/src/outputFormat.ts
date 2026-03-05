// ---------------------------------------------------------------------------
// Output format extractor
//
// Determines what the model should produce — code in chat, a file diff,
// JSON data, or prose explanation.
// ---------------------------------------------------------------------------

import type { OutputFormat } from "./types.js";

export function extractOutputFormat(message: string): OutputFormat {
  // Explicit diff request
  if (/\b(diff|patch|changes? only|what changed)\b/i.test(message)) {
    return "diff";
  }

  // Explicit JSON / structured data request
  if (/\b(json|as json|return json|structured (data|output)|machine.?readable)\b/i.test(message)) {
    return "json";
  }

  // Explanation / documentation / prose
  if (/\b(explain|describe|summarize|documentation|readme|comment|what (is|are|does)|how does|tell me)\b/i.test(message)) {
    return "prose";
  }

  // Default for coding requests — code block in chat response
  if (/\b(write|create|build|implement|generate|add|fix|refactor|update|function|class|method|component|module|script)\b/i.test(message)) {
    return "code";
  }

  return "prose";
}
