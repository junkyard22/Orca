/**
 * ReactAgentAdapter Loop Detection Tests
 * 
 * Tests for the anti-loop detection feature in ReactAgentAdapter.
 * Uses mock LLM and mock tool executor — no real API calls.
 */

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
  
  constructor(responses: string[]) {
    this.responses = responses;
  }
  
  get name() { return "mock"; }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = this.responses[this.callCount] ?? "";
    this.callCount++;
    return { content: response, usage: { totalTokens: 100, promptTokens: 50, completionTokens: 50 } };
  }
  
  async stream(request: LLMRequest, onToken: (chunk: string) => void): Promise<LLMResponse> {
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
function createCtx(): OrcaRunCtx {
  return {
    llm: {} as any,
    runId: "test-run-id"
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
      "coder_strong" as RoleName,
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
      "coder_strong" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    expect(result.stoppedBecause).toBe("loop_detected");
    expect(result.loopEvidence).toBeDefined();
    expect(result.loopEvidence?.occurrences).toBe(6);
    // The repeatedCall should show the alternating pattern
    expect(result.loopEvidence?.repeatedCall).toContain("↔");
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
      "coder_strong" as RoleName,
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

<tool_call>{"tool": "read_file", "path": "c.txt"}</tool_call>`
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
      "coder_strong" as RoleName,
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
      
      // Iteration 4: Task complete
      `Thought: Done
Observation: Complete
Next: Task is complete

`
    ];

    const mockAdapter = new MockLLMAdapter(responses);
    const tools = [createMockTool("read_file", "content")];
    
    const adapter = new ReactAgentAdapter(
      mockAdapter,
      "You are a helpful assistant.",
      "coder_strong" as RoleName,
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
      "coder_strong" as RoleName,
      10
    );

    const result = await adapter.run(createTask(), tools as any, createCtx());

    // Should hit max iterations
    expect(result.stoppedBecause).toBe("max_iterations");
    expect(result.iterationCount).toBe(10);
    expect(result.loopEvidence).toBeUndefined();
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
});