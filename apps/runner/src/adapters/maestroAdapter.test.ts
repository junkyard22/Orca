import { describe, expect, it, vi } from "vitest";
import type { OrcaRunCtx, OrcaTaskSpec } from "@clawde/orca-core";
import type { GateResult, MirandaGate } from "@clawde/miranda-core";

vi.mock("@clawde/dewey-core", () => ({
  Dewey: class {
    async startSession() {
      return undefined;
    }
    async brief() {
      return {
        userName: "Test User",
        suggestedTone: "neutral",
        relevantPreferences: [],
        relevantContext: [],
      };
    }
    async reviewPlan() {
      return {
        approved: true,
        concerns: [],
        suggestions: [],
      };
    }
    async observe() {
      return undefined;
    }
  },
}));

import {
  createMaestroAdapter,
  deriveDeweySignals,
  normalizeConversationHistory,
  normalizeToolText,
  shouldAttemptSubagentDecomposition,
  parseToolCalls,
  formatToolResult,
  resolveRoleToolNames,
  type OrcaSettings,
} from "./maestroAdapter.js";
import type { OrcaToolService } from "@clawde/orca-core";

function makeTask(message = "Say hello."): OrcaTaskSpec {
  return {
    originalUserMessage: message,
    intent: "answer",
    goals: ["Answer the user"],
    permissions: {
      fileRead: false,
      fileWrite: false,
      shellExec: false,
      toolsAllowed: [],
    },
  };
}

function makeGate(result: GateResult): MirandaGate {
  const pass: GateResult = {
    allowed: true,
    reason: "pass",
    verdict: "PASS",
  };
  return {
    beforeLLMCall: vi.fn(() => result),
    afterLLMCall: vi.fn(() => pass),
    beforeToolRun: vi.fn(() => pass),
    afterToolRun: vi.fn(() => pass),
    beforeQC: vi.fn(() => pass),
    afterQC: vi.fn(() => pass),
  };
}

function makeRunCtx(overrides: Partial<OrcaRunCtx> = {}): OrcaRunCtx {
  return {
    runId: "maestro-test-run",
    model: "test-model",
    llm: {
      complete: vi.fn(async () => ({ text: "brain" })),
      stream: vi.fn(async (_prompt, _options, onChunk) => {
        onChunk("No-tools response.");
        return { text: "No-tools response." };
      }),
    },
    ...overrides,
  };
}

describe("no-tools beforeLLMCall gate", () => {
  it("allows PASS through the live ctx.llm.stream path", async () => {
    const adapter = createMaestroAdapter();
    const gate = makeGate({ allowed: true, reason: "ok", verdict: "PASS" });
    const ctx = makeRunCtx({ gate });

    const result = await adapter.run(makeTask(), ctx);

    expect(ctx.llm.stream).toHaveBeenCalledTimes(1);
    expect(result.outputText).toBe("No-tools response.");
    expect(result.metadata?.stoppedBecause).toBeUndefined();
    expect(gate.beforeLLMCall).toHaveBeenCalledWith({
      stage: "maestro_no_tools_stream",
      model: "test-model",
      budgetUsed: 0,
      budgetLimit: Infinity,
    });
  });

  it("returns a controlled gate_blocked result for BLOCK", async () => {
    const adapter = createMaestroAdapter();
    const gate = makeGate({
      allowed: false,
      reason: "model not allowed",
      verdict: "BLOCK",
    });
    const ctx = makeRunCtx({ gate });

    const result = await adapter.run(makeTask(), ctx);

    expect(ctx.llm.stream).not.toHaveBeenCalled();
    expect(result.outputText).toBe("");
    expect(result.metadata?.stoppedBecause).toBe("gate_blocked");
    expect(result.summary).toContain("stoppedBecause=gate_blocked");
  });

  it("treats CONFIRM_REQUIRED as a controlled block", async () => {
    const adapter = createMaestroAdapter();
    const gate = makeGate({
      allowed: true,
      reason: "confirmation needed",
      verdict: "CONFIRM_REQUIRED",
    });
    const ctx = makeRunCtx({ gate });

    const result = await adapter.run(makeTask(), ctx);

    expect(ctx.llm.stream).not.toHaveBeenCalled();
    expect(result.metadata?.stoppedBecause).toBe("gate_blocked");
  });
});

describe("shouldAttemptSubagentDecomposition", () => {
  it("does not decompose read-only informational tasks", () => {
    const task: OrcaTaskSpec = {
      originalUserMessage: "Read package.json, tsconfig.json, and README.md, then summarize the differences.",
      intent: "read project files",
      goals: ["Read the files", "Summarize the differences"],
      permissions: {
        fileRead: true,
        fileWrite: false,
        shellExec: false,
        toolsAllowed: ["read_file", "list_directory", "search_files"],
      },
    };

    expect(
      shouldAttemptSubagentDecomposition(
        task,
        { classification: { multiStep: true } } as any,
        { subagentDepth: 0 },
      ),
    ).toBe(false);
  });

  it("allows decomposition for writable multi-file tasks at top level", () => {
    const task: OrcaTaskSpec = {
      originalUserMessage: "Create files src/a.ts, src/b.ts, and src/c.ts, then also update src/index.ts to export them.",
      intent: "create multiple files",
      goals: ["Create three files", "Update index exports"],
      permissions: {
        fileRead: true,
        fileWrite: true,
        shellExec: false,
        toolsAllowed: ["read_file", "list_directory", "search_files", "write_file"],
      },
    };

    expect(
      shouldAttemptSubagentDecomposition(
        task,
        { classification: { multiStep: true } } as any,
        { subagentDepth: 0 },
      ),
    ).toBe(true);
  });

  it("never decomposes inside an existing subagent", () => {
    const task: OrcaTaskSpec = {
      originalUserMessage: "Create files src/a.ts, src/b.ts, and src/c.ts, then also update src/index.ts to export them.",
      intent: "create multiple files",
      goals: ["Create three files", "Update index exports"],
      permissions: {
        fileRead: true,
        fileWrite: true,
        shellExec: false,
        toolsAllowed: ["read_file", "list_directory", "search_files", "write_file"],
      },
    };

    expect(
      shouldAttemptSubagentDecomposition(
        task,
        { classification: { multiStep: true } } as any,
        { subagentDepth: 1 },
      ),
    ).toBe(false);
  });
});

describe("normalizeConversationHistory", () => {
  it("converts Benson message history into user/assistant turns", () => {
    expect(
      normalizeConversationHistory([
        { role: "user", content: "Create a README" },
        { role: "assistant", content: "README created." },
        { role: "user", content: "Add installation steps" },
        { role: "assistant", content: "Added install steps." },
      ]),
    ).toEqual([
      { user: "Create a README", assistant: "README created." },
      { user: "Add installation steps", assistant: "Added install steps." },
    ]);
  });

  it("preserves existing conversation-turn history", () => {
    expect(
      normalizeConversationHistory([
        { user: "Question", assistant: "Answer" },
      ]),
    ).toEqual([
      { user: "Question", assistant: "Answer" },
    ]);
  });
});

describe("normalizeToolText", () => {
  it("coerces non-string tool outputs into strings", () => {
    expect(normalizeToolText({ path: "package.json", ok: true })).toContain('"path": "package.json"');
    expect(normalizeToolText(42)).toBe("42");
    expect(normalizeToolText(undefined)).toBe("");
  });
});

describe("deriveDeweySignals", () => {
  it("extracts explicit style preferences from the task", () => {
    expect(
      deriveDeweySignals({
        originalUserMessage: "Give me a brief formal answer in bullet points.",
        intent: "answer question",
        goals: ["Answer the question"],
      }),
    ).toEqual(
      expect.arrayContaining(["prefer_brief", "prefer_formal_tone", "prefer_bullets"]),
    );
  });

  it("does not invent signals when the task has no explicit preference cues", () => {
    expect(
      deriveDeweySignals({
        originalUserMessage: "Explain what this file does.",
        intent: "explain file",
        goals: ["Explain the file"],
      }),
    ).toEqual([]);
  });

  it("does not treat .json filenames as a JSON output preference", () => {
    expect(
      deriveDeweySignals({
        originalUserMessage: "Read package.json and tell me the project name.",
        intent: "read package",
        goals: ["Read package.json"],
      }),
    ).toEqual([]);
  });
});

// ─── parseToolCalls ───────────────────────────────────────────────────────────

describe("parseToolCalls", () => {
  it("parses a single valid tool call", () => {
    const text = `<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>`;
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("read_file");
    expect(calls[0]!.input).toEqual({ path: "src/index.ts" });
  });

  it("parses multiple tool calls in one response", () => {
    const text = [
      `<tool_call>{"tool": "read_file", "path": "a.ts"}</tool_call>`,
      `<tool_call>{"tool": "write_file", "path": "b.ts", "content": "hello"}</tool_call>`,
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.tool).toBe("read_file");
    expect(calls[1]!.tool).toBe("write_file");
  });

  it("returns an empty array when there are no tool calls", () => {
    expect(parseToolCalls("Here is my answer: 42")).toHaveLength(0);
    expect(parseToolCalls("")).toHaveLength(0);
  });

  it("silently skips malformed JSON inside a tool_call block", () => {
    const text = `<tool_call>NOT_JSON</tool_call>`;
    expect(parseToolCalls(text)).toHaveLength(0);
  });

  it("silently skips a block that has no 'tool' key", () => {
    const text = `<tool_call>{"path": "index.ts"}</tool_call>`;
    expect(parseToolCalls(text)).toHaveLength(0);
  });

  it("silently skips a block where 'tool' is not a string", () => {
    const text = `<tool_call>{"tool": 42, "path": "x"}</tool_call>`;
    expect(parseToolCalls(text)).toHaveLength(0);
  });

  it("handles whitespace around the JSON payload", () => {
    const text = `<tool_call>  {"tool": "list_directory", "path": "."}  </tool_call>`;
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("list_directory");
  });

  it("separates 'tool' from the remaining input args", () => {
    const text = `<tool_call>{"tool": "run_command", "command": "echo hi", "timeout": 5000}</tool_call>`;
    const calls = parseToolCalls(text);
    expect(calls[0]!.input).not.toHaveProperty("tool");
    expect(calls[0]!.input).toEqual({ command: "echo hi", timeout: 5000 });
  });

  it("can be called multiple times without regex state leaking (global flag safety)", () => {
    const text = `<tool_call>{"tool": "read_file", "path": "x"}</tool_call>`;
    expect(parseToolCalls(text)).toHaveLength(1);
    expect(parseToolCalls(text)).toHaveLength(1);
  });
});

// ─── formatToolResult ─────────────────────────────────────────────────────────

describe("formatToolResult", () => {
  it("formats a successful result with ok=true", () => {
    const formatted = formatToolResult("read_file", true, "file contents here");
    expect(formatted).toContain('tool="read_file"');
    expect(formatted).toContain('ok="true"');
    expect(formatted).toContain("file contents here");
  });

  it("formats a failed result with ok=false and uses the error message as body", () => {
    const formatted = formatToolResult("run_command", false, "", "Exit code 1");
    expect(formatted).toContain('ok="false"');
    expect(formatted).toContain("Exit code 1");
  });

  it("preserves captured command output alongside a failure message", () => {
    const formatted = formatToolResult(
      "run_command",
      false,
      "[Exit code 1]\n1 test failed",
      "Command failed with exit code 1",
    );
    expect(formatted).toContain("Command failed with exit code 1");
    expect(formatted).toContain("1 test failed");
  });

  it("falls back to output text when error is undefined but ok=false", () => {
    const formatted = formatToolResult("write_file", false, "some output");
    expect(formatted).toContain("some output");
  });

  it("wraps output in tool_result tags", () => {
    const formatted = formatToolResult("list_directory", true, "f  main.ts");
    expect(formatted).toMatch(/<tool_result[^>]*>/);
    expect(formatted).toContain("</tool_result>");
  });
});

// ─── resolveRoleToolNames — role scoping & task-aware composition ────────────

const ALL_TOOL_NAMES = [
  "read_file",
  "write_file",
  "run_command",
  "list_directory",
  "search_files",
  "github_list_prs",
  "github_clone_repo",
  "docs_read",
  "web_fetch",
  "desktop-commander_execute_command",
  "github-mcp_create_pull_request",
];

function makeSettings(overrides: Record<string, { toolsAllowed?: string[]; toolCapabilities?: string[] }> = {}): OrcaSettings {
  const roles: OrcaSettings["roles"] = {};
  for (const [role, extra] of Object.entries(overrides)) {
    roles[role] = { provider: "test", model: "test", label: role, ...extra };
  }
  return { roles };
}

describe("resolveRoleToolNames", () => {
  // makeTask()'s default permissions are read-only (fileWrite/shellExec both
  // false) — appropriate for the no-tools gate tests above, but it would
  // silently narrow every role baseline below via the read-only removal rule
  // (step 4 of the design), which is exactly what these "pure baseline"
  // tests must NOT exercise. Use no permissions at all so baseline resolution
  // is isolated from task-aware composition (covered separately below).
  function makeTaskNoPermissions(message?: string): ReturnType<typeof makeTask> {
    const task = makeTask(message);
    task.permissions = undefined;
    return task;
  }

  describe("role defaults (baseline)", () => {
    it("strong_model gets filesystem read/write + shell by default", () => {
      const allowed = resolveRoleToolNames("strong_model", makeSettings(), ALL_TOOL_NAMES, makeTaskNoPermissions());
      expect(allowed).toEqual(expect.arrayContaining(["read_file", "write_file", "run_command"]));
    });

    it("narrator does NOT get filesystem-write or shell by default", () => {
      const allowed = resolveRoleToolNames("narrator", makeSettings(), ALL_TOOL_NAMES, makeTaskNoPermissions());
      expect(allowed).toContain("read_file");
      expect(allowed).toContain("docs_read");
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("run_command");
      expect(allowed).not.toContain("github-mcp_create_pull_request");
      expect(allowed).not.toContain("desktop-commander_execute_command");
    });

    it("reviewer/planner_deep/vision stay read-only by default", () => {
      for (const role of ["reviewer", "planner_deep", "vision"] as const) {
        const allowed = resolveRoleToolNames(role, makeSettings(), ALL_TOOL_NAMES, makeTaskNoPermissions());
        expect(allowed).toContain("read_file");
        expect(allowed).not.toContain("write_file");
        expect(allowed).not.toContain("run_command");
      }
    });

    it("brain gets read-only filesystem access by default (not zero — it IS selected as a direct worker role for investigative tasks, not just the internal routing call)", () => {
      const allowed = resolveRoleToolNames("brain", makeSettings(), ALL_TOOL_NAMES, makeTaskNoPermissions());
      expect(allowed).toEqual(expect.arrayContaining(["read_file", "list_directory", "search_files"]));
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("run_command");
    });
  });

  describe("task-aware composition", () => {
    it("explicit permissions.fileWrite === true adds filesystem-write to narrator", () => {
      const task = makeTask();
      task.permissions = { fileRead: true, fileWrite: true, shellExec: false };
      const allowed = resolveRoleToolNames("narrator", makeSettings(), ALL_TOOL_NAMES, task);
      expect(allowed).toContain("write_file");
    });

    it('wording alone ("update the README") without explicit fileWrite:true does NOT add filesystem-write', () => {
      const task = makeTask("Please update the README with the new deployment steps");
      task.permissions = { fileRead: true, fileWrite: false, shellExec: false };
      const allowed = resolveRoleToolNames("narrator", makeSettings(), ALL_TOOL_NAMES, task);
      expect(allowed).not.toContain("write_file");
    });

    it("permissions.fileWrite === false && shellExec === false narrows a mutation-capable role to read-only", () => {
      const task = makeTask();
      task.permissions = { fileRead: true, fileWrite: false, shellExec: false };
      const allowed = resolveRoleToolNames("strong_model", makeSettings(), ALL_TOOL_NAMES, task);
      expect(allowed).toContain("read_file");
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("run_command");
    });

    it("absent task.permissions changes nothing — role baseline used as-is", () => {
      const task = makeTask();
      task.permissions = undefined;
      const allowed = resolveRoleToolNames("narrator", makeSettings(), ALL_TOOL_NAMES, task);
      expect(allowed).toContain("read_file");
      expect(allowed).not.toContain("write_file");
    });
  });

  describe("explicit toolsAllowed — hard upper bound", () => {
    it("narrows below whatever capability resolution would otherwise allow", () => {
      const settings = makeSettings({
        strong_model: { toolsAllowed: ["read_file"] },
      });
      const allowed = resolveRoleToolNames("strong_model", settings, ALL_TOOL_NAMES, makeTask());
      expect(allowed).toEqual(["read_file"]);
    });

    it("is never exceeded even when task permissions would add a capability", () => {
      const settings = makeSettings({
        narrator: { toolsAllowed: ["read_file", "docs_read"] },
      });
      const task = makeTask();
      task.permissions = { fileRead: true, fileWrite: true, shellExec: false };
      const allowed = resolveRoleToolNames("narrator", settings, ALL_TOOL_NAMES, task);
      expect(allowed).not.toContain("write_file");
      expect(allowed.every((name) => ["read_file", "docs_read"].includes(name))).toBe(true);
    });

    it("configured toolCapabilities override the built-in default baseline", () => {
      const settings = makeSettings({
        narrator: { toolCapabilities: ["filesystem-read", "filesystem-write"] },
      });
      const task = makeTask();
      task.permissions = undefined; // isolate baseline resolution — see makeTaskNoPermissions() above
      const allowed = resolveRoleToolNames("narrator", settings, ALL_TOOL_NAMES, task);
      expect(allowed).toContain("write_file");
    });
  });
});

// ─── Role-scoped filtering wired end-to-end through createMaestroAdapter ─────

describe("role-scoped tool filtering (end-to-end via createMaestroAdapter)", () => {
  function makeToolServiceSpy(): OrcaToolService {
    const names = ["read_file", "write_file", "run_command"];
    return {
      execute: vi.fn(async () => ({ ok: true, output: "ok" })),
      formatForPrompt: vi.fn(() =>
        names.map((n) => `**${n}** — does something\n  - arg (string)`).join("\n"),
      ),
    };
  }

  it("a read-only narrator task exposes only its filtered tool set, not the raw catalog", async () => {
    const adapter = createMaestroAdapter({ allToolNames: ["read_file", "write_file", "run_command"] });
    const tools = makeToolServiceSpy();
    const rawCatalogChars = tools.formatForPrompt().length; // all 3 tools, unfiltered
    const llmStream = vi.fn(async (_prompt: string, _opts: unknown, onChunk: (c: string) => void) => {
      onChunk("Done, no tool calls needed.");
      return { text: "Done, no tool calls needed." };
    });
    const recordedTraces: Array<{ stage: string; detail: unknown }> = [];
    const ctx = makeRunCtx({
      tools,
      llm: { complete: vi.fn(async () => ({ text: "" })), stream: llmStream },
      recordTrace: (stage, detail) => recordedTraces.push({ stage, detail }),
    });

    const task = makeTask("Explain how this module works");
    task.permissions = { fileRead: true, fileWrite: false, shellExec: false };

    await adapter.run(task, ctx);

    expect(llmStream).toHaveBeenCalledTimes(1);

    const budgetTrace = recordedTraces.find((t) => t.stage === "context.budget");
    expect(budgetTrace).toBeDefined();
    const detail = budgetTrace!.detail as {
      toolsExposedCount: number;
      toolSchemaChars: number;
      role: string;
    };
    expect(detail.role).toBe("narrator");
    expect(detail.toolsExposedCount).toBe(1); // only read_file survives filtering
    expect(detail.toolSchemaChars).toBeLessThan(rawCatalogChars);

    // Dynamic Tool Prompt Hygiene milestone: getRolePrompt() now receives
    // the resolved allowlist, so — unlike before that milestone — the fully
    // assembled prompt genuinely never claims write_file/run_command exist
    // for this read-only narrator invocation. This assertion would have
    // been unreliable pre-fix (the old static TOOL_USAGE_REMINDER named all
    // 5 core tools unconditionally); it's meaningful now.
    const sentPrompt = llmStream.mock.calls[0]![0] as string;
    expect(sentPrompt).toContain("read_file");
    expect(sentPrompt).not.toContain("write_file");
    expect(sentPrompt).not.toContain("run_command");
    expect(sentPrompt).not.toContain("You have access to tools (read_file, write_file, run_command");
  });

  it("a role with zero resolved tools gets no tool-usage instruction and no tool-call syntax", async () => {
    // narrator's baseline is filesystem-read + documentation, but this
    // catalog contains neither — resolveRoleToolNames() genuinely resolves
    // to [] here (not via task.permissions.toolsAllowed, which is a
    // separate orca-core/runtime.ts-level field this adapter-level test
    // doesn't exercise).
    const adapter = createMaestroAdapter({ allToolNames: ["write_file", "run_command"] });
    const tools: OrcaToolService = {
      execute: vi.fn(async () => ({ ok: true, output: "ok" })),
      formatForPrompt: vi.fn(
        () => "**write_file** — writes a file\n  - path (string)\n**run_command** — runs a command\n  - command (string)",
      ),
    };
    const llmStream = vi.fn(async (_prompt: string, _opts: unknown, onChunk: (c: string) => void) => {
      onChunk("Answered without tools.");
      return { text: "Answered without tools." };
    });
    const ctx = makeRunCtx({
      tools,
      llm: { complete: vi.fn(async () => ({ text: "" })), stream: llmStream },
    });

    const task = makeTask("Explain how this module works");
    task.permissions = { fileRead: true, fileWrite: false, shellExec: false };

    await adapter.run(task, ctx);

    expect(llmStream).toHaveBeenCalledTimes(1);
    const sentPrompt = llmStream.mock.calls[0]![0] as string;
    expect(sentPrompt).not.toContain("You have access to tools");
    expect(sentPrompt).not.toContain("Use the available tools");
    expect(sentPrompt).not.toContain("TOOL CALL SYNTAX"); // formatForPrompt()'s own header — only appears when tools exist
    expect(sentPrompt).not.toMatch(/must (call|use) (a |the )?tool/i);
  });
});
