import { describe, expect, it } from "vitest";
import { normalizeTaskSpec } from "./helpers.js";

describe("normalizeTaskSpec", () => {
  it("converts Benson's legacy read-only permission array into a concrete tool allowlist", () => {
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
      toolsAllowed: [
        "read_file",
        "list_directory",
        "search_files",
        "docs_read",
        "docs_list",
      ],
    });
  });

  it("includes write, shell, and network tools when the legacy permission array requests them", () => {
    const task = normalizeTaskSpec({
      originalUserMessage: "Run tests and update the report",
      intent: "run tests",
      goals: ["Run tests", "Update the report"],
      permissions: ["read", "write", "shell", "network"] as any,
    });

    expect(task.permissions?.toolsAllowed).toContain("write_file");
    expect(task.permissions?.toolsAllowed).toContain("run_command");
    expect(task.permissions?.toolsAllowed).toContain("web_search");
    expect(task.permissions?.toolsAllowed).toContain("github_get_pr");
  });
});
