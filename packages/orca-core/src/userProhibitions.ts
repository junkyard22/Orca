import type { CapabilityGroup } from "maestro-core";

/**
 * Explicit prohibitions in the user's own request.
 *
 * This is a trusted, deterministic restriction source. It reads only the
 * verbatim request (never Brain output, tool output or task context) and its
 * only possible effect is to withhold authority: it returns capabilities to
 * prohibit and, optionally, the only files that may be written. It has no way
 * to grant anything. A false positive therefore narrows a task; it can never
 * widen one.
 *
 *  - Blanket no-write ("do not modify any files", "don't change anything",
 *    "without making any changes") → filesystem-write AND shell. An approved
 *    command is host access and could change files, so a no-write task fails
 *    closed on shell; approval cannot override the prohibition.
 *  - Scoped write ("Modify README.md, but do not change any other files",
 *    "only edit README.md", "don't touch any files except README.md")
 *    → writes are limited to the files the user named, and shell is withheld
 *    for the same reason. No named file means no writes at all.
 *  - Explicit no-execute ("don't execute commands", "don't use the shell")
 *    → shell.
 * Object-specific prohibitions ("don't modify the tests", "don't run the
 * tests") are not blanket and are left to the existing contract, Pappy and
 * Miranda checks, so ordinary authorized edits keep working. A later
 * "go ahead and edit it" does not lift a prohibition: it fails closed.
 */
export interface UserRestrictions {
  prohibits: CapabilityGroup[];
  /** When present, the only files (as the user named them) that may be written. */
  writeScope?: string[];
}

const NEGATION = String.raw`(?:do\s+not|don['’]?t|never|must\s+not|mustn['’]?t|should\s+not|shouldn['’]?t|can\s*not|can['’]?t|are\s+not\s+to|without|avoid|refrain\s+from)`;
const ADVERB = String.raw`(?:\s+(?:actually|ever|yet|directly|manually|accidentally|go\s+(?:and\s+)?|try\s+to|attempt\s+to))?`;
const EXCEPTION_WORD = String.raw`(?:except(?:\s+for)?|other\s+than|besides|apart\s+from|aside\s+from|outside(?:\s+of)?|beyond|save\s+for|excluding)`;
/** "other than README.md", "except src/a.ts": a scoped allowance, handled as a write scope. */
const EXCEPTION = String.raw`(?!\s*,?\s*${EXCEPTION_WORD}\b)`;
/**
 * The object must end the phrase. "don't modify any files." is a blanket
 * prohibition; "don't update code comments" or "don't run commands that
 * delete data" name something narrower and are not.
 */
const END = String.raw`(?=\s*(?:[.,;:!?)\n]|$|(?:at\s+all|whatsoever|in\s+(?:this|the|your|my)\s+(?:repo(?:sitory)?|workspace|project|codebase)|and|or|yet|for\s+now|now|please|just|instead|here)\b))`;
/** The rest of a clause, up to a sentence end (a dot inside "README.md" is not one). */
const CLAUSE = String.raw`([^\n;!?]*?)(?=[.;!?](?:\s|$)|\n|$)`;

const WRITE_VERB = String.raw`(?:modify|modifying|change|changing|edit|editing|write|writing|touch|touching|alter|altering|update|updating|overwrite|overwriting|delete|deleting|save|saving|create|creating)`;
const WRITE_OBJECT = String.raw`(?:anything|any\s+(?:of\s+the\s+)?(?:files?|code|source(?:\s+code)?)|(?:the|my|your|this|any)\s+(?:files?|code(?:base)?|source(?:\s+code)?|repo(?:sitory)?|workspace|project|filesystem|file\s+system|disk)|files|code)`;
const CHANGE_NOUN = String.raw`(?:changes?|edits?|modifications?|writes?)`;
const FILE_SCOPE = String.raw`(?:any|the|my|your|this)\s+(?:files?|code(?:base)?|repo(?:sitory)?|workspace|project)`;

const WRITE_PROHIBITIONS: RegExp[] = [
  // do not modify any files / don't change anything / without editing the code
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+${WRITE_VERB}\s+${WRITE_OBJECT}\b${EXCEPTION}${END}`, "i"),
  // don't make any changes / without making changes / don't make any changes to the files
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+(?:make|making|apply|applying)\s+(?:any\s+)?${CHANGE_NOUN}(?:\s+to\s+${FILE_SCOPE})?\b${EXCEPTION}${END}`, "i"),
  // make no changes / no file changes / no changes to (any|the) files
  new RegExp(String.raw`\b(?:make\s+no\s+${CHANGE_NOUN}(?:\s+to\s+${FILE_SCOPE})?|no\s+file\s+${CHANGE_NOUN}|no\s+${CHANGE_NOUN}\s+to\s+${FILE_SCOPE})\b${EXCEPTION}${END}`, "i"),
  // leave (all|the|every|my) files (unchanged|untouched|as they are)
  /\bleave\s+(?:all\s+|the\s+|every\s+|my\s+|your\s+)*(?:files?|code(?:base)?|repo(?:sitory)?|workspace|project)\s+(?:unchanged|untouched|unmodified|alone|as\s+(?:is|they\s+are|it\s+is))\b/i,
];

/** Scoped prohibitions whose allowance is named inside the match (group 1). */
const SCOPE_WITH_ALLOWANCE: RegExp[] = [
  // don't modify any files except README.md / other than src/a.ts
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+${WRITE_VERB}\s+${WRITE_OBJECT}\s*,?\s*${EXCEPTION_WORD}\s+${CLAUSE}`, "i"),
  // only edit README.md / modify only README.md
  new RegExp(String.raw`\bonly\s+(?:modify|change|edit|touch|update|alter|write(?:\s+to)?)\s+${CLAUSE}`, "i"),
  new RegExp(String.raw`\b(?:modify|change|edit|touch|update|alter)\s+only\s+${CLAUSE}`, "i"),
];

/** Scoped prohibitions whose allowance is the files the request asks to change. */
const SCOPE_BY_REQUEST: RegExp[] = [
  // do not change any other files / don't touch anything else
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+${WRITE_VERB}\s+(?:(?:any|the|all)\s+)?other\s+(?:files?|code|parts?\s+of\s+the\s+(?:code(?:base)?|repo(?:sitory)?|project))\b`, "i"),
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+${WRITE_VERB}\s+anything\s+else\b`, "i"),
  // leave all other files unchanged
  /\bleave\s+(?:all\s+|every\s+|any\s+|the\s+)*other\s+(?:files?|code)\s+(?:unchanged|untouched|unmodified|alone|as\s+(?:is|they\s+are))\b/i,
];

const CHANGE_INTENT = /\b(?:modify|change|edit|update|fix|correct|write|rewrite|rename|add|remove|delete|create|refactor|patch|replace|touch|alter|amend)\w*\b/i;
const NEGATED = new RegExp(String.raw`\b${NEGATION}\b`, "i");

/** File names in text: quoted/backticked paths, or bare tokens with an extension. */
function namedFiles(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|((?:[A-Za-z]:)?[\w.\/\\-]*[\w-]\.[A-Za-z0-9]{1,10})(?![\w\/\\-])/g)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /\s/.test(token)) continue;
    if (match[4] === undefined && !/[./\\]/.test(token)) continue;
    files.push(token);
  }
  return files;
}

/** Files named in the clauses of the request that ask for a change (not in its prohibitions). */
function requestedChangeFiles(request: string): string[] {
  const rest = SCOPE_BY_REQUEST.reduce((text, pattern) => text.replace(new RegExp(pattern.source, "gi"), " "), request);
  return rest
    .split(/(?<=[.;!?])\s+|\n+|\s+but\s+|\s+and\s+/i)
    .filter((clause) => CHANGE_INTENT.test(clause) && !NEGATED.test(clause))
    .flatMap(namedFiles);
}

export function userRestrictions(request: unknown): UserRestrictions {
  if (typeof request !== "string" || request.length === 0) return { prohibits: [] };
  const prohibits = new Set<CapabilityGroup>();
  if (SHELL_PROHIBITIONS.some((pattern) => pattern.test(request))) prohibits.add("shell");
  if (WRITE_PROHIBITIONS.some((pattern) => pattern.test(request))) {
    prohibits.add("filesystem-write").add("shell");
    return { prohibits: [...prohibits] };
  }
  const allowance: string[] = [];
  let scoped = false;
  for (const pattern of SCOPE_WITH_ALLOWANCE) {
    for (const match of request.matchAll(new RegExp(pattern.source, "gi"))) {
      scoped = true;
      allowance.push(...namedFiles(match[1] ?? ""));
    }
  }
  if (SCOPE_BY_REQUEST.some((pattern) => pattern.test(request))) {
    scoped = true;
    allowance.push(...requestedChangeFiles(request));
  }
  if (!scoped) return { prohibits: [...prohibits] };
  // A scoped write can still reach any file through an approved command.
  prohibits.add("shell");
  // Scope with nothing named: nothing may be written.
  if (allowance.length === 0) return { prohibits: [...prohibits.add("filesystem-write")] };
  return { prohibits: [...prohibits], writeScope: [...new Set(allowance)] };
}

/** The capabilities the user's request prohibits outright. */
export function explicitUserProhibitions(request: unknown): CapabilityGroup[] {
  return userRestrictions(request).prohibits;
}

const SHELL_VERB = String.raw`(?:run|running|execute|executing|start|starting|launch|launching|invoke|invoking|spawn|spawning)`;
const SHELL_OBJECT = String.raw`(?:anything|any\s+(?:shell\s+|terminal\s+)?(?:commands?|scripts?|programs?|processes?)|(?:the\s+)?(?:shell|terminal)(?:\s+commands?)?|commands?|scripts?|programs?|processes?)`;

const SHELL_PROHIBITIONS: RegExp[] = [
  // don't execute commands / do not run anything / without running any scripts
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+${SHELL_VERB}\s+${SHELL_OBJECT}\b${EXCEPTION}${END}`, "i"),
  // don't use the shell / without using a terminal / do not touch the command line
  new RegExp(String.raw`\b${NEGATION}${ADVERB}\s+(?:use|using|open|opening|touch|touching)\s+(?:the\s+|a\s+|any\s+)?(?:shell|terminal|command\s+line|command\s+prompt|console)\b${END}`, "i"),
  // "No commands." / "no shell" as a standalone instruction
  /(?:^|[.;:!?\n(]\s*)no\s+(?:shell(?:\s+commands?)?|commands?|command\s+execution)\s*(?:[.;:!?)\n]|$)/i,
];
