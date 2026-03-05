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

export function extractPermissions(message: string): TaskPermissions {
  const wantsWrite = WRITE_PATTERNS.test(message);
  const wantsShell = SHELL_PATTERNS.test(message);
  const isReadOnly = !wantsWrite && READONLY_PATTERNS.test(message);

  return {
    fileRead:    true,                         // always allowed
    fileWrite:   wantsWrite,
    shellExec:   wantsShell && !isReadOnly,
    toolsAllowed: buildAllowedTools(wantsWrite, wantsShell && !isReadOnly),
  };
}

function buildAllowedTools(fileWrite: boolean, shellExec: boolean): string[] {
  const tools = ["read_file", "list_directory", "search_files"];
  if (fileWrite) tools.push("write_file");
  if (shellExec) tools.push("run_command");
  return tools;
}
