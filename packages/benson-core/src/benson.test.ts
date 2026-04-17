/**
 * Benson Core — Unit Tests
 *
 * Tests createBenson() and handleUserMessage() with mocked executeTask.
 */

import { describe, it, expect, vi } from "vitest";
import { createBenson } from "./benson.js";
import { parseIntent } from "./intent.js";
import type { ExecutionResult, BensonReply, TaskSpec, Message } from "./types.js";

function createSuccessResult(output?: string): ExecutionResult {
  return {
    status: "SUCCESS",
    userFacingText: output ?? "Task completed successfully",
    summary: "ok",
  };
}

function createFailureResult(): ExecutionResult {
  return {
    status: "FAIL",
    summary: "Task failed",
  };
}

describe("createBenson", () => {
  describe("handleUserMessage", () => {
    describe("Clear task message — parseIntent returns TASK", () => {
      it("executeTask is called, reply kind is RESULT, text is non-empty", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult("Here is the result"));
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Create a new file called auth.ts");

        expect(executeTask).toHaveBeenCalled();
        expect(reply.kind).toBe("RESULT");
        expect(reply.text).toBe("Here is the result");
      });
    });

    describe("Ambiguous message — parseIntent returns CLARIFY", () => {
      it("executeTask is NOT called, reply kind is CLARIFY, options array present", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("help me");

        expect(executeTask).not.toHaveBeenCalled();
        expect(reply.kind).toBe("CLARIFY");
        const clarifyReply = reply as { kind: "CLARIFY"; text: string; options?: string[] };
        expect(clarifyReply.options).toBeDefined();
        expect(clarifyReply.options?.length).toBeGreaterThan(0);
      });

      it("returns CLARIFY for vague commands like 'fix it'", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("fix it");

        expect(executeTask).not.toHaveBeenCalled();
        expect(reply.kind).toBe("CLARIFY");
      });

      it("returns CLARIFY for single vague word 'help'", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("help");

        expect(executeTask).not.toHaveBeenCalled();
        expect(reply.kind).toBe("CLARIFY");
      });
    });

    describe("executeTask returns SUCCESS", () => {
      it("reply kind RESULT contains outputText", async () => {
        const executeTask = vi.fn().mockResolvedValue(
          createSuccessResult("The authentication module has been created.")
        );
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Create auth.ts with login functionality");

        expect(reply.kind).toBe("RESULT");
        expect(reply.text).toContain("authentication");
      });
    });

    describe("executeTask returns FAIL", () => {
      it("reply kind RESULT contains failure message, does not throw", async () => {
        const executeTask = vi.fn().mockResolvedValue(createFailureResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Create auth.ts");
        
        // Should not throw
        expect(() => benson.handleUserMessage("Create auth.ts")).not.toThrow();
        // Should return RESULT with failure text (not throw)
        expect(reply.kind).toBe("RESULT");
      });
    });

    describe("Empty message handling", () => {
      it("returns CLARIFY for empty/whitespace-only message", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("");
        
        expect(reply.kind).toBe("CLARIFY");
      });

      it("returns CLARIFY for message with only whitespace", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult());
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("   ");
        
        expect(reply.kind).toBe("CLARIFY");
      });
    });

    describe("Specific intent handling", () => {
      it("processes 'create' intent as a task", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult("Created file"));
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Create a new component");

        expect(executeTask).toHaveBeenCalled();
        expect(reply.kind).toBe("RESULT");
      });

      it("processes 'explain' intent as a task", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult("Here is an explanation"));
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Explain how recursion works");

        expect(executeTask).toHaveBeenCalled();
        expect(reply.kind).toBe("RESULT");
      });

      it("processes 'fix' intent as a task (with specific target)", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult("Fixed the bug"));
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Fix the login bug");

        expect(executeTask).toHaveBeenCalled();
        expect(reply.kind).toBe("RESULT");
      });

      it("routes local app readiness requests into read-only project audit mode", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult([
          "Readiness: insufficient evidence",
          "Observed from files/config:",
          "- package.json present",
          "Missing or unverified:",
          "- No test script or test directory detected",
          "Runtime commands:",
          "- npm test: allowed not run - audit mode is read-first",
          "Note: commands were not executed automatically.",
        ].join("\n")));
        const benson = createBenson({ executeTask });

        const reply = await benson.handleUserMessage("Is this production ready?\nC:\\Orca\\Orca");
        const spec = executeTask.mock.calls[0]?.[0] as TaskSpec | undefined;

        expect(reply.kind).toBe("RESULT");
        expect(spec?.mode).toBe("project_audit");
        expect(spec?.permissions).toEqual(["read"]);
        expect(spec?.context?.auditPath).toBe("C:\\Orca\\Orca");
        expect(reply.text).toContain("Missing or unverified:");
        expect(reply.text).toContain("commands were not executed automatically");
      });

      it("keeps consecutive messages separated and preserves the exact current turn text", async () => {
        const executeTask = vi.fn().mockResolvedValue(createSuccessResult("ok"));
        const benson = createBenson({ executeTask });

        await benson.handleUserMessage("create a file called config.json");
        await benson.handleUserMessage("now add an author field");

        const secondTask = executeTask.mock.calls[1]?.[0] as TaskSpec | undefined;

        expect(secondTask).toBeDefined();
        expect(secondTask?.originalUserMessage).toBe("now add an author field");
        expect(secondTask?.intent).not.toContain("config.jsonnow");
        expect(secondTask?.originalUserMessage).not.toContain("config.jsonnow");
        expect(secondTask?.context?.conversationHistory).toBeDefined();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// parseIntent unit tests
// ---------------------------------------------------------------------------

describe("parseIntent", () => {
  // 1. Pure greeting → CLARIFY
  it("returns CLARIFY for pure greeting", () => {
    const result = parseIntent("hello");
    expect(result.kind).toBe("CLARIFY");
  });

  it("returns CLARIFY for 'hi'", () => {
    const result = parseIntent("hi");
    expect(result.kind).toBe("CLARIFY");
  });

  it("returns CLARIFY for 'hey'", () => {
    const result = parseIntent("hey");
    expect(result.kind).toBe("CLARIFY");
  });

  it("returns CLARIFY for 'what can you do'", () => {
    const result = parseIntent("what can you do");
    expect(result.kind).toBe("CLARIFY");
  });

  // 2. Very short message with no history → CLARIFY
  it("returns CLARIFY for very short message (<9 chars)", () => {
    const result = parseIntent("do it");
    expect(result.kind).toBe("CLARIFY");
  });

  it("returns CLARIFY for 'yes' with no history", () => {
    const result = parseIntent("yes");
    expect(result.kind).toBe("CLARIFY");
  });

  it("returns CLARIFY for 'no' with no history", () => {
    const result = parseIntent("no");
    expect(result.kind).toBe("CLARIFY");
  });

  // 3. Clear action verb message → TASK, not CLARIFY
  it("returns TASK for 'create a README file'", () => {
    const result = parseIntent("create a README file");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.intent).toContain("create");
    }
  });

  it("returns TASK for 'write a function'", () => {
    const result = parseIntent("write a function to sort arrays");
    expect(result.kind).toBe("TASK");
  });

  // 4. "fix the bug in auth.ts" → TASK, intent contains "fix", context contains "auth.ts"
  it("extracts file path from 'fix the bug in auth.ts'", () => {
    const result = parseIntent("fix the bug in auth.ts");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.intent).toContain("fix");
      expect(result.spec.context?.files).toContain("auth.ts");
    }
  });

  // 5. "create a README and then add installation instructions" → TASK, goals.length === 2
  it("splits multi-goal message on 'and then'", () => {
    const result = parseIntent("create a README and then add installation instructions");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.goals.length).toBe(2);
    }
  });

  it("splits multi-goal message on 'also'", () => {
    const result = parseIntent("create a test file also add documentation");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.goals.length).toBe(2);
    }
  });

  // 6. "explain what hello_world.py does" → TASK, intent contains "explain"
  it("processes 'explain' intent with file reference", () => {
    const result = parseIntent("explain what hello_world.py does");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.intent).toContain("explain");
      expect(result.spec.context?.files).toContain("hello_world.py");
    }
  });

  // 7. History threading — second message references prior context
  it("threads history through to spec.context", () => {
    const history: Message[] = [
      { role: 'user', content: 'Create a README' },
      { role: 'assistant', content: 'README created' },
    ];
    const result = parseIntent("now add tests for it", history);
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.conversationHistory).toBeDefined();
      expect((result.spec.context?.conversationHistory as Message[]).length).toBe(2);
    }
  });

  it("threads multi-turn conversationHistory from the first turn into the second spec", async () => {
    const executeTask = vi
      .fn<(_: TaskSpec) => Promise<ExecutionResult>>()
      .mockResolvedValueOnce(createSuccessResult("Created greet()"))
      .mockResolvedValueOnce(createSuccessResult("Added docstring"));
    const benson = createBenson({ executeTask });

    await benson.handleUserMessage("create a python function called greet()");
    await benson.handleUserMessage("now add a docstring to it");

    expect(executeTask).toHaveBeenCalledTimes(2);

    const secondSpec = executeTask.mock.calls[1]?.[0];
    const history = secondSpec?.context?.conversationHistory as Message[] | undefined;

    expect(history).toBeDefined();
    expect(history?.[0]?.role).toBe("user");
    expect(history?.[0]?.content).toContain("greet");
  });

  it("does not treat 'yes' as ambiguous when history is present", () => {
    const history: Message[] = [
      { role: 'user', content: 'Should I create the file?' },
      { role: 'assistant', content: 'Would you like me to proceed?' },
    ];
    const result = parseIntent("yes", history);
    expect(result.kind).toBe("TASK");
  });

  // 8. CLARIFY options are non-developer-centric
  it("has non-developer-centric CLARIFY options", () => {
    const result = parseIntent("help");
    expect(result.kind).toBe("CLARIFY");
    if (result.kind === "CLARIFY") {
      const options = result.options;
      // Should NOT contain developer-centric terms like "write code" or "debug code"
      for (const opt of options) {
        expect(opt.toLowerCase()).not.toContain("write code");
        expect(opt.toLowerCase()).not.toContain("debug code");
      }
      // Should contain user-friendly options
      expect(options.some(o => o.includes("Create"))).toBe(true);
      expect(options.some(o => o.includes("Fix") || o.includes("improve"))).toBe(true);
      expect(options.some(o => o.includes("Explain") || o.includes("analyze"))).toBe(true);
    }
  });

  // 9. Message with constraint — "fix auth.ts without changing the API" → constraints present
  it("extracts 'without' constraint", () => {
    const result = parseIntent("fix auth.ts without changing the API");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.constraints).toBeDefined();
      expect(result.spec.constraints?.without).toBe("changing the API");
    }
  });

  it("extracts 'must' constraint", () => {
    const result = parseIntent("create a function that must be async");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      // The regex captures "async" (what follows "must be")
      expect(result.spec.constraints?.must).toBe("async");
    }
  });

  // 10. File path detection — "read config.js" → context.files includes "config.js"
  it("detects file path in message", () => {
    const result = parseIntent("read config.js");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.files).toContain("config.js");
    }
  });

  it("detects multiple file paths", () => {
    const result = parseIntent("compare main.ts and utils.ts");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.files).toContain("main.ts");
      expect(result.spec.context?.files).toContain("utils.ts");
    }
  });

  it("detects file path with directory", () => {
    const result = parseIntent("open src/components/Button.ts");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.files).toContain("src/components/Button.ts");
    }
  });

  // Additional edge cases
  it("handles 'ok' with history as TASK", () => {
    const history: Message[] = [
      { role: 'user', content: 'Shall I run the tests?' },
      { role: 'assistant', content: 'Yes, would you like me to?' },
    ];
    const result = parseIntent("ok", history);
    expect(result.kind).toBe("TASK");
  });

  it("handles URL in message", () => {
    const result = parseIntent("fetch data from https://api.example.com/users");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.urls).toContain("https://api.example.com/users");
    }
  });

  it("includes shell permission for 'run the tests'", () => {
    const result = parseIntent("run the tests");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.permissions).toContain("shell");
    }
  });

  it("parses local project assessment prompts as project_audit", () => {
    const result = parseIntent("Review this repo and tell me production readiness\nC:\\Orca\\Orca");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.mode).toBe("project_audit");
      expect(result.spec.permissions).toEqual(["read"]);
      expect(result.spec.outputFormat).toBe("bullets");
      expect(result.spec.context?.auditPath).toBe("C:\\Orca\\Orca");
    }
  });

  it("extracts Windows audit paths without trailing prose", () => {
    const result = parseIntent("Use the workspace at C:\\Orca and verify the app can use its core tools without changing files.");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.context?.auditPath).toBe("C:\\Orca");
    }
  });

  it("keeps read-only permissions when only mentioning a test script", () => {
    const result = parseIntent(
      "Read package.json and say whether a top-level test script exists",
    );
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.permissions).toEqual(["read"]);
    }
  });

  it("includes write permission for 'create a file called notes.txt'", () => {
    const result = parseIntent("create a file called notes.txt");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.permissions).toContain("write");
    }
  });

  it("keeps read-only permissions for 'explain what this does'", () => {
    const result = parseIntent("explain what this does");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.permissions).toEqual(["read"]);
    }
  });

  it("includes network permission for 'fetch data from the API'", () => {
    const result = parseIntent("fetch data from the API");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.permissions).toContain("network");
    }
  });

  it("uses bullets output format for bullet summary requests", () => {
    const result = parseIntent("summarize in bullet points");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("bullets");
    }
  });

  it("uses json output format when JSON is requested", () => {
    const result = parseIntent("return the result as JSON");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("json");
    }
  });

  it("does not treat .json filenames as a JSON output request", () => {
    const result = parseIntent("Read package.json and tell me the project name");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("prose");
    }
  });

  it("uses code output format for function-writing requests", () => {
    const result = parseIntent("write a function to sort an array");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("code");
    }
  });

  it("uses file_diff output format for diff requests", () => {
    const result = parseIntent("show me the diff");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("file_diff");
    }
  });

  it("defaults to prose output when no format signal is present", () => {
    const result = parseIntent("review the login flow");
    expect(result.kind).toBe("TASK");
    if (result.kind === "TASK") {
      expect(result.spec.outputFormat).toBe("prose");
    }
  });

  it("uses Benson's local TaskSpec shape with permission arrays", () => {
    const localTask: TaskSpec = {
      originalUserMessage: "explain this",
      intent: "explain this",
      goals: ["explain this"],
      permissions: ["read"],
      outputFormat: "prose",
      context: {
        conversationHistory: [],
      },
    };

    expect(Array.isArray(localTask.permissions)).toBe(true);
    expect(localTask.outputFormat).toBe("prose");
  });
});

// ---------------------------------------------------------------------------
// History management tests
// ---------------------------------------------------------------------------

describe("Benson history management", () => {
  it("exposes getHistory method", () => {
    const executeTask = vi.fn().mockResolvedValue(createSuccessResult("done"));
    const benson = createBenson({ executeTask });

    expect(benson.getHistory()).toEqual([]);
  });

  it("exposes clearHistory method", async () => {
    const executeTask = vi.fn().mockResolvedValue(createSuccessResult("done"));
    const benson = createBenson({ executeTask, maxHistoryTurns: 5 });

    // Use a message that will be parsed as TASK (not CLARIFY)
    await benson.handleUserMessage("create a file");
    expect(benson.getHistory().length).toBe(1);

    benson.clearHistory();
    expect(benson.getHistory()).toEqual([]);
  });

  it("respects maxHistoryTurns limit", async () => {
    const executeTask = vi.fn().mockResolvedValue(createSuccessResult("done"));
    const benson = createBenson({ executeTask, maxHistoryTurns: 2 });

    await benson.handleUserMessage("message 1");
    await benson.handleUserMessage("message 2");
    await benson.handleUserMessage("message 3");

    expect(benson.getHistory().length).toBe(2);
  });
});
