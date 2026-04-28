import {
  extractFilesChangedFromCommandOutput,
  type OrcaFileChange,
  type OrcaMaestroResult,
  type OrcaRunCtx,
  type OrcaToolService,
} from "@clawde/orca-core";
import type { GateResult } from "@clawde/miranda-core";
import type { AgentLoopResult, ParsedCall } from "./types.js";

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function isGateStop(gateResult: GateResult): boolean {
  return !gateResult.allowed || gateResult.verdict === "CONFIRM_REQUIRED";
}

export function parseToolCalls(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  // Reset lastIndex before each use since the regex has the /g flag.
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      const { tool, ...input } = parsed;
      if (typeof tool === "string" && tool) {
        calls.push({ tool, input });
      }
    } catch {
      // Ignore malformed JSON inside <tool_call>.
    }
  }
  return calls;
}

export function formatToolResult(tool: string, ok: boolean, output: string, error?: string): string {
  const status = ok ? 'ok="true"' : 'ok="false"';
  const body = ok ? output : (error ?? output ?? "unknown error");
  return `\n<tool_result tool="${tool}" ${status}>\n${body}\n</tool_result>`;
}

export function normalizeToolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const json = JSON.stringify(value, null, 2);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Extract a write target path from done_criteria or task goals.
 * Returns the first path that looks like a file the agent must write.
 * Used to inject a last-turn write nudge before iterations are exhausted.
 */
function extractWriteTarget(criteria: string[]): string | undefined {
  // Match patterns like "SHIP-AUDIT.md created", "write_file called with AUDIT.md", etc.
  const filePathRe = /(?:^|\s)([\w./\\-]+\.(?:md|txt|json|yaml|yml|ts|js|csv|log|html))\b/i;
  for (const c of criteria) {
    const m = c.match(filePathRe);
    if (m) return m[1];
  }
  return undefined;
}

function recordFileChange(filesChanged: OrcaFileChange[], next: OrcaFileChange): void {
  const existing = filesChanged.find((file) => file.path === next.path);
  if (!existing) {
    filesChanged.push(next);
    return;
  }

  if (existing.changeType !== "A" && next.changeType === "A") {
    existing.changeType = "A";
  }
  if (next.diff) {
    existing.diff = next.diff;
  }
}

export async function runAgentLoop(
  systemPrompt: string,
  taskPrompt: string,
  tools: OrcaToolService,
  ctx: OrcaRunCtx,
  /** Expected file write targets from done_criteria — used to inject a last-turn write nudge. */
  writeTargets?: string[],
): Promise<AgentLoopResult> {
  const MAX_ITERATIONS = 10;
  const writeTarget = writeTargets ? extractWriteTarget(writeTargets) : undefined;
  const toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]> = [];
  const filesChanged: OrcaFileChange[] = [];

  // Full conversation grows with each turn so the model always has context.
  let conversation =
    `${systemPrompt}\n\n${tools.formatForPrompt()}\n\n---\n\n${taskPrompt}`;

  let lastText = "";
  let iterations = 0;

  // Dedup guard — skip any tool call with the exact same signature as one
  // already executed this run. Prevents the model from calling write_file
  // (or any tool) in a loop with identical arguments.
  const executedCallSigs = new Set<string>();

  // Terminal-condition flag: set when the runtime observes a completion it can
  // verify directly (e.g. write_file succeeded). Stops the outer loop before
  // burning an extra LLM turn to ask the model to confirm what we already know.
  let loopComplete = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Completion contract: stop immediately when the runtime has already
    // observed a terminal condition — do not call the model again.
    if (loopComplete) break;
    if (i > 0) {
      ctx.emit?.({ type: "stream:reset", taskId: ctx.runId });
    }

    // Write nudge: on the penultimate turn, if the task requires writing a file
    // and no write has happened yet, inject a hard instruction so the model
    // doesn't exhaust iterations without producing the required artifact.
    const isLastChance = writeTarget && i === MAX_ITERATIONS - 2 && filesChanged.length === 0;
    const activeConversation = isLastChance
      ? conversation + `\n\nSystem: FINAL TURNS REMAINING. You MUST call write_file now to write the output to "${writeTarget}". Stop reading files. Compile everything you have learned and call write_file immediately.`
      : conversation;

    // ── Miranda: before_llm_call gate ──────────────────────────────────────
    if (ctx.gate) {
      const gateResult: GateResult = ctx.gate.beforeLLMCall({
        stage: "agent_loop",
        model: ctx.model ?? "unknown",
        budgetUsed: 0,
        budgetLimit: Infinity,
      });
      ctx.recordTrace?.("miranda.before_llm_call", {
        allowed: gateResult.allowed,
        verdict: gateResult.verdict,
        reason: gateResult.reason,
      });
      if (isGateStop(gateResult)) {
        console.error(`[MaestroAdapter] before_llm_call gate BLOCKED: ${gateResult.reason}`);
        return {
          text: "",
          toolEvents,
          filesChanged,
          thoughts: [],
          iterationCount: iterations,
          stoppedBecause: "gate_blocked",
          error: `Miranda gate blocked LLM call: ${gateResult.reason}`,
        };
      }
    }

    const { text } = await ctx.llm.stream(
      activeConversation,
      { maxTokens: 4096, simple: true },
      (chunk) => ctx.emit?.({ type: "stream:token", taskId: ctx.runId, chunk }),
    );
    lastText = text;
    iterations = i + 1;

    const calls = parseToolCalls(text);

    if (calls.length === 0) {
      // No tool calls — model is done.
      break;
    }

    // Append this assistant turn to the conversation.
    conversation += `\n\nAssistant:\n${text}`;
    const assistantText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
    const hasDanglingToolMarkup = /<\/?tool_call>/.test(
      text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, ""),
    );
    let turnAllToolsOk = true;

    // Execute each tool call and append results.
    for (const call of calls) {
      // Dedup: skip if we've already executed the exact same call this run.
      const callSig = `${call.tool}:${JSON.stringify(call.input)}`;
      if (executedCallSigs.has(callSig)) {
        turnAllToolsOk = false;
        console.warn(`[MaestroAdapter] Skipping duplicate tool call: ${call.tool} (identical args already executed)`);
        conversation += formatToolResult(call.tool, false, "Duplicate call skipped — this exact call was already executed successfully.");
        continue;
      }
      executedCallSigs.add(callSig);

      console.error(
        `[MaestroAdapter] tool:call  name=${call.tool}  iteration=${i + 1}/${MAX_ITERATIONS}`,
      );

      // Miranda: before_tool_run gate
      const schema = (ctx.tools as (OrcaToolService & {
        getSchema?: (toolName: string) => {
          required?: string[];
          properties?: Record<string, { type: string }>;
        } | undefined;
      }) | undefined)?.getSchema?.(call.tool);
      const beforeGate = ctx.gate?.beforeToolRun({ tool: call.tool, args: call.input, schema });
      if (beforeGate && !beforeGate.allowed) {
        turnAllToolsOk = false;
        console.error(`[MaestroAdapter] gate blocked tool "${call.tool}": ${beforeGate.reason}`);
        toolEvents.push({
          tool: call.tool,
          ok: false,
          summary: `${call.tool}: blocked by Miranda gate — ${beforeGate.reason}`,
          raw: call.input,
        });
        conversation += formatToolResult(
          call.tool,
          false,
          `Miranda gate blocked this tool call: ${beforeGate.reason}`,
        );
        continue;
      }

      // User approval gate — desktop shows a dialog; CLI auto-approves.
      if (ctx.requestToolApproval) {
        const approved = await ctx.requestToolApproval(call.tool, call.input);
        if (!approved) {
          turnAllToolsOk = false;
          console.error(`[MaestroAdapter] tool:denied  name=${call.tool}`);
          toolEvents.push({
            tool: call.tool,
            ok: false,
            summary: `${call.tool}: denied by user`,
            raw: call.input,
          });
          conversation += formatToolResult(call.tool, false, "Tool call denied by user.");
          continue;
        }
      }

      ctx.recordTrace?.("tool.call", { tool: call.tool, input: call.input });
      const result = await tools.execute(call.tool, call.input);
      const outputText = normalizeToolText(result.output);
      const errorText = result.error === undefined ? undefined : normalizeToolText(result.error);
      const commandFileChanges = result.ok
        ? extractFilesChangedFromCommandOutput(outputText, {
            workspaceRoot: ctx.workspaceRoot,
            cwd: typeof call.input["cwd"] === "string" ? call.input["cwd"] : undefined,
          })
        : [];
      ctx.recordTrace?.("tool.result", { tool: call.tool, ok: result.ok, output: outputText, error: errorText });
      if (!result.ok) {
        turnAllToolsOk = false;
      }

      // Miranda: after_tool_run gate
      ctx.gate?.afterToolRun({ tool: call.tool, args: call.input }, { ok: result.ok, output: outputText });

      const enrichedRaw = { ...call.input } as Record<string, unknown>;
      if (commandFileChanges.length > 0) {
        enrichedRaw["_filesChangedForDiff"] = commandFileChanges;
      }
      if (call.tool === "write_file" && result.ok && typeof call.input["content"] === "string") {
        enrichedRaw["_contentForDiff"] = call.input["content"];
      }
      if (result.ok && outputText.trim().length > 0) {
        enrichedRaw["_outputForProof"] = outputText.slice(0, 4000);
      }

      toolEvents.push({
        tool: call.tool,
        ok: result.ok,
        summary: result.ok
          ? `${call.tool}: ok (${outputText.length} chars)`
          : `${call.tool}: failed — ${result.error ?? "unknown"}`,
        raw: enrichedRaw,
      });

      // Capture written content so Pappy can verify the diff.
      if (call.tool === "write_file" && result.ok) {
        const filePath = typeof call.input["path"] === "string" ? call.input["path"] : "";
        const content = typeof call.input["content"] === "string" ? call.input["content"] : undefined;
        if (filePath) {
          recordFileChange(filesChanged, { path: filePath, changeType: "A", diff: content });
        }
      }
      for (const file of commandFileChanges) {
        recordFileChange(filesChanged, file);
      }

      console.error(
        `[MaestroAdapter] tool:result ok=${result.ok}  chars=${outputText.length}`,
      );

      conversation += formatToolResult(call.tool, result.ok, outputText, errorText);

      // Completion contract: write_file succeeded — the required artifact exists.
      // The runtime already holds this terminal condition; do not burn an extra
      // LLM turn asking the model to confirm or echo the written content.
      // Return the written content directly as the final output.
      if (call.tool === "write_file" && result.ok) {
        const writtenContent = typeof call.input["content"] === "string" ? call.input["content"] : undefined;
        if (writtenContent) {
          lastText = writtenContent;
        }
        loopComplete = true;
        break; // exit inner tool loop; outer loop exits on loopComplete check
      }
    }

    if (
      !loopComplete &&
      turnAllToolsOk &&
      assistantText.length > 0 &&
      !hasDanglingToolMarkup
    ) {
      ctx.recordTrace?.("agent_loop.early_exit", {
        iteration: i + 1,
        reason: "tools_complete",
      });
      loopComplete = true;
    }
  }

  // Post-loop write rescue: if the task required writing a file but the model
  // never called write_file (e.g. it generated analysis as plain text without
  // using tools), make one final targeted call with the analysis as content.
  if (writeTarget && filesChanged.length === 0 && iterations >= 4) {
    ctx.recordTrace?.("agent_loop.rescue.skipped", {
      reason: "loop_exhausted",
      iterations,
    });
  } else if (writeTarget && filesChanged.length === 0 && lastText.trim().length > 0) {
    console.error(`[MaestroAdapter] write:rescue  target=${writeTarget}  analysisChars=${lastText.length}`);
    const rescuePrompt =
      conversation +
      `\n\nSystem: Your analysis is complete. You MUST now call write_file to save it.\n` +
      `Call write_file with path="${writeTarget}" and content=<your full analysis above>.\n` +
      `Do not output anything else. Only the write_file tool call.`;
    // ── Miranda: before_llm_call gate (rescue path) ─────────────────────────
    if (ctx.gate) {
      const gateResult: GateResult = ctx.gate.beforeLLMCall({
        stage: "agent_loop_rescue",
        model: ctx.model ?? "unknown",
        budgetUsed: 0,
        budgetLimit: Infinity,
      });
      ctx.recordTrace?.("miranda.before_llm_call", {
        allowed: gateResult.allowed,
        verdict: gateResult.verdict,
        reason: gateResult.reason,
        path: "rescue",
      });
      if (isGateStop(gateResult)) {
        console.error(`[MaestroAdapter] before_llm_call gate BLOCKED rescue: ${gateResult.reason}`);
        return {
          text: lastText.trim(),
          toolEvents,
          filesChanged,
          thoughts: [],
          iterationCount: iterations,
          stoppedBecause: "gate_blocked",
          error: `Miranda gate blocked LLM call: ${gateResult.reason}`,
        };
      }
    }
    const { text: rescueText } = await ctx.llm.stream(
      rescuePrompt,
      { maxTokens: 8192, simple: true },
      (chunk) => ctx.emit?.({ type: "stream:token", taskId: ctx.runId, chunk }),
    );
    const rescueCalls = parseToolCalls(rescueText);
    for (const call of rescueCalls) {
      if (call.tool !== "write_file") continue;
      const result = await tools.execute(call.tool, call.input);
      const outputText = normalizeToolText(result.output);
      toolEvents.push({
        tool: call.tool,
        ok: result.ok,
        summary: result.ok
          ? `${call.tool}: ok (${outputText.length} chars)`
          : `${call.tool}: failed — ${result.error ?? "unknown"}`,
        raw: typeof call.input["content"] === "string"
          ? { ...call.input, _contentForDiff: call.input["content"] }
          : call.input,
      });
      if (result.ok) {
        const filePath = typeof call.input["path"] === "string" ? call.input["path"] : "";
        const content = typeof call.input["content"] === "string" ? call.input["content"] : undefined;
        if (filePath) recordFileChange(filesChanged, { path: filePath, changeType: "A", diff: content });
        if (content) lastText = content;
      }
      break;
    }
  }

  // Strip dangling tool_call markup from the final response.
  // Three cases:
  //   1. Complete block:      <tool_call>...</tool_call>  (normal)
  //   2. Unclosed opener:     <tool_call>...              (hit MAX_ITERATIONS mid-call)
  //   3. Orphaned closer:     ...}</tool_call>            (opening tag was in prior lastText)
  const cleanText = lastText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")  // case 1
    .replace(/<tool_call>[\s\S]*/g, "")                // case 2
    .replace(/[\s\S]*?<\/tool_call>/g, "")             // case 3
    .trim();

  return {
    text: cleanText,
    toolEvents,
    filesChanged,
    thoughts: [],
    iterationCount: iterations,
    stoppedBecause: loopComplete || cleanText.length > 0 ? "done" : "max_iterations",
  };
}
