import type { Message, TaskSpec } from "./types.js";
import { parseIntent } from "./intent.js";

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type IntentClass = "CONVERSATIONAL" | "NEEDS_CLARIFICATION" | "EXECUTABLE";

export type ClassificationResult =
  | { kind: "CONVERSATIONAL" }
  | { kind: "NEEDS_CLARIFICATION" }
  | { kind: "EXECUTABLE"; spec: TaskSpec };

// ---------------------------------------------------------------------------
// Conversational detection — pattern matching only, no LLM, no canned strings.
// The caller (Claire) handles response generation for matched messages.
// ---------------------------------------------------------------------------

const CONVERSATIONAL_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|howdy|yo|hiya)\s*[!.]?\s*$/i,
  /^how (are you|are things|is it going|'?s it going|are you doing)\s*[?!.]?\s*$/i,
  /^(thanks?|thank you|ty|thx|cheers|appreciate (it|that)|much appreciated)\s*[!.]?\s*$/i,
  /^(great|nice|cool|awesome|perfect|excellent|sounds? good|good job|well done)\s*[!.]?\s*$/i,
  /^what can you (do|help with|help me with)\s*[?.]?\s*$/i,
  /^what(('?s)|( is)) (your )?(name|purpose|function|role)\s*[?.]?\s*$/i,
  /^who are you\s*[?.]?\s*$/i,
  /^(good )(morning|afternoon|evening|night)\s*[!.]?\s*$/i,
  /^(ok|okay|got it|makes sense|understood|sure thing|sounds good)\s*[!.]?\s*$/i,
  /^that (works?|looks? (right|good|correct)|is (right|correct|great|perfect))\s*[!.]?\s*$/i,
  /^that'?s (right|correct|great|perfect|good|fine|nice|helpful)\s*[!.]?\s*$/i,
  /^(sounds? (right|good|great|perfect|correct)|that'?s what i (wanted|needed|meant))\s*[!.]?\s*$/i,
  /^(wow|amazing|impressive|love it|love that)\s*[!.]?\s*$/i,
  // Opinion / discussion questions — no task, just curiosity or chat
  /^what do you think (of|about)\b/i,
  /^what('?s| is) your (opinion|take|view|thought|thoughts) (on|about)\b/i,
  /^do you (think|believe|feel|reckon)\b/i,
  /^(can|could) you explain\b/i,
  /^tell me (about|more about)\b/i,
  /^(how|why) do(es)? (that|it|this)\b/i,
  /^(what|how|why) (is|are|was|were)\b(?!.*(creat|build|writ|generat|implement|add|fix|chang|updat|remov|delet|refactor|deploy|set up|run|execut))/i,
];

function isConversational(trimmed: string): boolean {
  return CONVERSATIONAL_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Needs-clarification detection — task implied but target is missing.
// Only fires when there is no prior history to give context.
// ---------------------------------------------------------------------------

const CLARIFY_PATTERNS: RegExp[] = [
  /^(fix|repair|resolve|debug|correct)\s+(it|that|this|the issue|the bug|the problem|the error)\s*[.!]?\s*$/i,
  /^help(\s+me)?\s*[.!]?\s*$/i,
  /^(do|run|execute)\s+(it|that|this)\s*[.!]?\s*$/i,
  /^(change|update|modify|edit)\s+(it|that|this)\s*[.!]?\s*$/i,
  /^make\s+(it|that|this)\s+(better|work|faster|cleaner|simpler)\s*[.!]?\s*$/i,
  /^(implement|create|build|write|make)\s+(it|that|this|something|one)\s*[.!]?\s*$/i,
];

function isNeedsClarification(trimmed: string, history?: Message[]): boolean {
  // Vague references ("fix it") are answerable from context if history exists.
  if (history && history.length > 0) return false;
  return CLARIFY_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a user message into one of three buckets:
 *
 * - CONVERSATIONAL      — social/meta input; Claire responds directly via Narrator
 * - NEEDS_CLARIFICATION — task intent present but underspecified; Claire asks via Narrator
 * - EXECUTABLE          — full task spec ready; route to the Brain/pipeline
 *
 * This function never makes an LLM call.
 */
export function classifyIntent(message: string, history?: Message[]): ClassificationResult {
  const trimmed = message.trim();

  if (!trimmed) return { kind: "NEEDS_CLARIFICATION" };

  if (isConversational(trimmed)) return { kind: "CONVERSATIONAL" };

  if (isNeedsClarification(trimmed, history)) return { kind: "NEEDS_CLARIFICATION" };

  // Delegate to the existing intent parser for full TaskSpec extraction.
  // If it still returns CLARIFY (e.g. bare 1-word messages), map to NEEDS_CLARIFICATION.
  const parsed = parseIntent(message, history);
  if (parsed.kind === "CLARIFY") return { kind: "NEEDS_CLARIFICATION" };

  return { kind: "EXECUTABLE", spec: parsed.spec };
}
