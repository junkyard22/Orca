import type { LLMAdapter } from "@clawde/miranda-core";
import type { OrcaRunCtx, OrcaToolService } from "@clawde/orca-core";
import type { AgentAdapter, AgentTask, AgentResult, ThoughtRecord, AgentRunContext, StreamCallback } from "./AgentAdapter";
import type { RoleName } from "maestro-core";

// Type definitions that should be imported from existing files
type Tool = {
  name: string;
  description: string;
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string }>;
  };
  execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }>;
};
type ToolEvent = { tool: string; ok: boolean; summary: string; raw?: unknown };
type FileChange = { path: string; changeType: "A" | "M" | "D"; diff?: string };

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const OPEN_TOOL_CALL_TAG = '<tool_call>';

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseToolCallBody(body: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const jsonCall = parseJsonObject(trimmed);
  if (jsonCall && typeof jsonCall["tool"] === "string" && jsonCall["tool"]) {
    const { tool, ...input } = jsonCall;
    return { tool, input };
  }

  const toolNameMatch = /^([\w-]+)/.exec(trimmed);
  if (!toolNameMatch) return null;

  const tool = toolNameMatch[1]!;
  const rest = trimmed.slice(tool.length);
  const input = parseJsonObject(rest) ?? {};
  const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
  let m: RegExpExecArray | null;
  while ((m = argRe.exec(trimmed)) !== null) input[m[1]!] = m[2]!;

  // Do not treat arbitrary text as a tool call just because it begins with a word.
  if (Object.keys(input).length === 0 && !/<arg_key>|{/.test(rest)) return null;
  return { tool, input };
}

function resolveToolCall(
  call: { tool: string; input: Record<string, unknown> },
  tools: Tool[],
): { tool: Tool; toolName: string; requestedTool: string; input: Record<string, unknown>; aliased: boolean } | null {
  const exact = tools.find((t) => t.name === call.tool);
  if (exact) {
    return { tool: exact, toolName: exact.name, requestedTool: call.tool, input: call.input, aliased: false };
  }

  const aliases: Record<string, string[]> = {
    read_directory: ["list_directory", "desktop-commander_list_directory"],
    list_files: ["list_directory", "desktop-commander_list_directory"],
    list_dir: ["list_directory", "desktop-commander_list_directory"],
    read_dir: ["list_directory", "desktop-commander_list_directory"],
    desktop_commander_search_files: ["search_files", "desktop-commander_start_search"],
    "desktop-commander_search_files": ["search_files", "desktop-commander_start_search"],
    shell: ["run_command", "desktop-commander_execute_command"],
    run_shell: ["run_command", "desktop-commander_execute_command"],
  };
  for (const candidate of aliases[call.tool] ?? []) {
    const tool = tools.find((t) => t.name === candidate);
    if (tool) {
      return { tool, toolName: tool.name, requestedTool: call.tool, input: call.input, aliased: true };
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === "string" && signal.reason.length > 0
        ? signal.reason
        : "The operation was aborted.",
  );
  error.name = "AbortError";
  throw error;
}

/**
 * Parse tool calls from model output.
 *
 * Returns both the successfully parsed calls and a count of `<tool_call>`
 * blocks that were found but could not be parsed by any strategy.
 * Callers use `malformedCount` to emit diagnostics and track parse-failure loops.
 */
function parseToolCalls(text: string): {
  calls: Array<{ tool: string; input: Record<string, unknown> }>;
  malformedCount: number;
} {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let malformedCount = 0;

  // ── Pass 1: strict closed <tool_call>…</tool_call> blocks ────────────────
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    const body = match[1]!;
    let parsed = false;

    const call = parseToolCallBody(body);
    if (call) {
      calls.push(call);
      parsed = true;
    }

    if (!parsed) {
      malformedCount++;
      console.warn(
        `[ReactAgent] Malformed tool block — all parse strategies failed.\n` +
        `  Block content (first 200 chars): ${body.slice(0, 200).replace(/\n/g, '\\n')}`
      );
    }
  }

  // ── Pass 2: lenient — unclosed <tool_call> at end of text ────────────────
  // Some models omit the closing tag; try to recover the trailing fragment.
  if (calls.length === 0) {
    const idx = text.lastIndexOf(OPEN_TOOL_CALL_TAG);
    if (idx !== -1) {
      const body = text.slice(idx + OPEN_TOOL_CALL_TAG.length)
        .replace(/<\/tool_call>[\s\S]*$/, '')
        .trim();

      // Only try to recover if the fragment looks meaningful (>5 chars and not pure whitespace)
      if (body.length > 5) {
        let parsed = false;

        const call = parseToolCallBody(body);
        if (call) {
          calls.push(call);
          parsed = true;
        }

        if (!parsed) {
          // The unclosed fragment was also unparseable — count it only when no
          // closed blocks were found (otherwise the closed-block count already covers it).
          malformedCount++;
          console.warn(
            `[ReactAgent] Malformed unclosed tool block at end of response.\n` +
            `  Fragment (first 200 chars): ${body.slice(0, 200).replace(/\n/g, '\\n')}`
          );
        }
      }
    }
  }

  return { calls, malformedCount };
}

function formatToolResult(tool: string, ok: boolean, output: string, error?: string): string {
  const status = ok ? 'ok="true"' : 'ok="false"';
  const body   = ok ? output : (error ?? output ?? 'unknown error');
  return `\n<tool_result tool="${tool}" ${status}>\n${body}\n</tool_result>`;
}

const REACT_PROMPT_BLOCK = `

EXECUTION MODEL — READ THIS FIRST:
1. Call a tool. Wait for the result.
2. Reason about what you learned (Thought/Observation/Next).
3. Call another tool if needed. Repeat until you have everything required.
4. Only write FINAL ANSWER: when ALL required work is done (files read, files written if asked).

CRITICAL: You MUST call at least one tool before writing FINAL ANSWER: whenever your task involves reading files, analyzing a repo, or saving output. "I think I should look at..." is NOT a tool call — make the actual call.

After receiving a tool result, reason before acting again:

Thought: [what did I just learn? what does it mean for the task?]
Observation: [current state of the task based on everything so far]
Next: [what to do next and why — or "Task is complete" if done]

FILE WRITING — MANDATORY:
If your task involves creating or modifying a file (any filename with an extension, e.g. .ts .js .py .json .md):
1. Call write_file with the complete file content BEFORE writing your final answer
2. Your FINAL ANSWER must confirm what was written — it must NOT contain the file content itself
3. Never output source code or document content inline as a substitute for calling write_file

PREFERRED FORMAT:
- Your Thought/Observation/Next blocks are INTERNAL REASONING ONLY
- They must NEVER appear in your final answer to the user
- Prefer writing a Thought block before each tool call (not required, but helps reasoning quality)
- When the task is complete, write your final answer using EXACTLY this format:

FINAL ANSWER:
Write the actual user-facing answer here. Do not copy this instruction or any placeholder text.

- Everything before FINAL ANSWER: is thinking
- Everything after FINAL ANSWER: is what the user receives
- If you are done and have no tool calls, you MUST use the FINAL ANSWER: marker
`;

function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .trim();
}

function extractFinalAnswer(rawText: string): string | null {
  const marker = 'FINAL ANSWER:';
  const idx = rawText.indexOf(marker);
  if (idx !== -1) {
    return rawText.slice(idx + marker.length).trim();
  }
  return null;
}

function stripThoughtBlocks(text: string): string {
  // Strip ReAct header lines AND the content paragraphs that follow them.
  // A "thought section" is a Thought:/Observation:/Next: header followed by
  // lines until the next header, a blank line, FINAL ANSWER:, or end-of-string.
  //
  // Phase 1: strip whole sections (header + following content lines)
  let result = text.replace(
    /^(Thought|Observation|Next):\s*[\s\S]*?(?=\n(?:Thought|Observation|Next|FINAL ANSWER):|\n\n|$)/gim,
    '',
  );
  // Phase 2: catch any orphaned single-line headers that Phase 1 missed
  result = result.replace(/^(Thought|Observation|Next):.*$/gm, '');
  // Phase 3: strip narration preamble lines that are clearly internal planning
  result = result.replace(/^(Good[,.] I can see|I can see|I'll start|I want to make sure|I need to:?|Now I'll|Now I need|Now let me|Let me continue|Let me explore|OK[,.]|Alright[,.])\b.*$/gmi, '');
  // Phase 4: strip numbered planning lists ("1. The X to check Y", "2. Check the ...")
    result = result.replace(/^\s*\d+\.\s+(The |Check |Look |Read |Verify |Examine |Inspect |Review |Analyze |Search |Find |Any ).*$/gmi, '');
  // Phase 5: strip inline planning sentences mid-paragraph (Let me continue..., I should check...)
  result = result.replace(/[.]\s*(?:Now\s+)?[Ll]et me (?:also\s+|just\s+|quickly\s+|then\s+|now\s+|go ahead and\s+)?(?:think|check|look|see|read|search|verify|review|examine|analyze|inspect|investigate|find|determine|try|continue|explore|understand)[^.!?\n]*[.!?]?/gi, '.');
  result = result.replace(/[.]\s*I (?:should|need to|want to|'ll|will) (?:check|look|read|verify|examine|inspect|review|analyze|search|find|explore|investigate|continue|start|begin|make sure|understand)[^.!?\n]*[.!?]?/g, '.');
  return result
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikePureProgress(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    /\[your complete response to the user here\b/i.test(trimmed) ||
    /\b(?:is still in progress|are still in progress)\b/i.test(trimmed) ||
    /\bOnce (?:the )?.{0,80}(?:complete|finish|done|available),?\s+I (?:will|can)\b/i.test(trimmed) ||
    /\bPlease provide .{0,120}\bso (?:that )?I (?:can|will)\b/i.test(trimmed)
  );
}

function taskExplicitlyRequestsFileSave(text: string): boolean {
  const fileExtPattern = String.raw`[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|py|css|html|csv|sh|ps1)`;
  const saveVerbPattern = String.raw`(?:save|saves|saved|saving|write|writes|writing|wrote|written|create|creates|created|creating|update|updates|updated|updating|modify|modifies|modified|modifying|edit|edits|edited|editing|replace|replaces|replaced|replacing|patch|patches|patched|patching|add|adds|added|adding|fix|fixes|fixed|fixing|implement|implements|implemented|implementing|generate|generates|generated|generating)`;
  const hasPathLikeTarget = new RegExp(String.raw`\b${fileExtPattern}\b`, "i").test(text);
  return (
    new RegExp(String.raw`\b${saveVerbPattern}\b.{0,80}\b${fileExtPattern}\b`, "i").test(text) ||
    new RegExp(String.raw`\b${fileExtPattern}\b.{0,80}\b(saved|written|updated|modified|edited|created|fixed|implemented|generated)\b`, "i").test(text) ||
    (hasPathLikeTarget && /\b(save|saves|saved|saving|write|writes|writing|wrote|written|create|creates|created|creating|generate|generates|generated|generating)\b.{0,40}(report|file|output|result|summary|plan|audit)\b/i.test(text))
  );
}

export class ReactAgentAdapter implements AgentAdapter {
  readonly role: RoleName;
  private llmAdapter: LLMAdapter;
  private systemPrompt: string;
  private maxIterations: number;
  private maxTokens: number;
  private temperature: number;

  // Loop detection constants
  private readonly LOOP_WINDOW = 3;        // consecutive identical calls = loop
  private readonly THRASH_WINDOW = 6;      // alternating pattern window
  private readonly EMPTY_RESULT_LIMIT = 3; // consecutive empty/error results = loop
  private readonly PARSE_FAILURE_LIMIT = 3; // consecutive iterations with malformed tool blocks

  constructor(
    llmAdapter: LLMAdapter,
    systemPrompt: string,
    role: RoleName,
    maxIterations: number = 10,
    maxTokens: number = 8192,
    temperature: number = 0.7,
  ) {
    this.llmAdapter    = llmAdapter;
    this.systemPrompt  = systemPrompt;
    this.role          = role;
    this.maxIterations = maxIterations;
    this.maxTokens     = maxTokens;
    this.temperature   = temperature;
  }

  async run(task: AgentTask, tools: Tool[], ctx: AgentRunContext): Promise<AgentResult> {
    const thoughts: ThoughtRecord[] = [];
    const toolsUsed: ToolEvent[] = [];
    const filesChanged: FileChange[] = [];
    let iterationCount = 0;
    let currentOutputText = '';
    let lastModelOutput = '';
    let stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'parse_failure_loop' | 'no_final_output' | 'error' = 'max_iterations';
    let error: string | undefined;
    
    // Loop detection state
    const callHistory: string[] = [];
    let consecutiveEmptyResults = 0;
    let consecutiveParseFailures = 0;
    let loopEvidence: { iteration: number; repeatedCall: string; occurrences: number } | undefined;
    
    // Tool Use Discipline enforcement
    let cumulativeToolCallCount = 0;
    let toolLimitWarningInjected = false;
    let finalAnswerFound = false;
    // Capture the most recent FINAL ANSWER that was rejected by the write_file guard.
    // Used by the post-loop rescue to save the model's analysis even when it never
    // called write_file on its own.
    let lastRejectedFinalAnswer = '';
    
    const availableTools = tools;
    const toolSchemaLines = availableTools.flatMap((tool) => {
      const params = tool.schema?.properties
        ? Object.entries(tool.schema.properties as Record<string, { type?: string; description?: string }>)
            .map(([k, v]) => `  - ${k} (${v.type ?? "string"}): ${v.description ?? ""}`)
            .join("\n")
        : "";
      return params
        ? [`- ${tool.name}: ${tool.description}\n${params}`]
        : [`- ${tool.name}: ${tool.description}`];
    });
    const toolPrompt = availableTools.length > 0
      ? [
          "## Available Tools",
          ...toolSchemaLines,
          "",
          "### Tool Call Format",
          "To invoke a tool you MUST use this exact XML format — never output tool names as plain text:",
          "",
          '<tool_call>{"tool": "TOOL_NAME", "PARAM1": "VALUE1", "PARAM2": "VALUE2"}</tool_call>',
          'Do not write tool_name{"param":"value"} or put the tool name outside the JSON object.',
          "",
          "Example — run a shell command:",
          '<tool_call>{"tool": "run_command", "command": "ls -la"}</tool_call>',
          "",
          "Example — read a file:",
          '<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>',
          "",
          "Only ONE tool_call per response. Wait for the result before calling the next tool.",
        ].join("\n")
      : "## Available Tools\nNo tools are available for this task. Work from the provided context only.";
    
    // Build initial conversation history
    let conversationHistory = task.conversationHistory || [];
    
    // When the task involves writing a file, put a hard imperative first so
    // even models that skip the system prompt can't miss it.
    // Check both intent AND goals — repair tasks use intent="repair" so the
    // file extension only appears in the goals list.
    const goalText = task.goals.join(' ');
    const intentAndGoals = `${task.intent} ${goalText}`;
    const needsFileWrite = taskExplicitlyRequestsFileSave(intentAndGoals);
    const fileWriteDirective = needsFileWrite
      ? "**ACTION REQUIRED: Call write_file to save the file content to disk. Do NOT output the file content inline — use the tool.**\n\n"
      : "";

    // Add system prompt and task context
    const taskContext = [
      fileWriteDirective + `## Task Intent`,
      task.intent,
      "",
      `## Goals`,
      ...task.goals.map(g => `- ${g}`),
      "",
      `## Done Criteria`,
      ...task.doneCriteria.map(c => `- ${c}`),
      "",
      toolPrompt,
    ].join("\n");
    
    // Append ReAct system prompt block
    const fullSystemPrompt = `${this.systemPrompt}${REACT_PROMPT_BLOCK}`;
    
    // Initialize conversation with system prompt, prior turns, then the new task.
    let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: fullSystemPrompt },
      ...conversationHistory,
      { role: "user", content: taskContext }
    ];
    ctx.recordTrace?.("agent.run.start", {
      role: this.role,
      maxIterations: this.maxIterations,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      tools: availableTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      })),
      task,
      systemPrompt: fullSystemPrompt,
      taskContext,
    });
    
    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        throwIfAborted(ctx.abortSignal);
        iterationCount = iteration + 1;
        
        // On iterations after the first, reset the stream bubble so users
        // only see the latest generation — not accumulated thought blocks or
        // tool call XML from prior iterations.
        if (iteration > 0) {
          ctx.onStreamReset?.();
        }

        // Call the model - use streaming if available and callback provided
        let response;
        const useStreaming = ctx.onStreamToken && this.llmAdapter.stream;
        ctx.recordTrace?.("agent.iteration.request", {
          role: this.role,
          iteration: iterationCount,
          useStreaming: !!useStreaming,
          messages,
        });
        
        if (useStreaming) {
          // Streaming call - tokens are emitted as they arrive
          response = await this.llmAdapter.stream!(
            {
              model: '', // empty → adapter uses its own defaultModel
              messages,
              maxTokens: this.maxTokens,
              temperature: this.temperature,
              signal: ctx.abortSignal,
            },
            ctx.onStreamToken!
          );
        } else {
          // Non-streaming fallback
          response = await this.llmAdapter.complete({
            model: '', // empty → adapter uses its own defaultModel
            messages,
            maxTokens: this.maxTokens,
            temperature: this.temperature,
            signal: ctx.abortSignal,
          });
        }

        const modelOutput = response.content;
        throwIfAborted(ctx.abortSignal);
        lastModelOutput = modelOutput;
        messages.push({ role: "assistant", content: modelOutput });
        ctx.recordTrace?.("agent.iteration.response", {
          role: this.role,
          iteration: iterationCount,
          output: modelOutput,
        });
        
        // Extract Thought/Observation/Next blocks with proper multiline matching
        // Using [\s\S]*? with s flag (dotAll) to match across newlines
        const thoughtMatch = modelOutput.match(/Thought:\s*([\s\S]*?)(?:\n|$)/i);
        const observationMatch = modelOutput.match(/Observation:\s*([\s\S]*?)(?:\n|$)/i);
        const nextMatch = modelOutput.match(/Next:\s*([\s\S]*?)(?:\n|$)/i);
        
        let thought = thoughtMatch ? thoughtMatch[1].trim() : "";
        let observation = observationMatch ? observationMatch[1].trim() : "";
        let next = nextMatch ? nextMatch[1].trim() : "";
        
        // Emit maestro:thought event if we have a thought block
        if (thought || observation || next) {
          const thoughtRecord: ThoughtRecord = {
            iteration: iterationCount,
            thought,
            observation,
            next
          };
          thoughts.push(thoughtRecord);
          ctx.recordTrace?.("agent.iteration.thought", {
            role: this.role,
            iteration: iterationCount,
            thoughtRecord,
          });
          
          if (ctx.emit) {
            ctx.emit({
              type: 'maestro:thought',
              taskId: ctx.runId,
              iteration: iterationCount,
              thought,
              observation,
              next
            });
          }
        } else {
          // Defensive logging: log when thought extraction fails so we can see it in the tracer
          console.log(`[ReactAgent] No Thought block found in iteration ${iterationCount} — model may have skipped format`);
          console.log(`[ReactAgent] Raw output[0..200]: "${modelOutput.slice(0, 200).replace(/\n/g, "\\n")}..."`);
        }
        
        // Parse tool calls
        const { calls: toolCalls, malformedCount } = parseToolCalls(modelOutput);
        ctx.recordTrace?.("agent.iteration.tool_parse", {
          role: this.role,
          iteration: iterationCount,
          malformedCount,
          toolCalls,
        });

        // ── Parse-failure loop guard ──────────────────────────────────────────
        // If the model emitted <tool_call> blocks but none could be parsed,
        // inject a corrective message and track the failure. Three consecutive
        // iterations of this stops the run so it doesn't silently spin.
        const hasRawToolCallTag = modelOutput.includes('<tool_call>');
        if (hasRawToolCallTag && malformedCount > 0 && toolCalls.length === 0) {
          consecutiveParseFailures++;
          ctx.recordTrace?.("agent.iteration.parse_failure", {
            role: this.role,
            iteration: iterationCount,
            malformedCount,
            consecutiveParseFailures,
            output: modelOutput,
          });
          console.warn(
            `[ReactAgent] Parse-failure #${consecutiveParseFailures} at iteration ${iterationCount}: ` +
            `${malformedCount} malformed block(s), 0 valid calls. ` +
            `(limit=${this.PARSE_FAILURE_LIMIT})`
          );
          messages.push({
            role: 'user',
            content:
              'Your tool call was not properly formatted and could not be parsed.\n' +
              'Tool calls MUST be valid JSON inside <tool_call>…</tool_call> tags with a "tool" key, e.g.:\n' +
              '<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>\n' +
              'Please retry with a correctly formatted tool call, or write your FINAL ANSWER: if done.'
          });
          if (consecutiveParseFailures >= this.PARSE_FAILURE_LIMIT) {
            console.warn(
              `[ReactAgent] parse_failure_loop: ${consecutiveParseFailures} consecutive malformed ` +
              `tool blocks — stopping run.`
            );
            stoppedBecause = 'parse_failure_loop';
            loopEvidence = {
              iteration: iterationCount,
              repeatedCall: 'malformed <tool_call> block',
              occurrences: consecutiveParseFailures
            };
            ctx.recordTrace?.("agent.loop_detected", {
              role: this.role,
              iteration: iterationCount,
              stoppedBecause,
              loopEvidence,
            });
            break;
          }
          continue; // give model a chance to correct its format
        } else if (!hasRawToolCallTag || toolCalls.length > 0) {
          // Reset counter when either no tool call was attempted or a valid call was parsed
          consecutiveParseFailures = 0;
        }
        
        // Check for FINAL ANSWER in any response to track if we've found one
        const cleanedOutput = stripToolCalls(modelOutput);
        const finalAnswer = extractFinalAnswer(cleanedOutput);
        if (finalAnswer) {
          finalAnswerFound = true;
        }
        
        // Tool Use Discipline: warn when approaching the iteration ceiling so the model wraps up.
        // Fire 3 iterations before the end so the model has time to call write_file AND produce
        // a FINAL ANSWER — two distinct operations that each need their own turn.
        // (The old cumulativeToolCallCount-based trigger never fired for 10-iteration runs
        // because it required 30 tool calls, which is 3× the iteration budget.)
        const iterationsRemaining = this.maxIterations - iteration - 1;
        if (iterationsRemaining === 2 && iteration >= 1 && !toolLimitWarningInjected && !finalAnswerFound) {
          toolLimitWarningInjected = true;
          const allTaskTextForWarn = `${task.intent} ${task.goals.join(' ')} ${task.doneCriteria.join(' ')}`;
          const taskImpliesFileSaveForWarn = taskExplicitlyRequestsFileSave(allTaskTextForWarn);
          const writeFileCalledForWarn = toolsUsed.some(e => e.tool === 'write_file');
          const writeFileReminder = taskImpliesFileSaveForWarn && !writeFileCalledForWarn
            ? '\n\nCRITICAL: Your task requires saving a file. You MUST call write_file with the complete file content in your NEXT response — before writing your final answer.'
            : '';
          messages.push({
            role: "user",
            content: `You have 2 turns remaining.${writeFileReminder}\nAfter any required tool call (e.g. write_file), your next response MUST be your FINAL ANSWER using the FINAL ANSWER: marker.`,
          });
          continue; // give the model a clean turn to act on this warning
        }
        
        if (toolCalls.length === 0) {
          if (finalAnswer) {
            // Guard: if the task clearly requires file/repo investigation and no tools
            // were called at all, the model skipped the work — reject the premature answer.
            // Check both intent and goals — repair tasks use intent="repair", so file/tool
            // indicators only appear in the goals list.
            const allTaskText = `${task.intent} ${task.goals.join(' ')}`;
            const taskImpliesToolUse = (
              /\b(analyz|investigat|examin|read|list|search|find|save|write|creat)\w*/i.test(allTaskText) ||
              /\b\w+\.\w{2,5}\b/.test(allTaskText)  // explicit filename with extension
            );
            if (taskImpliesToolUse && cumulativeToolCallCount === 0) {
              messages.push({
                role: 'user',
                content:
                  'Your task requires you to investigate files and/or write output to disk, but you have not called any tools yet. ' +
                  'Do NOT write a final answer until you have:\n' +
                  '1. Used read_file or list_directory to examine the relevant files\n' +
                  '2. Called write_file if the task asks you to save a file\n\n' +
                  'Start by calling a tool now. Do not describe what you plan to do — make the actual tool call.',
              });
              continue;
            }
            // Guard: if the task explicitly asks to save output to a file, write_file
            // must have been called before we accept a FINAL ANSWER.
            const taskImpliesFileSave = taskExplicitlyRequestsFileSave(allTaskText);
            const writeFileCalled = toolsUsed.some(e => e.tool === 'write_file');
            if (taskImpliesFileSave && !writeFileCalled) {
              // Save this final answer — if the model keeps refusing to call write_file,
              // the post-loop rescue will use this content to write the file directly.
              lastRejectedFinalAnswer = finalAnswer;
              messages.push({
                role: 'user',
                content:
                  'Your task explicitly asks you to save a file, but you have not called write_file yet. ' +
                  'You MUST call write_file with the complete file content before writing your FINAL ANSWER. ' +
                  'Call write_file now.',
              });
              continue;
            }
            currentOutputText = finalAnswer;
            stoppedBecause = 'done';
            ctx.recordTrace?.("agent.final_answer", {
              role: this.role,
              iteration: iterationCount,
              outputText: currentOutputText,
            });
            break;
          }

          // Only preserve non-empty text — don't overwrite a good draft with an
          // empty response.  Critically, don't preserve pure thinking/planning
          // text that the model emitted without a FINAL ANSWER: marker — that
          // would surface internal monologue to the user if the loop later exits
          // at max_iterations.
          const extractedText = stripThoughtBlocks(cleanedOutput);
          // Only reject short single-sentence thinking preambles.  Multi-paragraph
          // text that starts with a thinking opener may contain real content after
          // the first sentence — don't discard it.
          const trimmed = extractedText.trim();
          const looksLikePureThinking = trimmed.length < 500
            && !/\n/.test(trimmed)
            && /^(Good|OK|Alright|Let me|I('ll| will| need| want| should)|Now |First)/im.test(trimmed);
          const isSubstantive = trimmed.length > 0 && !looksLikePureThinking;
          // Only overwrite currentOutputText if the new text is longer — prevents
          // a short thinking sentence like "I've gathered enough information" from
          // clobbering a longer analysis the model produced in an earlier iteration.
          if (isSubstantive && trimmed.length > currentOutputText.trim().length) {
            currentOutputText = extractedText;
          }
          // Do not exit — continue to next iteration to allow model to retry
          // with proper formatting. Only exit on FINAL ANSWER or max_iterations.
          messages.push({ role: "user", content: "Your response was not properly formatted. Please use the FINAL ANSWER: marker for your final response, or use tool calls to complete the task." });
          continue;
        }
        
        // Execute tool calls
        for (const call of toolCalls) {
          throwIfAborted(ctx.abortSignal);
          const resolvedCall = resolveToolCall(call, availableTools);
          if (!resolvedCall) {
            // Unknown tool - add error result
            const errorResult = formatToolResult(call.tool, false, '', `Unknown tool: ${call.tool}`);
            messages.push({ role: "user", content: errorResult });
            toolsUsed.push({
              tool: call.tool,
              ok: false,
              summary: `Unknown tool: ${call.tool}`,
              raw: call.input
            });
            ctx.recordTrace?.("agent.tool.unknown", {
              role: this.role,
              iteration: iterationCount,
              tool: call.tool,
              input: call.input,
            });
            continue;
          }
          const { tool, toolName, input: toolInput } = resolvedCall;
          if (resolvedCall.aliased) {
            ctx.recordTrace?.("agent.tool.alias", {
              role: this.role,
              iteration: iterationCount,
              requestedTool: resolvedCall.requestedTool,
              resolvedTool: toolName,
              input: toolInput,
            });
          }

          const gateCtx = {
            tool: toolName,
            args: toolInput,
            schema: tool.schema,
          };
          const beforeToolGate = ctx.gate?.beforeToolRun(gateCtx);
          if (beforeToolGate && !beforeToolGate.allowed) {
            const gateError = beforeToolGate.reason || `Tool "${toolName}" blocked by Miranda`;
            const gateResult = formatToolResult(toolName, false, "", gateError);
            messages.push({ role: "user", content: gateResult });
            ctx.recordTrace?.("agent.tool.blocked", {
              role: this.role,
              iteration: iterationCount,
              tool: toolName,
              requestedTool: resolvedCall.requestedTool,
              input: toolInput,
              reason: gateError,
            });
            toolsUsed.push({
              tool: toolName,
              ok: false,
              summary: `${toolName}: blocked — ${gateError}`,
              raw: toolInput,
            });
            continue;
          }
          
          // Fix 2: write_file content validation guard
          if (toolName === 'write_file' && typeof toolInput.content !== 'string') {
            console.log(`[ReactAgent] BLOCKED: write_file requires "content" string parameter`);
            const errorResult = formatToolResult(toolName, false, '', 'write_file requires a "content" string parameter');
            messages.push({ role: "user", content: errorResult });
            ctx.recordTrace?.("agent.tool.invalid_input", {
              role: this.role,
              iteration: iterationCount,
              tool: toolName,
              input: toolInput,
              error: 'write_file requires a "content" string parameter',
            });
            toolsUsed.push({
              tool: toolName,
              ok: false,
              summary: `write_file: failed — requires "content" string parameter`,
              raw: toolInput
            });
            continue;
          }
          
          // Execute the tool
          const toolContext = {
            workspaceRoot: ctx.workspaceRoot ?? process.cwd(),
            runId: ctx.runId,
            abortSignal: ctx.abortSignal,
            requestApproval: ctx.requestToolApproval
              ? (toolName: string, args: Record<string, unknown>, _reason: string) =>
                  ctx.requestToolApproval!(toolName, args)
              : undefined,
          };
          ctx.recordTrace?.("agent.tool.call", {
            role: this.role,
            iteration: iterationCount,
            tool: toolName,
            requestedTool: resolvedCall.requestedTool,
            input: toolInput,
          });
          const result = await tool.execute(toolInput, toolContext);
          throwIfAborted(ctx.abortSignal);
          ctx.gate?.afterToolRun(gateCtx, { ok: result.ok, output: result.output });
          ctx.recordTrace?.("agent.tool.result", {
            role: this.role,
            iteration: iterationCount,
            tool: toolName,
            requestedTool: resolvedCall.requestedTool,
            input: toolInput,
            result,
          });
          
          // Tool Use Discipline: Increment cumulative counter
          cumulativeToolCallCount++;
          
          // Format tool result
          const toolResult = formatToolResult(toolName, result.ok, result.output, result.error);
          messages.push({ role: "user", content: toolResult });
          
          // Record tool usage
          toolsUsed.push({
            tool: toolName,
            ok: result.ok,
            summary: result.ok
              ? `${toolName}: ok (${result.output.length} chars)`
              : `${toolName}: failed — ${result.error ?? 'unknown'}`,
            raw: toolInput
          });
          
          // Fix 3: Track file changes with content diff for Pappy verification
          if (result.ok && ['write_file', 'create_file', 'delete_file', 'modify_file'].includes(toolName)) {
            const filePath = typeof toolInput.path === 'string' ? toolInput.path : '';
            if (filePath) {
              const content = typeof toolInput.content === 'string' ? toolInput.content : undefined;
              const diff = content ? content.slice(0, 2000) : undefined; // Truncate for storage
              filesChanged.push({
                path: filePath,
                changeType: toolName === 'delete_file' ? 'D' : toolName === 'create_file' ? 'A' : 'M',
                diff
              });
            }
          }
          
          // === LOOP DETECTION CHECKS ===
          
          // Record this tool call in history for loop detection
          const callSig = `${toolName}:${JSON.stringify(toolInput)}`;
          callHistory.push(callSig);

          // Check 1: Empty/error result loop
          if (!result.ok || !result.output || result.output.trim() === '' || result.output.startsWith('Error')) {
            consecutiveEmptyResults++;
            if (consecutiveEmptyResults >= this.EMPTY_RESULT_LIMIT) {
              console.warn(`[ReactAgent] Empty/error result loop: ${consecutiveEmptyResults} consecutive failures`);
              stoppedBecause = 'loop_detected';
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: `${toolName} returning empty/error`,
                occurrences: consecutiveEmptyResults
              };
              ctx.recordTrace?.("agent.loop_detected", {
                role: this.role,
                iteration: iterationCount,
                stoppedBecause,
                loopEvidence,
              });
              break;
            }
          } else {
            consecutiveEmptyResults = 0; // reset on successful result
          }
          
          // Check 2: Identical call loop (same call repeated LOOP_WINDOW times)
          if (callHistory.length >= this.LOOP_WINDOW) {
            const window = callHistory.slice(-this.LOOP_WINDOW);
            if (window.every(s => s === window[0])) {
              console.warn(`[ReactAgent] Loop detected: "${window[0]}" repeated ${this.LOOP_WINDOW} times`);
              stoppedBecause = 'loop_detected';
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: window[0],
                occurrences: this.LOOP_WINDOW
              };
              ctx.recordTrace?.("agent.loop_detected", {
                role: this.role,
                iteration: iterationCount,
                stoppedBecause,
                loopEvidence,
              });
              break;
            }
          }
          
          // Check 3: Thrashing pattern (alternating between two calls)
          if (callHistory.length >= this.THRASH_WINDOW) {
            const window = callHistory.slice(-this.THRASH_WINDOW);
            const evens = window.filter((_, i) => i % 2 === 0);
            const odds = window.filter((_, i) => i % 2 !== 0);
            const isThrashing = 
              evens.every(s => s === evens[0]) && 
              odds.every(s => s === odds[0]) && 
              evens[0] !== odds[0];
            
            if (isThrashing) {
              console.warn(`[ReactAgent] Thrash detected: alternating between "${evens[0]}" and "${odds[0]}"`);
              stoppedBecause = 'loop_detected';
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: `${evens[0]} ↔ ${odds[0]}`,
                occurrences: this.THRASH_WINDOW
              };
              break;
            }
          }
          
        }
        
        // If loop was detected, break out of the iteration loop
        if (stoppedBecause === 'loop_detected') {
          break;
        }
      }
      
      // ── Post-loop write rescue ────────────────────────────────────────────────
      // If the task required a file write, the model never called write_file, but
      // it DID produce a FINAL ANSWER (which was rejected by the guard), call
      // write_file now using that content.  This handles models that understand the
      // task but consistently refuse to emit <tool_call> blocks on their own.
      const allTaskTextForRescue = `${task.intent} ${task.goals.join(' ')} ${task.doneCriteria.join(' ')}`;
      const taskImpliesFileSaveRescue = taskExplicitlyRequestsFileSave(allTaskTextForRescue);
      const writeFileCalledRescue = toolsUsed.some(e => e.tool === 'write_file');

      if (taskImpliesFileSaveRescue && !writeFileCalledRescue && lastRejectedFinalAnswer.trim().length > 100) {
        // Extract the target file path from doneCriteria or task text.
        const pathMatch =
          allTaskTextForRescue.match(/\b([\w.\-/]+\.(?:md|txt|ts|js|json|yaml|yml|py|sh|csv))\b/i);
        const targetPath = pathMatch?.[1] ?? '';
        const writeTool = availableTools.find(t => t.name === 'write_file');
        if (targetPath && writeTool) {
          try {
            ctx.recordTrace?.("agent.postloop_write_rescue", { targetPath, contentLength: lastRejectedFinalAnswer.length });
            const writeResult = await writeTool.execute(
              { path: targetPath, content: lastRejectedFinalAnswer },
              { workspaceRoot: ctx.workspaceRoot },
            );
            toolsUsed.push({ tool: 'write_file', ok: writeResult.ok, summary: writeResult.ok ? `Rescued: wrote ${targetPath}` : writeResult.error ?? 'write failed' });
            if (writeResult.ok) {
              filesChanged.push({ path: targetPath, changeType: 'A' });
              currentOutputText = lastRejectedFinalAnswer;
            }
          } catch (rescueErr) {
            ctx.recordTrace?.("agent.postloop_write_rescue.error", { error: String(rescueErr) });
          }
        }
      }

      if (!finalAnswerFound && toolsUsed.length > 0 && stoppedBecause === 'max_iterations') {
        try {
          ctx.recordTrace?.("agent.finalization.request", {
            role: this.role,
            iterationCount,
            toolCount: toolsUsed.length,
          });
          const finalization = await this.llmAdapter.complete({
            model: '',
            messages: [
              ...messages,
              {
                role: "user",
                content:
                  "No more tool calls are allowed. Use only the tool results already in this conversation. " +
                  "Produce the final user-facing deliverable now using exactly this format:\n\n" +
                  "FINAL ANSWER:\n" +
                  "The complete answer to the user's request.",
              },
            ],
            maxTokens: this.maxTokens,
            temperature: Math.min(this.temperature, 0.3),
            signal: ctx.abortSignal,
          });
          throwIfAborted(ctx.abortSignal);
          const finalizationText = stripToolCalls(finalization.content);
          const finalizationAnswer = extractFinalAnswer(finalizationText);
          ctx.recordTrace?.("agent.finalization.response", {
            role: this.role,
            output: finalization.content,
            accepted: !!finalizationAnswer && !looksLikePureProgress(finalizationAnswer),
          });
          if (finalizationAnswer && !looksLikePureProgress(finalizationAnswer)) {
            finalAnswerFound = true;
            currentOutputText = finalizationAnswer;
            lastModelOutput = finalization.content;
            stoppedBecause = 'done';
            ctx.recordTrace?.("agent.final_answer", {
              role: this.role,
              iteration: iterationCount,
              outputText: currentOutputText,
              recoveredAfterMaxIterations: true,
            });
          }
        } catch (finalizationErr) {
          if (isAbortError(finalizationErr)) throw finalizationErr;
          ctx.recordTrace?.("agent.finalization.error", {
            role: this.role,
            error: finalizationErr instanceof Error ? finalizationErr.message : String(finalizationErr),
          });
        }
      }

      const cleanedLastOutput = stripToolCalls(lastModelOutput);
      // Prefer accumulated output (set on each iteration) over a fresh strip of
      // the last response — if stripping left nothing, fall back to the raw
      // tool-stripped output so the user always sees something rather than an
      // empty string that bubbles up as "did not complete as expected".
      let finalOutput = currentOutputText || cleanedLastOutput.trim();
      
      // ── No-final-output detection ─────────────────────────────────────────
      // If the run ended without a FINAL ANSWER: and the derived output is empty
      // (or only whitespace), surface this explicitly. Callers and Pappy need to
      // know the run produced no deliverable even though tools may have fired.
      const effectiveOutput = finalOutput.trim();
      // Strip thought blocks before classifying — "Thought: …" lines are internal
      // reasoning, not user-facing output. If the only content left after stripping
      // is thought blocks, the run produced no real deliverable.
      const strippedForClassification = stripThoughtBlocks(effectiveOutput).trim();
      if (!finalAnswerFound && toolsUsed.length > 0 && stoppedBecause === 'max_iterations') {
        stoppedBecause = 'no_final_output';
        finalOutput = '';
        console.warn(
          `[ReactAgent] no_final_output: run exhausted ${iterationCount} iteration(s) ` +
          `after ${toolsUsed.length} tool event(s) without a FINAL ANSWER.`
        );
      }
      // Graceful fallback: a model that skipped the FINAL ANSWER: marker but produced
      // real text without needing tools is still done — don't penalise simple answers.
      if (strippedForClassification && !looksLikePureProgress(strippedForClassification) && stoppedBecause === 'max_iterations') {
        stoppedBecause = 'done';
      }
      if (!finalAnswerFound && strippedForClassification.length === 0 && stoppedBecause === 'max_iterations') {
        stoppedBecause = 'no_final_output';
        console.warn(
          `[ReactAgent] no_final_output: run completed ${iterationCount} iteration(s) ` +
          `with ${toolsUsed.length} tool event(s) but produced no FINAL ANSWER.`
        );
      }
      ctx.recordTrace?.("agent.run.completed", {
        role: this.role,
        iterationCount,
        stoppedBecause,
        finalAnswerFound,
        outputText: finalOutput,
        toolsUsed,
        filesChanged,
        loopEvidence,
      });
      
      return {
        outputText: finalOutput,
        thoughts,
        toolsUsed,
        filesChanged,
        iterationCount,
        stoppedBecause,
        error,
        loopEvidence
      };
      
    } catch (err) {
      if (isAbortError(err)) {
        ctx.recordTrace?.("agent.run.aborted", {
          role: this.role,
          iterationCount,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      stoppedBecause = 'error';
      error = err instanceof Error ? err.message : String(err);
      ctx.recordTrace?.("agent.run.error", {
        role: this.role,
        iterationCount,
        error,
      });
      
      return {
        outputText: '',
        thoughts,
        toolsUsed,
        filesChanged,
        iterationCount,
        stoppedBecause,
        error,
        loopEvidence
      };
    }
  }
}
