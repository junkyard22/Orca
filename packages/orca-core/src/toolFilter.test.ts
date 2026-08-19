import { describe, it, expect, vi } from "vitest";
import { createFilteredToolService, extractToolNamesFromPrompt } from "./toolFilter.js";
import type { OrcaToolService } from "./types.js";

function makeToolService(toolNames: string[]): OrcaToolService {
  const prompt = toolNames
    .map((name) => `**${name}** — does something\n  - arg1: string`)
    .join("\n");
  return {
    execute: vi.fn(async (_name: string) => ({ ok: true, output: "ok" })),
    formatForPrompt: vi.fn(() => prompt),
  };
}

describe("createFilteredToolService", () => {
  it("blocks disallowed tools with a descriptive error, without calling the underlying tool", async () => {
    const tools = makeToolService(["read_file", "write_file"]);
    const filtered = createFilteredToolService(tools, ["read_file"]);

    const result = await filtered.execute("write_file", { path: "x.ts" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/write_file/);
    expect(result.error).toMatch(/read_file/); // allowed list surfaced to the model
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("allows permitted tools through unchanged", async () => {
    const tools = makeToolService(["read_file", "write_file"]);
    const filtered = createFilteredToolService(tools, ["read_file"]);

    const result = await filtered.execute("read_file", { path: "x.ts" });

    expect(result.ok).toBe(true);
    expect(tools.execute).toHaveBeenCalledWith("read_file", { path: "x.ts" });
  });

  it("strips disallowed tool descriptions from formatForPrompt", () => {
    const tools = makeToolService(["read_file", "write_file", "run_command"]);
    const filtered = createFilteredToolService(tools, ["read_file"]);

    const prompt = filtered.formatForPrompt();

    expect(prompt).toContain("read_file");
    expect(prompt).not.toContain("write_file");
    expect(prompt).not.toContain("run_command");
  });

  it("produces an empty-tool-name allowed list that blocks everything", async () => {
    const tools = makeToolService(["read_file"]);
    const filtered = createFilteredToolService(tools, []);

    const result = await filtered.execute("read_file", {});

    expect(result.ok).toBe(false);
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("strips disallowed hyphenated MCP tool names from formatForPrompt (regression: \\w alone never matches a hyphen)", () => {
    const tools = makeToolService([
      "read_file",
      "desktop-commander_write_file",
      "desktop-commander_execute_command",
      "github-mcp_create_pull_request",
    ]);
    const filtered = createFilteredToolService(tools, ["read_file"]);

    const prompt = filtered.formatForPrompt();

    expect(prompt).toContain("read_file");
    expect(prompt).not.toContain("desktop-commander_write_file");
    expect(prompt).not.toContain("desktop-commander_execute_command");
    expect(prompt).not.toContain("github-mcp_create_pull_request");
  });

  it("keeps an allowed hyphenated MCP tool name in formatForPrompt", () => {
    const tools = makeToolService(["desktop-commander_read_file", "desktop-commander_write_file"]);
    const filtered = createFilteredToolService(tools, ["desktop-commander_read_file"]);

    const prompt = filtered.formatForPrompt();

    expect(prompt).toContain("desktop-commander_read_file");
    expect(prompt).not.toContain("desktop-commander_write_file");
  });
});

describe("extractToolNamesFromPrompt", () => {
  it("extracts tool names from a formatted prompt block", () => {
    const tools = makeToolService(["read_file", "write_file"]);
    const names = extractToolNamesFromPrompt(tools.formatForPrompt());
    expect(names).toEqual(["read_file", "write_file"]);
  });

  it("extracts hyphenated MCP tool names (regression)", () => {
    const tools = makeToolService(["desktop-commander_execute_command", "github-mcp_create_pull_request"]);
    const names = extractToolNamesFromPrompt(tools.formatForPrompt());
    expect(names).toEqual(["desktop-commander_execute_command", "github-mcp_create_pull_request"]);
  });

  it("returns an empty array for an empty prompt", () => {
    expect(extractToolNamesFromPrompt("")).toEqual([]);
  });
});
