import type { Message, OutputFormat, ParseResult, Permission, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Ambiguity detection — clarification is the EXCEPTION
// ---------------------------------------------------------------------------

const AMBIGUOUS_PATTERNS = [
  /^(help|hello|hi|hey|what can you do|what do you do)\??$/i,  // pure greeting
  /^.{1,8}$/,                                                    // too short to parse (<9 chars)
  /^(yes|no|ok|okay|sure|maybe|idk|dunno)$/i,                   // single-word response with no prior context
];

// Phrases that mean "redo the previous task"
const RETRY_PATTERNS = [
  /^(try again|retry|redo|do it again|run it again|try it again|try once more|one more time|again)\.?$/i,
];

function isAmbiguous(message: string, history?: Message[]): boolean {
  const trimmed = message.trim();
  
  // Empty message
  if (!trimmed) return true;
  
  // Check against explicit ambiguous patterns
  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Exception: if we have history, "yes"/"no" might be meaningful
      if (/^(yes|no|ok|okay|sure|maybe|idk|dunno)$/i.test(trimmed)) {
        if (history && history.length > 0) {
          return false; // Has context, not ambiguous
        }
      }
      return true;
    }
  }
  
  return false;
}

// ---------------------------------------------------------------------------
// Intent extraction — rule-based, LLM fallback only if rules fail
// ---------------------------------------------------------------------------

const ACTION_VERBS = [
  'create', 'make', 'build', 'write', 'generate', 'add',
  'fix', 'debug', 'resolve', 'repair', 'correct',
  'read', 'open', 'load', 'get', 'fetch', 'find', 'search',
  'explain', 'describe', 'summarize', 'analyze', 'review',
  'update', 'edit', 'modify', 'change', 'refactor', 'rename',
  'delete', 'remove', 'clean',
  'run', 'execute', 'test', 'check', 'deploy',
  'help', 'show', 'list',
];

function extractLeadingVerb(message: string): string | null {
  const lower = message.toLowerCase();
  for (const verb of ACTION_VERBS) {
    // Check if message starts with this verb (as a word boundary)
    const regex = new RegExp(`^\\b${verb}\\b`, 'i');
    if (regex.test(lower)) {
      return verb;
    }
  }
  return null;
}

function extractIntent(message: string): string {
  const verb = extractLeadingVerb(message);
  if (!verb) {
    // Fallback: use first few words as intent
    const words = message.split(/\s+/).slice(0, 3);
    return words.join(' ');
  }
  
  // Extract noun phrase after verb
  const skipWords = new Set(['a', 'an', 'the', 'to', 'for', 'me', 'it', 'this', 'that']);
  const words = message.split(/\s+/);
  const nounStart = words.findIndex((w, i) => {
    if (i === 0 && w.toLowerCase() === verb) return false;
    return !skipWords.has(w.toLowerCase());
  });
  
  if (nounStart === -1) return verb;
  
  const nounPhrase = words.slice(nounStart).join(' ');
  return `${verb} ${nounPhrase}`.trim();
}

function extractGoals(message: string): string[] {
  // Split on multi-goal delimiters
  const delimiters = /\s+and then\s+|\s+then\s+|\s+also\s+|\s+additionally\s+|\s*;\s*/;
  const parts = message
    .split(delimiters)
    .map((p) => p.trim())
    .filter(Boolean);
  
  // If no delimiters found, return single goal
  if (parts.length <= 1) {
    return [message.trim()];
  }
  
  return parts;
}

function extractConstraints(message: string): Record<string, unknown> | undefined {
  const c: Record<string, unknown> = {};
  
  // "without X"
  const without = message.match(/without\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (without?.[1]) c["without"] = without[1].trim();
  
  // "don't X" / "do not X"
  const dont = message.match(/(?:don't|do not)\s+([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (dont?.[1]) c["dont"] = dont[1].trim();
  
  // "make sure X"
  const makeSure = message.match(/make sure (?:that )?([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (makeSure?.[1]) c["must"] = makeSure[1].trim();
  
  // "must be X" / "must X"
  const must = message.match(/\bmust\s+(?:be\s+)?([\w][\w\s]*?)(?:\s*,|\s+and\b|\s*$)/i);
  if (must?.[1] && !c["must"]) c["must"] = must[1].trim();
  
  return Object.keys(c).length > 0 ? c : undefined;
}

function extractPermissions(message: string): Permission[] {
  const permissions: Permission[] = ["read"];

  const writeSignals = /\b(create|write|save|edit|modify|update|delete|remove|add|append)\b/i;
  const shellSignals = /\b(run|execute|install|build|test|deploy|compile|start|stop)\b/i;
  const networkSignals = /\b(fetch|download|upload|request|call|api|url|http)\b/i;

  if (writeSignals.test(message)) permissions.push("write");
  if (shellSignals.test(message)) permissions.push("shell");
  if (networkSignals.test(message)) permissions.push("network");

  return permissions;
}

function extractOutputFormat(message: string): OutputFormat {
  if (/\b(bullet|list|points?)\b/i.test(message)) return "bullets";
  if (/\b(table|tabular|columns?)\b/i.test(message)) return "table";
  if (/\b(json|structured|machine.readable)\b/i.test(message)) return "json";
  if (/\b(diff|patch|changes?)\b/i.test(message)) return "file_diff";
  if (/\b(code|function|class|script|implement)\b/i.test(message)) return "code";
  return "prose";
}

function extractContext(message: string, history?: Message[]): Record<string, unknown> | undefined {
  const ctx: Record<string, unknown> = {};
  
  // Extract file paths (simple pattern: word.extension or path/to/file.ext)
  const filePattern = /[\w./\\-]+\.(ts|tsx|js|jsx|py|json|yaml|yml|md|txt|rs|go|java|c|cpp|h|hpp|css|html|xml|sql|sh|bash|zsh)/gi;
  const files = message.match(filePattern);
  if (files && files.length > 0) {
    ctx["files"] = files;
  }
  
  // Extract URLs
  const urlPattern = /https?:\/\/[\w./?=&-]+/gi;
  const urls = message.match(urlPattern);
  if (urls && urls.length > 0) {
    ctx["urls"] = urls;
  }
  
  // Thread history if provided using the key the downstream agent path reads.
  if (history && history.length > 0) {
    ctx["conversationHistory"] = history;
  }
  
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

// ---------------------------------------------------------------------------
// CLARIFY builder — specific, minimal, non-developer-centric
// ---------------------------------------------------------------------------

const CLARIFY_OPTIONS: [string, string, string, string] = [
  "Create something new",
  "Fix or improve existing work",
  "Explain or analyze something",
  "Run or automate a task",
];

function buildClarify(): ParseResult {
  return {
    kind: "CLARIFY",
    text: "I can help with that — what would you like me to do?",
    options: [...CLARIFY_OPTIONS],
  };
}

// ---------------------------------------------------------------------------
// Build TaskSpec
// ---------------------------------------------------------------------------

function buildTaskSpec(message: string, history?: Message[]): TaskSpec {
  const extractedContext = extractContext(message, history);

  return {
    originalUserMessage: message,
    intent: extractIntent(message),
    goals: extractGoals(message),
    constraints: extractConstraints(message),
    permissions: extractPermissions(message),
    outputFormat: extractOutputFormat(message),
    context: {
      ...extractedContext,
      conversationHistory: history ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function isRetryMessage(message: string): boolean {
  const trimmed = message.trim();
  return RETRY_PATTERNS.some((p) => p.test(trimmed));
}

export function parseIntent(message: string, history?: Message[]): ParseResult {
  const trimmed = message.trim();
  
  // Check for ambiguity
  if (isAmbiguous(trimmed, history)) {
    return buildClarify();
  }
  
  // Build and return task spec
  const spec = buildTaskSpec(message, history);
  
  return {
    kind: "TASK",
    spec,
  };
}
