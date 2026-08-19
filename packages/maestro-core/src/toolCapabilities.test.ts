import { describe, it, expect } from "vitest";
import {
  classifyToolCapability,
  resolveAllowedToolNames,
  isCapabilityGroup,
  DEFAULT_ROLE_CAPABILITIES,
} from "./toolCapabilities.js";

describe("classifyToolCapability", () => {
  it("classifies known core tools by exact name", () => {
    expect(classifyToolCapability("read_file")).toBe("filesystem-read");
    expect(classifyToolCapability("list_directory")).toBe("filesystem-read");
    expect(classifyToolCapability("search_files")).toBe("filesystem-read");
    expect(classifyToolCapability("write_file")).toBe("filesystem-write");
    expect(classifyToolCapability("run_command")).toBe("shell");
  });

  it("classifies known ext-github/ext-docs/ext-web tools by exact name", () => {
    expect(classifyToolCapability("github_list_prs")).toBe("github-read");
    expect(classifyToolCapability("github_get_pr")).toBe("github-read");
    expect(classifyToolCapability("github_list_issues")).toBe("github-read");
    expect(classifyToolCapability("github_list_repos")).toBe("github-read");
    expect(classifyToolCapability("github_clone_repo")).toBe("github-write");
    expect(classifyToolCapability("docs_read")).toBe("documentation");
    expect(classifyToolCapability("docs_list")).toBe("documentation");
    expect(classifyToolCapability("web_fetch")).toBe("web");
    expect(classifyToolCapability("web_search")).toBe("web");
  });

  it("classifies namespaced MCP tools by verb heuristic", () => {
    expect(classifyToolCapability("desktop-commander_read_file")).toBe("filesystem-read");
    expect(classifyToolCapability("desktop-commander_write_file")).toBe("filesystem-write");
    expect(classifyToolCapability("desktop-commander_execute_command")).toBe("shell");
    expect(classifyToolCapability("desktop-commander_list_processes")).toBe("filesystem-read");
    expect(classifyToolCapability("desktop-commander_kill_process")).toBe("filesystem-write");
    expect(classifyToolCapability("github-mcp_list_pull_requests")).toBe("github-read");
    expect(classifyToolCapability("github-mcp_create_pull_request")).toBe("github-write");
    expect(classifyToolCapability("github-mcp_merge_pull_request")).toBe("github-write");
  });

  it("resolves ambiguous names (both a write and a read verb) to the write group", () => {
    // Destructive verbs are checked before read verbs, so a name containing
    // both never falls through to the "safer" read classification.
    expect(classifyToolCapability("desktop-commander_get_and_delete_thing")).toBe(
      "filesystem-write",
    );
    expect(classifyToolCapability("github-mcp_get_or_delete_branch")).toBe("github-write");
  });

  it("returns null for names matching no verb pattern — never guesses", () => {
    expect(classifyToolCapability("desktop-commander_frobnicate")).toBeNull();
    expect(classifyToolCapability("github-mcp_zzz")).toBeNull();
    expect(classifyToolCapability("totally_unknown_tool")).toBeNull();
  });
});

describe("resolveAllowedToolNames", () => {
  const allToolNames = [
    "read_file",
    "write_file",
    "run_command",
    "github_list_prs",
    "github_clone_repo",
    "desktop-commander_execute_command",
    "desktop-commander_frobnicate", // unclassified
  ];

  it("includes only tools matching the requested capability groups", () => {
    const result = resolveAllowedToolNames(allToolNames, ["filesystem-read"]);
    expect(result).toEqual(["read_file"]);
  });

  it("excludes unclassified tools even when groups are broad", () => {
    const result = resolveAllowedToolNames(allToolNames, [
      "filesystem-read",
      "filesystem-write",
      "shell",
      "github-read",
      "github-write",
    ]);
    expect(result).not.toContain("desktop-commander_frobnicate");
  });

  it("returns an empty list for an empty group list (e.g. brain)", () => {
    expect(resolveAllowedToolNames(allToolNames, DEFAULT_ROLE_CAPABILITIES.brain)).toEqual([]);
  });

  it("narrator's default capabilities exclude filesystem-write", () => {
    const result = resolveAllowedToolNames(allToolNames, DEFAULT_ROLE_CAPABILITIES.narrator);
    expect(result).not.toContain("write_file");
    expect(result).toContain("read_file");
  });
});

describe("isCapabilityGroup", () => {
  it("accepts known group names", () => {
    expect(isCapabilityGroup("filesystem-read")).toBe(true);
    expect(isCapabilityGroup("github-write")).toBe(true);
  });

  it("rejects unrecognized names (settings JSON can contain typos)", () => {
    expect(isCapabilityGroup("filesystem-delete")).toBe(false);
    expect(isCapabilityGroup("")).toBe(false);
  });
});
