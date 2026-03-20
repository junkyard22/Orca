import { describe, expect, it } from "vitest";
import type { OrcaTaskSpec } from "@clawde/orca-core";
import {
  deriveDeweySignals,
  normalizeConversationHistory,
  normalizeToolText,
  shouldAttemptSubagentDecomposition,
} from "./maestroAdapter.js";

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
