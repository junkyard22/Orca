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
} from "./maestroAdapter.js";

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
      stage: "maestro_no_tools",
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
