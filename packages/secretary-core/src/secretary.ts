// ---------------------------------------------------------------------------
// Secretary — Intake / Intent Translator
//
// Sits between Benson (UI face) and Maestro (executor).
// Converts a raw user message + conversation history into a fully-specified
// TaskSpec the rest of the system can act on without guesswork.
//
// Responsibilities:
//   - Extract intent, goals, constraints
//   - Determine permissions (read-only vs write, shell execution, etc.)
//   - Determine required output format (code-in-chat, file diff, JSON, prose)
// ---------------------------------------------------------------------------

import type { ConversationTurn, TaskSpec } from "./types.js";
import { extractPermissions } from "./permissions.js";
import { extractOutputFormat } from "./outputFormat.js";

// ---------------------------------------------------------------------------
// Stop/filler words for goal extraction
// ---------------------------------------------------------------------------
const SKIP_WORDS = new Set([
  "a", "an", "the", "for", "to", "in", "on", "at", "of",
  "with", "from", "into", "about", "by", "as",
]);

const FILLER = new Set([
  "me", "it", "this", "that", "my", "our", "them", "us",
  "some", "something", "anything", "everything",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractIntent(message: string): string {
  const words = message.toLowerCase().split(/\s+/);
  const verb  = words[0] ?? "process";
  const noun  = words.slice(1).find((w) => !SKIP_WORDS.has(w) && !FILLER.has(w));
  return noun ? `${verb} ${noun}` : verb;
}

function extractGoals(message: string): string[] {
  const parts = message
    .split(/\s+and\s+also\s+|\s+also\s+|\s+and\s+|\s*;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [message.trim()];
}

function extractConstraints(
  message: string,
): Record<string, unknown> | undefined {
  const c: Record<string, unknown> = {};

  const without = message.match(/without\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (without?.[1]) c["without"] = without[1].trim();

  const only = message.match(/\bonly\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (only?.[1]) c["scope"] = only[1].trim();

  const must = message.match(/\bmust\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (must?.[1]) c["required"] = must[1].trim();

  const no = message.match(/\bno\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (no?.[1]) c["forbid"] = no[1].trim();

  return Object.keys(c).length > 0 ? c : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function processRequest(
  message: string,
  history: ConversationTurn[],
): TaskSpec {
  const permissions  = extractPermissions(message);
  const outputFormat = extractOutputFormat(message);

  const spec: TaskSpec = {
    originalUserMessage: message,
    intent:      extractIntent(message),
    goals:       extractGoals(message),
    constraints: extractConstraints(message),
    permissions,
    outputFormat,
  };

  // Inject recent history so Maestro can resolve references like
  // "that function" or "do the same for the other component".
  if (history.length > 0) {
    spec.context = {
      conversationHistory: history.map((t) => ({
        user:      t.user,
        assistant: t.assistant,
      })),
    };
  }

  return spec;
}
