// Types
export type {
  Tool,
  ToolResult,
  ToolRunCtx,
  ToolSchema,
  ToolParameterSchema,
} from "./types.js";

// Registry
export { ToolRegistry } from "./registry.js";

// Sandbox policy system
export {
  evaluateCommandPolicy,
  createSandboxPolicy,
  DEFAULT_SANDBOX_POLICY,
} from "./sandbox.js";

export type {
  SandboxPolicy,
  CommandPolicyResult,
  CommandCategory,
} from "./sandbox.js";

// Core tools (individually exported so callers can cherry-pick)
export { readFileTool } from "./readFileTool.js";
export { writeFileTool } from "./writeFileTool.js";
export { runCommandTool } from "./runCommandTool.js";
export { listDirectoryTool } from "./listDirectoryTool.js";
export { searchFilesTool } from "./searchFilesTool.js";

// ---------------------------------------------------------------------------
// Factory — creates a ToolRegistry pre-loaded with all five core tools.
//
// Usage (apps/runner):
//   import { createCoreToolRegistry } from "@yakstacks/workbench-core";
//   const registry = createCoreToolRegistry();
// ---------------------------------------------------------------------------

import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./readFileTool.js";
import { writeFileTool } from "./writeFileTool.js";
import { runCommandTool } from "./runCommandTool.js";
import { listDirectoryTool } from "./listDirectoryTool.js";
import { searchFilesTool } from "./searchFilesTool.js";

export function createCoreToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(runCommandTool)
    .register(listDirectoryTool)
    .register(searchFilesTool);
}
