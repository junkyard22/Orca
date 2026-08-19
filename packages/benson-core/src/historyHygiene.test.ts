/**
 * Benson Core — History Hygiene Regression Test
 *
 * Codifies a finding from the role-scoped-tools/context-optimization
 * milestone: Benson's rolling conversation history stores only plain
 * {user, assistant} text turns and must never accumulate tool-catalog
 * prose (tool names/schemas/call syntax) across turns. Tool catalogs are
 * re-embedded fresh per LLM call by the agent loop
 * (packages/agent-loop-core/src/loop.ts) — they must never be persisted
 * into Benson's history or threaded into TaskSpec.context.conversationHistory,
 * since that would resend the growing catalog on every subsequent turn
 * (the exact anti-pattern the milestone was raised to fix).
 */

import { describe, it, expect, vi } from "vitest";
import { createBenson } from "./benson.js";
import type { ExecutionResult, TaskSpec } from "./types.js";

// A representative sample of markers that would appear if a tool catalog
// (packages/workbench-core/src/tools/registry.ts's formatForPrompt() output)
// ever leaked into stored conversation text.
const TOOL_CATALOG_MARKERS = [
  "<tool_call>",
  "<tool_result",
  "### Available Tools",
  "**read_file**",
  "**write_file**",
  "**run_command**",
];

function assertNoToolCatalogMarkers(text: string, label: string): void {
  for (const marker of TOOL_CATALOG_MARKERS) {
    expect(text, `${label} unexpectedly contains tool-catalog marker "${marker}"`).not.toContain(
      marker,
    );
  }
}

function createSuccessResult(output: string): ExecutionResult {
  return {
    status: "SUCCESS",
    userFacingText: output,
    summary: "ok",
  };
}

describe("history hygiene — tool catalogs never enter conversation history", () => {
  it("assistant replies stored in history are plain text, not tool-catalog prose", async () => {
    const executeTask = vi.fn().mockResolvedValue(
      createSuccessResult("Here is the result of your request."),
    );
    const benson = createBenson({ executeTask });

    await benson.handleUserMessage("Write a function that reverses a string");
    await benson.handleUserMessage("Now add a test for it");

    const history = benson.getHistory();
    expect(history.length).toBeGreaterThan(0);
    for (const turn of history) {
      assertNoToolCatalogMarkers(turn.user, "stored user turn");
      assertNoToolCatalogMarkers(turn.assistant, "stored assistant turn");
    }
  });

  it("TaskSpec.context.conversationHistory handed to executeTask never carries tool-catalog text", async () => {
    const executeTask = vi.fn().mockResolvedValue(createSuccessResult("First reply."));
    const benson = createBenson({ executeTask });

    await benson.handleUserMessage("Write a function that reverses a string");
    await benson.handleUserMessage("Now add a test for it");

    expect(executeTask).toHaveBeenCalledTimes(2);
    // Second call is the one that carries the first turn as history.
    const taskSpec = executeTask.mock.calls[1]![0] as TaskSpec;
    const conversationHistory = taskSpec.context?.["conversationHistory"];
    expect(Array.isArray(conversationHistory)).toBe(true);
    expect((conversationHistory as unknown[]).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(conversationHistory);
    assertNoToolCatalogMarkers(serialized, "TaskSpec.context.conversationHistory");
  });
});
