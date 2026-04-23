/**
 * ReactAgentAdapter Loop Detection Tests
 * 
 * Tests for the anti-loop detection feature in ReactAgentAdapter.
 * Uses mock LLM and mock tool executor — no real API calls.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReactAgentAdapter } from "./ReactAgentAdapter";
import type { AgentTask } from "./AgentAdapter";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@clawde/miranda-core";
import type { OrcaRunCtx } from "@clawde/orca-core";
import type { RoleName } from "maestro-core";

// Mock LLM Adapter
class MockLLMAdapter implements LLMAdapter {
  private responses: string[] = [];
  private callCount = 0;
  public requests: LLMRequest[] = [];
  
  constructor(responses: string[]) {
    this.responses = responses;
  }
  
  get name() { return "mock"; }

  private snapshotRequest(request: LLMRequest): LLMRequest {
    return {
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    };
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(this.snapshotRequest(request));
    const response = this.responses[this.callCount] ?? "";
    this.callCount++;
    return { content: response, usage: { totalTokens: 100, promptTokens: 50, completionTokens: 50 } };
  }
  
  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
    this.requests.push(this.snapshotRequest(request));
    const response = this.responses[this.callCount] ?? "";
    this.callCount++;
    onToken(response);
    return { content: response, usage: { totalTokens: 100, promptTokens: 50, completionTokens: 50 } };
  }
}

// Mock Tool
type MockTool = {
  name: string;
  description: string;
  execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }>;
};

function createMockTool(name: string, output: string, shouldFail = false): MockTool {
  return {
    name,
    description: `Mock ${name} tool`,
    execute: async () => ({
      ok: !shouldFail,
      output,
      error: shouldFail ? "Mock error" : undefined
    })
  };
}

// Helper to create a basic task
function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    intent: "Test task",
    goals: ["Complete the task"],
    doneCriteria: ["Task is done"],
    ...overrides
  };
}

// Helper to create run context
 function createCtx(overrides: Partial<OrcaRunCtx> = {}): OrcaRunCtx {
  return {
    llm: {} as any,
    runId: "test-run-id",
    ...overrides,
  };
}

function createAHPPacket(
  overrides: Partial<NonNullable<OrcaRunCtx["ahpPacket"]>> = {},
): NonNullable<OrcaRunCtx["ahpPacket"]> {
  return {
    id: "packet-1",
    objective: "Review the release checklist",
    lifecycle: "RUNNING",
    inputs: [
      { id: "goal-0", type: "goal", value: "Inspect apps/desktop/package.json only" },
      { id: "goal-1", type: "goal", value: "Focus on Windows packaging blockers" },
    ],
    constraints: [{ rule: "no_file_writes", enforcer: "miranda" }],
    expectedOutput: {
      schema: {},
      acceptanceCriteria: ["State the packaging blocker"],
    },
    trace: [],
    meta: {
      ackRequired: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    role: "Child",
    ...overrides,
  };
}

describe("ReactAgentAdapter Loop Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: Identical call loop — same read_file call 3 times
  it("should detect identical call loop and stop with loop_detected", async () => {
    // Model responses that trigger the same tool call 3 times
    const responses = [
      // Iteration 1: Thought + tool call
      `Thought: I need to read the file
Observation: I need to check the file content
Next: Read the file

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      
      // Iteration 2: Same tool call (loop check should trigger after this)
      `Thought: I need to read the file again
Observation: Let me check the file
Next: Read the file

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      
      // Iteration 3: Same tool call again (should trigger loop detection)
      `Thought: Let me read the file
Observation: Checking file content
Next: Read the file

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "file content here")];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10 // maxIterations
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    expect(result.stoppedBecause).toBe("loop_detected");
    expect(result.iterationCount).toBe(3);
    expect(result.loopEvidence).toBeDefined();
    expect(result.loopEvidence?.occurrences).toBe(3);
    expect(result.loopEvidence?.repeatedCall).toContain("read_file");
  });

  // Test 2: Thrashing — alternating read_file/write_file 6 times
  it("should detect thrashing pattern and stop with loop_detected", async () => {
    // Model responses that alternate between two tools 6 times
    const responses = [
      // Iteration 1: read_file
      `Thought: I need to read the file
Observation: Checking file
Next: Read file

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      
      // Iteration 2: write_file
      `Thought: Now I need to write
Observation: Writing to file
Next: Write file

<tool_call>{"tool": "write_file", "path": "test.txt", "content": "hello"}</tool_call>`,
      
      // Iteration 3: read_file again
      `Thought: Let me read again
Observation: Reading
Next: Read file

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      
      // Iteration 4: write_file again
      `Thought: Now I write
Observation: Writing
Next: Write file

<tool_call>{"tool": "write_file", "path": "test.txt", "content": "hello"}</tool_call>`,
      
      // Iteration 5: read_file again
      `Thought: Let me read
Observation: Reading
Next: Read

<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      
      // Iteration 6: write_file again (should trigger thrash detection)
      `Thought: Now write
Observation: Writing
Next: Write

<tool_call>{"tool": "write_file", "path": "test.txt", "content": "hello"}</tool_call>`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [
      createMockTool("read_file", "file content"),
      createMockTool("write_file", "written")
    ];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // All 6 calls execute (the tool-use-discipline cap is maxIterations*3=30),
    // so the full THRASH_WINDOW of 6 develops and loop_detected fires.
    expect(result.stoppedBecause).toBe("loop_detected");
    expect(result.loopEvidence).toBeDefined();
  });

  // Test 3: Empty result loop — tool returns '' three times in a row
  it("should detect empty result loop and stop with loop_detected", async () => {
    // Model responses that call a tool that returns empty/error
    const responses = [
      // Iteration 1: tool call that returns empty
      `Thought: Let me try the tool
Observation: Trying
Next: Call tool

<tool_call>{"tool": "read_file", "path": "nonexistent.txt"}</tool_call>`,
      
      // Iteration 2: same tool call returns empty again
      `Thought: Let me try again
Observation: Trying again
Next: Call tool

<tool_call>{"tool": "read_file", "path": "nonexistent.txt"}</tool_call>`,
      
      // Iteration 3: same tool call returns empty again (should trigger)
      `Thought: Let me try once more
Observation: Trying again
Next: Call tool

<tool_call>{"tool": "read_file", "path": "nonexistent.txt"}</tool_call>`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "", true)]; // Empty output, fails
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    expect(result.stoppedBecause).toBe("loop_detected");
    expect(result.loopEvidence).toBeDefined();
    expect(result.loopEvidence?.occurrences).toBe(3);
    expect(result.loopEvidence?.repeatedCall).toContain("read_file");
    expect(result.loopEvidence?.repeatedCall).toContain("empty/error");
  });

  // Test 4: No loop — 5 different tool calls
  it("should NOT detect loop when different tools are used", async () => {
    // Model responses with different tool calls each time
    const responses = [
      // Iteration 1: read_file
      `Thought: First read
Observation: Reading
Next: Read

<tool_call>{"tool": "read_file", "path": "a.txt"}</tool_call>`,
      
      // Iteration 2: write_file (different!)
      `Thought: Now write
Observation: Writing
Next: Write

<tool_call>{"tool": "write_file", "path": "b.txt", "content": "x"}</tool_call>`,
      
      // Iteration 3: list_files (different!)
      `Thought: List files
Observation: Listing
Next: List

<tool_call>{"tool": "list_files", "path": "."}</tool_call>`,
      
      // Iteration 4: search_files (different!)
      `Thought: Search
Observation: Searching
Next: Search

<tool_call>{"tool": "search_files", "query": "test"}</tool_call>`,
      
      // Iteration 5: read_file again (different path!)
      `Thought: Read more
Observation: Reading
Next: Read

<tool_call>{"tool": "read_file", "path": "c.txt"}</tool_call>`,

      // Iteration 6: all reads done, produce final answer
      `Thought: All files have been read
Observation: Task is complete
Next: Provide final answer

FINAL ANSWER:
All files processed successfully.`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [
      createMockTool("read_file", "content"),
      createMockTool("write_file", "done"),
      createMockTool("list_files", "files here"),
      createMockTool("search_files", "results")
    ];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // Should complete normally (not loop_detected)
    expect(result.stoppedBecause).toBe("done");
    expect(result.loopEvidence).toBeUndefined();
  });

  // Test 5: Near-loop — same call twice then different call resets
  it("should NOT detect loop when different call breaks the pattern", async () => {
    // Model responses: same call twice, then different call
    const responses = [
      // Iteration 1: read_file a.txt
      `Thought: Read a
Observation: Reading
Next: Read

<tool_call>{"tool": "read_file", "path": "a.txt"}</tool_call>`,
      
      // Iteration 2: read_file a.txt again (same)
      `Thought: Read a again
Observation: Reading again
Next: Read

<tool_call>{"tool": "read_file", "path": "a.txt"}</tool_call>`,
      
      // Iteration 3: read_file b.txt (DIFFERENT! - should reset loop detection)
      `Thought: Read b
Observation: Reading b
Next: Read

<tool_call>{"tool": "read_file", "path": "b.txt"}</tool_call>`,
      
      // Iteration 4: Task complete with explicit FINAL ANSWER marker
      `Thought: Done
Observation: Complete
Next: Task is complete

FINAL ANSWER:
Task completed successfully.`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "content")];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // Should complete normally - the different call should reset the loop detection
    expect(result.stoppedBecause).toBe("done");
    expect(result.loopEvidence).toBeUndefined();
  });

  // Test 6: Max iterations reached (should still work normally)
  it("should stop at max_iterations when no loop detected", async () => {
    // Generate many responses that don't trigger loop detection
    const responses = Array(10).fill(null).map((_, i) => 
      `Thought: Iteration ${i + 1}
Observation: Working
Next: Continue

<tool_call>{"tool": "read_file", "path": "file${i}.txt"}</tool_call>`
    );

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "content")];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "strong_model" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // All 10 unique tool calls execute without triggering any loop detection.
    // No FINAL ANSWER is produced, so the run ends as no_final_output.
    expect(result.stoppedBecause).toBe("no_final_output");
    expect(result.iterationCount).toBe(10);
    expect(result.loopEvidence).toBeUndefined();
  });

  it("records a structured agent trace for model calls and tool execution", async () => {
    const responses = [
      `Thought: I should read the file\nObservation: I need the file contents\nNext: Call the tool\n\n<tool_call>{"tool": "read_file", "path": "test.txt"}</tool_call>`,
      `Thought: I have the file contents\nObservation: The task is complete\nNext: Task is complete\n\nFINAL ANSWER:\nRead complete.`,
    ];
    const traceEntries: Array<{ stage: string; detail?: unknown }> = [];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "reader" as RoleName,
      4,
    );

    const result = await adapter.run(
      createTask(),
      [createMockTool("read_file", "file content") as any],
      {
        ...createCtx(),
        recordTrace: (stage, detail) => traceEntries.push({ stage, detail }),
      },
    );

    expect(result.stoppedBecause).toBe("done");
    expect(traceEntries.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining([
        "agent.run.start",
        "agent.iteration.request",
        "agent.iteration.response",
        "agent.tool.call",
        "agent.tool.result",
        "agent.final_answer",
        "agent.run.completed",
      ]),
    );
  });

  it("uses only the text after the FINAL ANSWER marker", async () => {
    const responses = [
      `Thought: I inspected the file\nObservation: I have what I need\nNext: Task is complete\n\nFINAL ANSWER:\n- apps/runner is the CLI entrypoint\n- It wires the Orca runtime\n- It prints Benson's response`
    ];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "reader" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toBe("- apps/runner is the CLI entrypoint\n- It wires the Orca runtime\n- It prints Benson's response");
  });

  it("strips thought blocks when no FINAL ANSWER marker is present", async () => {
    const responses = [
      `Thought: I read the file\nObservation: It contains a simple function\nNext: Task is complete\n\n- hello_world.py defines a small Python entrypoint\n- It prints a greeting\n- It has no external dependencies`
    ];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "reader" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toBe("- hello_world.py defines a small Python entrypoint\n- It prints a greeting\n- It has no external dependencies");
  });

  it("keeps a clean answer unchanged when there are no thought blocks", async () => {
    const responses = [
      `- apps/runner is a CLI wrapper around Orca\n- It configures LLM, Maestro, Pappy, and tools\n- It reads a prompt and prints the final reply`
    ];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "reader" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toBe("- apps/runner is a CLI wrapper around Orca\n- It configures LLM, Maestro, Pappy, and tools\n- It reads a prompt and prints the final reply");
  });

  // ── New tests for hardened failure modes ──────────────────────────────────

  // Test 7: Malformed tool block — invalid JSON inside <tool_call> tags
  it("should inject a correction message on malformed tool block and not crash", async () => {
    const responses = [
      // Malformed: not valid JSON
      `Thought: I need to read the file
Observation: Checking
Next: Read

<tool_call>NOT VALID JSON {broken: syntax here</tool_call>`,

      // After correction, model produces a valid final answer
      `Thought: Ok, I'll answer directly
Observation: Done
Next: Task is complete

FINAL ANSWER:
Here is the deployment status: all services up.`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "brain" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), [], createCtx());

    // Should eventually succeed because the model corrected itself
    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toContain("deployment status");
  });

  // Test 8: Parse-failure loop — 3 consecutive malformed tool blocks → stop
  it("should detect parse_failure_loop after 3 consecutive malformed blocks", async () => {
    const malformedIteration = `Thought: I need a tool
Observation: Trying
Next: Call it

<tool_call>{ broken json no closing brace</tool_call>`;

    const responses = [
      malformedIteration,
      malformedIteration,
      malformedIteration,
      // Would be a valid response but should never be reached
      `FINAL ANSWER: This should not appear`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "brain" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), [], createCtx());

    expect(result.stoppedBecause).toBe("parse_failure_loop");
    expect(result.loopEvidence).toBeDefined();
    expect(result.loopEvidence?.occurrences).toBe(3);
    expect(result.loopEvidence?.repeatedCall).toContain("malformed");
  });

  // Test 9: no_final_output — tools ran forever, max_iterations hit, no answer
  it("should report no_final_output when tools fired but no FINAL ANSWER produced", async () => {
    // 3 iterations each calling a tool but never writing FINAL ANSWER:
    const responses = [
      `Thought: Read the file\n<tool_call>{"tool": "read_file", "path": "a.txt"}</tool_call>`,
      `Thought: Read again\n<tool_call>{"tool": "read_file", "path": "b.txt"}</tool_call>`,
      `Thought: Read more\n<tool_call>{"tool": "read_file", "path": "c.txt"}</tool_call>`,
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "some content")];
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "brain" as RoleName,
      3  // maxIterations = 3
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // max_iterations reached with no final answer → no_final_output
    expect(result.stoppedBecause).toBe("no_final_output");
    expect(result.toolsUsed.length).toBeGreaterThan(0);
  });

  it("uses one final no-tools turn to synthesize after max iterations", async () => {
    const responses = [
      `Thought: Read package data\n<tool_call>{"tool": "read_file", "path": "package.json"}</tool_call>`,
      `Thought: Read README\n<tool_call>{"tool": "read_file", "path": "README.md"}</tool_call>`,
      `Thought: Search source\n<tool_call>{"tool": "search_files", "pattern": "ship", "directory": "src"}</tool_call>`,
      `FINAL ANSWER:
Ship readiness is yellow. Package metadata and README were reviewed, but source search found shipping-related follow-up work.`,
    ];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "reviewer" as RoleName,
      3,
    );

    const result = await adapter.run(
      createTask({
        intent: "Audit the app for ship readiness",
        goals: ["Output states a ship readiness level"],
        doneCriteria: ["Output states a ship readiness level"],
      }),
      [
        createMockTool("read_file", "file content") as any,
        createMockTool("search_files", "ship TODO") as any,
      ],
      createCtx(),
    );

    expect(result.stoppedBecause).toBe("done");
    expect(result.outputText).toContain("Ship readiness is yellow");
    expect(result.iterationCount).toBe(3);
  });

  it("does not require write_file for read-only inspections that name files", async () => {
    const mockAdapter = new MockLLMAdapter([`FINAL ANSWER:\nReadiness is green.`]);
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "reviewer" as RoleName,
      3,
    );

    await adapter.run(
      createTask({
        intent: [
          "Inspect this project and tell me whether it is ready for a local test release.",
          "C:\\Orca\\Orca",
          "Only check these files:",
          "apps\\desktop\\package.json",
          "apps\\desktop\\build-dist.mjs",
          ".github\\workflows\\release.yml",
        ].join("\n"),
        goals: ["Return readiness level, evidence, blockers, and next action"],
        doneCriteria: ["Output states readiness level"],
      }),
      [
        createMockTool("read_file", "file content") as any,
        createMockTool("write_file", "written") as any,
      ],
      createCtx(),
    );

    const taskContext = mockAdapter.requests[0]?.messages.at(-1)?.content ?? "";
    expect(taskContext).not.toContain("ACTION REQUIRED: Call write_file");
  });

  it("prefers the active AHP packet over the loose AgentTask when building the worker prompt", async () => {
    const responses = [
      `<tool_call>{"tool": "read_file", "path": "apps/desktop/package.json"}</tool_call>`,
      `FINAL ANSWER:\nPackaging blocker found.`,
    ];
    const mockAdapter = new MockLLMAdapter(responses);
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "reviewer" as RoleName,
      3,
    );

    await adapter.run(
      createTask({
        intent: "Ignore this legacy task intent",
        goals: ["Ignore this legacy goal"],
        doneCriteria: ["Ignore this legacy done criterion"],
      }),
      [createMockTool("read_file", "file content") as any],
      createCtx({
        ahpPacket: createAHPPacket(),
      }),
    );

    const taskContext = mockAdapter.requests[0]?.messages.at(-1)?.content ?? "";
    expect(taskContext).toContain("## AHP Packet Assignment");
    expect(taskContext).toContain("Review the release checklist");
    expect(taskContext).toContain("Inspect apps/desktop/package.json only");
    expect(taskContext).toContain("Focus on Windows packaging blockers");
    expect(taskContext).toContain("no_file_writes");
    expect(taskContext).toContain("State the packaging blocker");
    expect(taskContext).not.toContain("Ignore this legacy task intent");
    expect(taskContext).not.toContain("Ignore this legacy goal");
    expect(taskContext).not.toContain("Ignore this legacy done criterion");
  });

  it("does not treat final-turn tool narration as a completed answer", async () => {
    const responses = [
      `I need to inspect package.json.<tool_call>{"tool": "read_file", "path": "package.json"}</tool_call>`,
      `I need to inspect README.md.<tool_call>{"tool": "read_file", "path": "README.md"}</tool_call>`,
      `README is minimal. Let me inspect src next.<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>`,
    ];

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "brain" as RoleName,
      3,
    );

    const result = await adapter.run(
      createTask({
        intent: "Audit the app",
        goals: ["Audit the app and list shipping blockers"],
        doneCriteria: ["Output lists shipping blockers"],
      }),
      [createMockTool("read_file", "file content") as any],
      createCtx(),
    );

    expect(result.stoppedBecause).toBe("no_final_output");
    expect(result.outputText).toBe("");
  });

  it("recovers tool-name-prefixed JSON tool calls", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const responses = [
      `<tool_call>list_directory{"path": "C:\\\\cari-platform"}</tool_call>`,
      `FINAL ANSWER:\nDirectory inspected.`,
    ];
    const tool = {
      name: "list_directory",
      description: "List directory",
      execute: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return { ok: true, output: "package.json" };
      },
    };

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "brain" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [tool as any], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(capturedInput).toEqual({ path: "C:\\cari-platform" });
    expect(result.toolsUsed[0]?.tool).toBe("list_directory");
  });

  it("maps read_directory to the available directory listing tool", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const responses = [
      `<tool_call>{"tool": "read_directory", "path": ".", "depth": 2}</tool_call>`,
      `FINAL ANSWER:\nDirectory inspected.`,
    ];
    const tool = {
      name: "list_directory",
      description: "List directory",
      execute: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return { ok: true, output: "package.json" };
      },
    };

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "brain" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [tool as any], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(capturedInput).toEqual({ path: ".", depth: 2 });
    expect(result.toolsUsed[0]?.tool).toBe("list_directory");
  });

  it("maps desktop-commander_search_files to the available search_files tool", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const responses = [
      `<tool_call>{"tool": "desktop-commander_search_files", "pattern": "error", "directory": "C:\\\\cari-platform", "glob": "*.log"}</tool_call>`,
      `FINAL ANSWER:\nSearch completed.`,
    ];
    const tool = {
      name: "search_files",
      description: "Search files",
      execute: async (input: Record<string, unknown>) => {
        capturedInput = input;
        return { ok: true, output: "No matches found." };
      },
    };

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "brain" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [tool as any], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(capturedInput).toEqual({
      pattern: "error",
      directory: "C:\\cari-platform",
      glob: "*.log",
    });
    expect(result.toolsUsed[0]?.tool).toBe("search_files");
  });

  it("captures diff content for files written via run_command metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "react-agent-run-command-"));
    try {
      const targetDir = join(root, "tmp-test", "orca-sandbox-check");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "tasks.json"), "{\n  \"tasks\": []\n}\n", "utf8");

      const responses = [
        `<tool_call>{"tool": "run_command", "command": "echo done"}</tool_call>`,
        `FINAL ANSWER:\nShell work complete.`,
      ];
      const tool = {
        name: "run_command",
        description: "Run shell command",
        execute: async () => ({
          ok: true,
          output: `done\n\n<!-- Files changed: [{"path":"tmp-test/orca-sandbox-check/tasks.json","changeType":"M"}] -->`,
        }),
      };

      const adapter = new ReactAgentAdapter(
        new MockLLMAdapter(responses),
        "You are a helpful assistant.",
        "brain" as RoleName,
        3,
      );

      const result = await adapter.run(createTask(), [tool as any], createCtx({ workspaceRoot: root }));

      expect(result.stoppedBecause).toBe("done");
      expect(result.filesChanged).toEqual([
        {
          path: "tmp-test/orca-sandbox-check/tasks.json",
          changeType: "M",
          diff: "{\n  \"tasks\": []\n}\n",
        },
      ]);
      expect(result.toolsUsed[0]?.raw).toMatchObject({
        _filesChangedForDiff: [
          {
            path: "tmp-test/orca-sandbox-check/tasks.json",
            changeType: "M",
            diff: "{\n  \"tasks\": []\n}\n",
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures diff content for desktop commander write_file events", async () => {
    const responses = [
      `<tool_call>{"tool": "desktop-commander_write_file", "path": "./tmp-test/orca-sandbox-check/task-report.js", "content": "console.log('done');\\n"}</tool_call>`,
      `FINAL ANSWER:\nDesktop Commander work complete.`,
    ];
    const tool = {
      name: "desktop-commander_write_file",
      description: "Write a file through Desktop Commander",
      execute: async () => ({
        ok: true,
        output: "File written successfully.",
      }),
    };

    const adapter = new ReactAgentAdapter(
      new MockLLMAdapter(responses),
      "You are a helpful assistant.",
      "brain" as RoleName,
      3,
    );

    const result = await adapter.run(createTask(), [tool as any], createCtx());

    expect(result.stoppedBecause).toBe("done");
    expect(result.filesChanged).toEqual([
      {
        path: "./tmp-test/orca-sandbox-check/task-report.js",
        changeType: "M",
        diff: "console.log('done');\n",
      },
    ]);
    expect(result.toolsUsed[0]?.raw).toMatchObject({
      path: "./tmp-test/orca-sandbox-check/task-report.js",
      _contentForDiff: "console.log('done');\n",
    });
  });
});
