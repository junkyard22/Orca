import type { Message, TaskSpec } from "./types.js";
import { parseIntent } from "./intent.js";

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type IntentClass = "CONVERSATIONAL" | "NEEDS_CLARIFICATION" | "EXECUTABLE";

export type ClassificationResult =
  | { kind: "CONVERSATIONAL" }
  | { kind: "NEEDS_CLARIFICATION"; question: string }
  | { kind: "EXECUTABLE"; spec: TaskSpec };

// ---------------------------------------------------------------------------
// Conversational detection — no pipeline action needed
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
];

function isConversational(trimmed: string): boolean {
  return CONVERSATIONAL_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Needs-clarification detection — task implied but target is missing
// Only fires when there is no prior history to give context.
// ---------------------------------------------------------------------------

interface ClarifyRule {
  pattern: RegExp;
  question: string;
}

const CLARIFY_RULES: ClarifyRule[] = [
  {
    pattern: /^(fix|repair|resolve|debug|correct)\s+(it|that|this|the issue|the bug|the problem|the error)\s*[.!]?\s*$/i,
    question: "What would you like me to fix?",
  },
  {
    pattern: /^help(\s+me)?\s*[.!]?\s*$/i,
    question: "What do you need help with?",
  },
  {
    pattern: /^(do|run|execute)\s+(it|that|this)\s*[.!]?\s*$/i,
    question: "What would you like me to do?",
  },
  {
    pattern: /^(change|update|modify|edit)\s+(it|that|this)\s*[.!]?\s*$/i,
    question: "What should I change?",
  },
  {
    pattern: /^make\s+(it|that|this)\s+(better|work|faster|cleaner|simpler)\s*[.!]?\s*$/i,
    question: "What aspect would you like me to improve?",
  },
  {
    pattern: /^(implement|create|build|write|make)\s+(it|that|this|something|one)\s*[.!]?\s*$/i,
    question: "What would you like me to build?",
  },
];

function getNeedsClarificationQuestion(trimmed: string, history?: Message[]): string | null {
  // If there is prior conversation history, these vague references (e.g. "fix it")
  // can be resolved from context — don't ask again, route to EXECUTABLE instead.
  if (history && history.length > 0) return null;

  for (const rule of CLARIFY_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.question;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a user message into one of three buckets:
 *
 * - CONVERSATIONAL  — no pipeline action needed; Claire responds directly
 * - NEEDS_CLARIFICATION — task intent present but underspecified; Claire asks one question
 * - EXECUTABLE      — full task spec ready; route to the Brain/pipeline
 */
export function classifyIntent(message: string, history?: Message[]): ClassificationResult {
  const trimmed = message.trim();

  if (!trimmed) {
    return { kind: "NEEDS_CLARIFICATION", question: "What's on your mind?" };
  }

  if (isConversational(trimmed)) {
    return { kind: "CONVERSATIONAL" };
  }

  const clarifyQ = getNeedsClarificationQuestion(trimmed, history);
  if (clarifyQ) {
    return { kind: "NEEDS_CLARIFICATION", question: clarifyQ };
  }

  // Delegate to the existing intent parser for full TaskSpec extraction.
  // If it still returns CLARIFY (e.g. bare 1-word messages), map to NEEDS_CLARIFICATION.
  const parsed = parseIntent(message, history);
  if (parsed.kind === "CLARIFY") {
    return { kind: "NEEDS_CLARIFICATION", question: "What would you like me to do?" };
  }

  return { kind: "EXECUTABLE", spec: parsed.spec };
}
