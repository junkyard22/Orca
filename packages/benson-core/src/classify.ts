import type { Message, TaskSpec } from "./types.js";
import { parseIntent } from "./intent.js";

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type IntentClass = "CONVERSATIONAL" | "NEEDS_CLARIFICATION" | "EXECUTABLE";

export type ClassificationResult =
  | {
      kind: "CONVERSATIONAL";
      /**
       * Pre-crafted reply in Claire's voice. Always present for patterns defined
       * in CONVERSATIONAL_RULES. Undefined only for future free-form matches
       * where Claire should fall back to an LLM call.
       */
      cannedResponse?: string;
    }
  | { kind: "NEEDS_CLARIFICATION"; question: string }
  | { kind: "EXECUTABLE"; spec: TaskSpec };

// ---------------------------------------------------------------------------
// Conversational detection — each pattern carries its canned response.
// No LLM call here or anywhere downstream for these cases.
// ---------------------------------------------------------------------------

interface ConversationalRule {
  pattern: RegExp;
  canned: string;
}

const CONVERSATIONAL_RULES: ConversationalRule[] = [
  {
    pattern: /^(hi|hey|hello|howdy|yo|hiya)\s*[!.]?\s*$/i,
    canned: "Hey! What are you working on?",
  },
  {
    pattern: /^how (are you|are things|is it going|'?s it going|are you doing)\s*[?!.]?\s*$/i,
    canned: "Doing well. What do you need?",
  },
  {
    pattern: /^(thanks?|thank you|ty|thx|cheers|appreciate (it|that)|much appreciated)\s*[!.]?\s*$/i,
    canned: "Anytime.",
  },
  {
    pattern: /^(great|nice|cool|awesome|perfect|excellent|sounds? good|good job|well done)\s*[!.]?\s*$/i,
    canned: "Glad to hear it.",
  },
  {
    pattern: /^what can you (do|help with|help me with)\s*[?.]?\s*$/i,
    canned: "I can write and fix code, run commands, search your codebase, explain things — pretty much anything dev-related. What do you need?",
  },
  {
    pattern: /^what(('?s)|( is)) (your )?(name|purpose|function|role)\s*[?.]?\s*$/i,
    canned: "I'm Claire. What are you working on?",
  },
  {
    pattern: /^who are you\s*[?.]?\s*$/i,
    canned: "I'm Claire. I help you build and fix things. What are you working on?",
  },
  {
    pattern: /^(good )(morning|afternoon|evening|night)\s*[!.]?\s*$/i,
    canned: "Hey! What are you working on?",
  },
  {
    pattern: /^(ok|okay|got it|makes sense|understood|sure thing|sounds good)\s*[!.]?\s*$/i,
    canned: "Got it.",
  },
  {
    pattern: /^that (works?|looks? (right|good|correct)|is (right|correct|great|perfect))\s*[!.]?\s*$/i,
    canned: "Great.",
  },
  {
    pattern: /^that'?s (right|correct|great|perfect|good|fine|nice|helpful)\s*[!.]?\s*$/i,
    canned: "Glad that worked.",
  },
  {
    pattern: /^(sounds? (right|good|great|perfect|correct)|that'?s what i (wanted|needed|meant))\s*[!.]?\s*$/i,
    canned: "Perfect.",
  },
  {
    pattern: /^(wow|amazing|impressive|love it|love that)\s*[!.]?\s*$/i,
    canned: "Happy to help.",
  },
];

function matchConversational(trimmed: string): string | null {
  for (const rule of CONVERSATIONAL_RULES) {
    if (rule.pattern.test(trimmed)) return rule.canned;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Needs-clarification detection — task implied but target is missing.
// Questions are already naturally phrased — no LLM rephrasing needed.
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
  // Vague references ("fix it") are answerable from context if history exists.
  if (history && history.length > 0) return null;

  for (const rule of CLARIFY_RULES) {
    if (rule.pattern.test(trimmed)) return rule.question;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a user message into one of three buckets:
 *
 * - CONVERSATIONAL  — no pipeline action needed; return cannedResponse directly
 * - NEEDS_CLARIFICATION — task intent present but underspecified; return question directly
 * - EXECUTABLE      — full task spec ready; route to the Brain/pipeline
 *
 * This function never makes an LLM call.
 */
export function classifyIntent(message: string, history?: Message[]): ClassificationResult {
  const trimmed = message.trim();

  if (!trimmed) {
    return { kind: "NEEDS_CLARIFICATION", question: "What's on your mind?" };
  }

  const canned = matchConversational(trimmed);
  if (canned !== null) {
    return { kind: "CONVERSATIONAL", cannedResponse: canned };
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
