import { describe, expect, it } from "vitest";
import { normalizeTaskSpec } from "./helpers.js";

describe("normalizeTaskSpec", () => {
  it("converts Benson's legacy read-only permission array into boolean flags without a tool whitelist", () => {
    const task = normalizeTaskSpec({
      originalUserMessage: "Explain package.json",
      intent: "explain package.json",
      goals: ["Explain package.json"],
      permissions: ["read"] as any,
    });

    expect(task.permissions).toEqual({
      fileRead: true,
      fileWrite: false,
      shellExec: false,
    });
    // No toolsAllowed — dynamic MCP tools must not be blocked
    expect(task.permissions?.toolsAllowed).toBeUndefined();
  });

  it("sets fileWrite and shellExec true for write+shell permissions without a tool whitelist", () => {
    const task = normalizeTaskSpec({
      originalUserMessage: "Run tests and update the report",
      intent: "run tests",
      goals: ["Run tests", "Update the report"],
      permissions: ["read", "write", "shell", "network"] as any,
    });

    expect(task.permissions?.fileWrite).toBe(true);
    expect(task.permissions?.shellExec).toBe(true);
    // No whitelist — all registered tools (including MCP) are available
    expect(task.permissions?.toolsAllowed).toBeUndefined();
  });
});
