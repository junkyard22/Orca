import { describe, it, expect } from "vitest";
import { getRolePrompt, ROLE_PROMPTS } from "./rolePrompts.js";

describe("getRolePrompt — dynamic tool availability", () => {
  it("omitting availableToolNames preserves the legacy static reminder (backward compat)", () => {
    const withNoArg = getRolePrompt("narrator");
    expect(withNoArg).toContain("You have access to tools (read_file, write_file, run_command, list_directory, search_files).");
  });

  it("an empty array (zero tools) omits tool-usage guidance entirely", () => {
    const prompt = getRolePrompt("narrator", []);
    expect(prompt).not.toContain("You have access to tools");
    expect(prompt).not.toContain("Use the available tools");
    expect(prompt).not.toMatch(/must (call|use) (a |the )?(tool|tools)/i);
  });

  it("a non-empty array uses generic guidance without hardcoding any tool name", () => {
    const prompt = getRolePrompt("narrator", ["read_file", "docs_read"]);
    expect(prompt).toContain("Use the available tools listed in this prompt");
    // The dynamic reminder itself must never name a specific tool — the
    // real catalog (formatForPrompt()) is responsible for that, appended
    // separately by the agent loop.
    expect(prompt).not.toMatch(/available tools \(read_file/i);
  });

  it("still ends with the shared NO_CHAT_RULES block regardless of tool availability", () => {
    for (const toolNames of [undefined, [], ["read_file"]]) {
      const prompt = getRolePrompt("narrator", toolNames);
      expect(prompt).toContain("EXECUTION RULES — NO EXCEPTIONS:");
    }
  });

  it("works for every role name without throwing, in all three tool-availability states", () => {
    for (const role of Object.keys(ROLE_PROMPTS) as Array<keyof typeof ROLE_PROMPTS>) {
      expect(() => getRolePrompt(role, undefined)).not.toThrow();
      expect(() => getRolePrompt(role, [])).not.toThrow();
      expect(() => getRolePrompt(role, ["read_file"])).not.toThrow();
    }
  });
});

describe("role prompts — no unconditional write-tool claims for write-less-by-default roles", () => {
  it("narrator's base prompt only calls for a write tool conditionally", () => {
    const prompt = getRolePrompt("narrator", ["read_file", "docs_read"]); // no write tool in this list
    // Must not contain an unconditional "you MUST use write_file" — the
    // instruction has to be gated on a write tool actually being available.
    expect(prompt).not.toMatch(/MUST (use|call) write_file/);
  });

  it("brain's base prompt only calls for a write tool conditionally", () => {
    const prompt = getRolePrompt("brain", ["read_file", "list_directory"]); // read-only
    expect(prompt).not.toMatch(/MUST call write_file/);
  });
});
