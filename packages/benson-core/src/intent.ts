import type { ParseResult } from "./types.js";

// ---------------------------------------------------------------------------
// Vague-verb detection
// ---------------------------------------------------------------------------

const VAGUE_VERBS = new Set([
  "help", "fix", "update", "improve", "make", "do", "change", "work",
  "handle", "deal", "check", "look", "review", "go", "run", "try",
  "test", "use", "get", "set", "add", "remove", "process", "manage",
]);

const FILLER_WORDS = new Set([
  "me", "it", "this", "that", "the", "a", "an", "my", "our",
  "them", "us", "some", "something", "anything", "everything",
]);

// Per-verb safe default options shown in CLARIFY responses
const VERB_OPTIONS: Record<string, [string, string, string]> = {
  help:    ["Write or fix code",          "Explain a concept",          "Review something"],
  fix:     ["Fix a specific bug or error", "Fix formatting or style",   "Fix failing tests"],
  update:  ["Update documentation",        "Update existing code",      "Update configuration"],
  improve: ["Improve code quality",        "Improve performance",        "Improve documentation"],
  make:    ["Create a new file or module", "Generate documentation",    "Build a feature"],
  add:     ["Add a new feature",           "Add tests",                 "Add documentation"],
  remove:  ["Remove unused code",          "Remove a dependency",       "Remove a feature"],
  review:  ["Review code quality",         "Review for bugs",           "Review documentation"],
  check:   ["Check for errors",            "Check test coverage",       "Check dependencies"],
  run:     ["Run tests",                   "Run a build",               "Run a script"],
  write:   ["Write code",                  "Write documentation",       "Write tests"],
};

const DEFAULT_OPTIONS: [string, string, string] = [
  "Create or modify code",
  "Write documentation",
  "Explain or review something",
];

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------

function isAmbiguous(message: string): boolean {
  const words = message.trim().toLowerCase().split(/\s+/);

  // Filter out filler + vague verbs to see if anything specific remains
  const meaningful = words.filter(
    (w) => !VAGUE_VERBS.has(w) && !FILLER_WORDS.has(w)
  );

  // Truly empty after filtering (e.g. "help me", "fix it", "do something")
  if (meaningful.length === 0) return true;

  // Single bare word that is itself vague (e.g. "help", "fix")
  if (words.length === 1 && VAGUE_VERBS.has(words[0] ?? "")) return true;

  // Short message whose first word is a vague verb AND nothing specific follows
  if (words.length <= 4 && VAGUE_VERBS.has(words[0] ?? "")) {
    const hasSpecificNoun = words
      .slice(1)
      .some((w) => !FILLER_WORDS.has(w) && !VAGUE_VERBS.has(w));
    if (!hasSpecificNoun) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// CLARIFY builder
// ---------------------------------------------------------------------------

function buildClarify(message: string): ParseResult {
  const firstWord = message.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const options = VERB_OPTIONS[firstWord] ?? DEFAULT_OPTIONS;

  return {
    kind: "CLARIFY",
    text: "Could you be a bit more specific about what you need?",
    options: [...options],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parseIntent(message: string): ParseResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      kind: "CLARIFY",
      text: "What would you like me to help with?",
      options: [...DEFAULT_OPTIONS],
    };
  }

  if (isAmbiguous(trimmed)) {
    return buildClarify(trimmed);
  }

  return { kind: "TASK" };
}
