import type { CapabilityGroup } from "maestro-core";

/**
 * Explicit, whole-capability prohibitions in the user's own request.
 *
 * This is a trusted, deterministic restriction source. It reads only the
 * verbatim request (never Brain output, tool output or task context) and its
 * only possible effect is to withhold a capability: it returns capabilities to
 * prohibit and has no way to grant one. A false positive therefore narrows a
 * task; it can never widen one.
 *
 * Deliberately conservative about what counts as whole-capability:
 *  - "do not modify any files", "don't change anything", "without making any
 *    changes", "leave the files untouched" → filesystem-write
 *  - "don't execute commands", "do not run anything", "don't use the shell"
 *    → shell
 * Object-specific prohibitions ("don't modify the tests", "don't run the
 * tests") and exception-scoped ones ("don't modify any files other than
 * README.md") are not whole-capability and are left to the existing contract,
 * Pappy and Miranda checks, so ordinary authorized edits keep working.
 * A later "go ahead and edit it" does not lift a prohibition: an explicit
 * prohibition fails closed.
 */

const NEGATION = String.raw`(?:do\s+not|don['’]?t|never|must\s+not|mustn['’]?t|should\s+not|shouldn['’]?t|can\s*not|can['’]?t|are\s+not\s+to|without|avoid|refrain\s+from)`;
const ADVERB = String.raw`(?:\s+(?:actually|ever|yet|directly|manually|accidentally|go\s+(?:and\s+)?|try\s+to|attempt\s+to))?`;
/** "other than README.md", "except src/a.ts": a scoped allowance, not a blanket prohibition. */
const EXCEPTION = String.raw`(?!\s*,?\s*(?:except|other\s+than|besides|apart\s+from|aside\s+from|outside(?:\s+of)?|beyond|save\s+for|excluding)\b)`;
/**
 * The object must end the phrase. "don't modify any files." is a blanket
 * prohibition; "don't update code comments" or "don't run commands that
 * delete data" name something narrower and are not.
 */
const END = String.raw`(?=\s*(?:[.,;:!?)\n]|$|(?:at\s+all|whatsoever|in\s+(?:this|the|your|my)\s+(?:repo(?:sitory)?|workspace|project|codebase)|and|or|yet|for\s+now|now|please|just|instead|here)\b))`;

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

export function explicitUserProhibitions(request: unknown): CapabilityGroup[] {
  if (typeof request !== "string" || request.length === 0) return [];
  const prohibits: CapabilityGroup[] = [];
  if (WRITE_PROHIBITIONS.some((pattern) => pattern.test(request))) prohibits.push("filesystem-write");
  if (SHELL_PROHIBITIONS.some((pattern) => pattern.test(request))) prohibits.push("shell");
  return prohibits;
}
