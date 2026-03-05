// ---------------------------------------------------------------------------
// Permissions extractor
//
// Determines what the system is allowed to do for this request.
// Conservative by default — only escalate when the user is explicit.
// ---------------------------------------------------------------------------

import type { TaskPermissions } from "./types.js";

/** Explicit file-write / create / save language */
const WRITE_PATTERNS = /\b(save( (it|this|that|the (code|file|result|output)) (to|as|in))?|write (it |the (code|function|file) )?to|create (a )?file|output to (a )?file|generate (a )?file|store (it|this|that) (in|to|as) (a )?file|put (it|this) in (a )?file)\b/i;

/** Explicit shell / command execution language */
const SHELL_PATTERNS = /\b(run|execute|shell|bash|cmd|powershell|npm|pnpm|node|git|python|pip)\b/i;

/** Read-only read/search/list/explain language — never needs write */
const READONLY_PATTERNS = /\b(read|show|display|list|find|search|explain|describe|summarize|what (is|are|does)|how does|tell me about)\b/i;

/**
 * Code-generation verb + artifact noun: "write a function", "implement a class", etc.
 * These requests are answered by producing code text — no file exploration needed.
 */
const CODE_GEN_VERB = /\b(write|implement|create|build|make|add|code|generate|define)\b/i;
const CODE_GEN_NOUN = /\b(function|method|class|hook|component|algorithm|handler|helper|utility|script|module|interface|type|enum|struct|endpoint|middleware|route|service|controller|reducer|action|decorator|plugin)\b/i;

/**
 * Indicators that the task involves a specific file or existing codebase context,
 * meaning the model will need to read/explore files before producing output.
 */
const HAS_FILE_CONTEXT = /\.\w{1,6}\b|\w[/\\]\w|\b(existing|codebase|repository|the project|our code|add (it )?to|in the file|in this file|modify the|update the|edit the|matching (existing|current|our))\b/i;

/**
 * Return true when the request is a standalone code-generation task with no
 * file context — the model can answer purely from knowledge.
 */
function isPureCodeGen(message: string): boolean {
  return (
    CODE_GEN_VERB.test(message) &&
    CODE_GEN_NOUN.test(message) &&
    !HAS_FILE_CONTEXT.test(message) &&
    !WRITE_PATTERNS.test(message)
  );
}

export function extractPermissions(message: string): TaskPermissions {
  const wantsWrite = WRITE_PATTERNS.test(message);
  const wantsShell = SHELL_PATTERNS.test(message);
  const isReadOnly = !wantsWrite && READONLY_PATTERNS.test(message);
  const pureCodeGen = !wantsWrite && !wantsShell && isPureCodeGen(message);

  return {
    fileRead:    !pureCodeGen,
    fileWrite:   wantsWrite,
    shellExec:   wantsShell && !isReadOnly,
    toolsAllowed: buildAllowedTools(wantsWrite, wantsShell && !isReadOnly, pureCodeGen),
  };
}

function buildAllowedTools(fileWrite: boolean, shellExec: boolean, pureCodeGen: boolean): string[] {
  // Pure code-gen requests (e.g. "write a hello world function") need no file tools.
  // The model should produce code directly without wandering the workspace.
  if (pureCodeGen) return [];

  const tools = ["read_file", "list_directory", "search_files"];
  if (fileWrite) tools.push("write_file");
  if (shellExec) tools.push("run_command");
  return tools;
}
