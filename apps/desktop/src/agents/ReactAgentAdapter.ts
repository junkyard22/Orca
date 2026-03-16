import type { LLMAdapter } from "@clawde/miranda-core";
import type { OrcaRunCtx, OrcaToolService } from "@clawde/orca-core";
import type { AgentAdapter, AgentTask, AgentResult, ThoughtRecord, AgentRunContext, StreamCallback } from "./AgentAdapter";
import type { RoleName } from "maestro-core";

// Type definitions that should be imported from existing files
type Tool = { name: string; description: string; execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }> };
type ToolEvent = { tool: string; ok: boolean; summary: string; raw?: unknown };
type FileChange = { path: string; changeType: "A" | "M" | "D"; diff?: string };

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const OPEN_TOOL_CALL_TAG = '<tool_call>';

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

    // Strategy A – JSON with a "tool" key
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      const { tool, ...input } = obj;
      if (typeof tool === 'string' && tool) {
        calls.push({ tool, input });
        parsed = true;
      }
    } catch { /* fall through to next strategy */ }

    // Strategy B – XML-attribute style inside the block
    if (!parsed) {
      const toolNameMatch = /^([\w-]+)/.exec(body.trim());
      if (toolNameMatch) {
        const tool = toolNameMatch[1]!;
        const input: Record<string, unknown> = {};
        const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
        let m: RegExpExecArray | null;
        while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
        if (tool) {
          calls.push({ tool, input });
          parsed = true;
        }
      }
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

        try {
          const obj = JSON.parse(body) as Record<string, unknown>;
          const { tool, ...input } = obj;
          if (typeof tool === 'string' && tool) {
            calls.push({ tool, input });
            parsed = true;
          }
        } catch { /* fall through */ }

        if (!parsed) {
          const toolNameMatch = /^([\w-]+)/.exec(body);
          if (toolNameMatch) {
            const tool = toolNameMatch[1]!;
            const input: Record<string, unknown> = {};
            const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
            let m: RegExpExecArray | null;
            while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
            if (tool) {
              calls.push({ tool, input });
              parsed = true;
            }
          }
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

After receiving a tool result, reason before acting again:

Thought: [what did I just learn? what does it mean for the task?]
Observation: [current state of the task based on everything so far]
Next: [what to do next and why — or "Task is complete" if done]

FILE WRITING — MANDATORY:
If your task involves creating or modifying a file (any filename with an extension, e.g. .ts .js .py .json):
1. Call write_file with the complete file content BEFORE writing your final answer
2. Your FINAL ANSWER must confirm what was written — it must NOT contain the file content itself
3. Never output source code inline as a substitute for calling write_file

PREFERRED FORMAT:
- Your Thought/Observation/Next blocks are INTERNAL REASONING ONLY
- They must NEVER appear in your final answer to the user
- Prefer writing a Thought block before each tool call (not required, but helps reasoning quality)
- When the task is complete, write your final answer using EXACTLY this format:

FINAL ANSWER:
[your complete response to the user here — no thought blocks, no reasoning, just the answer]

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
  // Strip only the ReAct header lines themselves (Thought: / Observation: / Next:).
  // Using the multiline flag (m) + line anchors so we never cross into the next
  // line — the dotall (s) flag was previously causing lazy .*? to consume the
  // entire rest of the string when no \n\n paragraph break was present, silently
  // wiping recipe-style responses that used single newlines throughout.
  return text
    .replace(/^(Thought|Observation|Next):.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    
    // Fix 1: Strip tools for pure generation tasks to prevent exploration
    function isPureGenerationTask(taskText: string): boolean {
      // If task expects file output, always provide tools
      const needsFiles = /write to|save|\bfile\b|\.[a-z]{2,4}(\s|$)|add to|implement in/i;
      if (needsFiles.test(taskText)) return false;

      // If task references existing content, provide tools for reading
      const explorationSignals = /existing|current|read|check|look at|find|my (code|file|project)/i;
      if (explorationSignals.test(taskText)) return false;

      // Pure generation — text output only, no files needed
      const generationSignals = /create|implement|write|build|add|generate/i;
      return generationSignals.test(taskText);
    }
    
    const shouldStripTools = false; // Tool discipline (3-call limit) handles overuse instead
    const availableTools = shouldStripTools ? [] : tools;
    
    if (shouldStripTools) {
      console.log(`[ReactAgent] Pure generation task detected — stripping tools to prevent exploration`);
    }
    
    // Build initial conversation history
    let conversationHistory = task.conversationHistory || [];
    
    // When the task involves writing a file, put a hard imperative first so
    // even models that skip the system prompt can't miss it.
    const needsFileWrite = /\.[a-z]{2,4}(\s|$)/i.test(task.intent);
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
      ...task.doneCriteria.map(c => `- ${c}`)
    ].join("\n");
    
    // Append ReAct system prompt block
    const fullSystemPrompt = `${this.systemPrompt}${REACT_PROMPT_BLOCK}`;
    
    // Initialize conversation with system prompt, prior turns, then the new task.
    let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: fullSystemPrompt },
      ...conversationHistory,
      { role: "user", content: taskContext }
    ];
    
    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        iterationCount = iteration + 1;
        
        // Call the model - use streaming if available and callback provided
        let response;
        const useStreaming = ctx.onStreamToken && this.llmAdapter.stream;
        
        if (useStreaming) {
          // Streaming call - tokens are emitted as they arrive
          response = await this.llmAdapter.stream!(
            {
              model: '', // empty → adapter uses its own defaultModel
              messages,
              maxTokens: this.maxTokens,
              temperature: this.temperature,
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
          });
        }
        
        const modelOutput = response.content;
        lastModelOutput = modelOutput;
        messages.push({ role: "assistant", content: modelOutput });
        
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

        // ── Parse-failure loop guard ──────────────────────────────────────────
        // If the model emitted <tool_call> blocks but none could be parsed,
        // inject a corrective message and track the failure. Three consecutive
        // iterations of this stops the run so it doesn't silently spin.
        const hasRawToolCallTag = modelOutput.includes('<tool_call>');
        if (hasRawToolCallTag && malformedCount > 0 && toolCalls.length === 0) {
          consecutiveParseFailures++;
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
        
        // Tool Use Discipline: Check if we've hit 3 tool calls without final answer
        if (cumulativeToolCallCount >= 3 && !toolLimitWarningInjected && !finalAnswerFound) {
          // Inject warning message - do NOT execute any more tools this iteration
          toolLimitWarningInjected = true;
          messages.push({ role: "user", content: "You have reached your 3-tool orientation limit. Do not call any more tools. Your next response must be your final answer." });
          continue; // Skip tool execution, wait for model's final answer next iteration
        }
        
        // If warning was already injected and this is the next iteration, extract output as final
        if (toolLimitWarningInjected && !finalAnswerFound) {
          // This is the iteration after warning injection - extract whatever we have as final answer
          currentOutputText = stripThoughtBlocks(cleanedOutput);
          stoppedBecause = 'done';
          break;
        }
        
        if (toolCalls.length === 0) {
          if (finalAnswer) {
            currentOutputText = finalAnswer;
            stoppedBecause = 'done';
            break;
          }

          // Only preserve non-empty text — don't overwrite a good draft with an empty response
          const extractedText = stripThoughtBlocks(cleanedOutput);
          if (extractedText.trim()) {
            currentOutputText = extractedText;
          }
          // Do not exit — continue to next iteration to allow model to retry
          // with proper formatting. Only exit on FINAL ANSWER or max_iterations.
          messages.push({ role: "user", content: "Your response was not properly formatted. Please use the FINAL ANSWER: marker for your final response, or use tool calls to complete the task." });
          continue;
        }
        
        // Execute tool calls
        for (const call of toolCalls) {
          // Fix 1 (continued): Block tool execution if tools were stripped for generation task
          if (shouldStripTools && availableTools.length === 0) {
            console.log(`[ReactAgent] BLOCKED: Tools stripped for pure generation task`);
            const errorResult = formatToolResult(call.tool, false, '', 'Tools unavailable for pure generation task — produce output directly');
            messages.push({ role: "user", content: errorResult });
            toolsUsed.push({
              tool: call.tool,
              ok: false,
              summary: `Tools stripped for pure generation task`,
              raw: call.input
            });
            continue;
          }
          
          // Find the tool in the provided tools array
          const tool = availableTools.find(t => t.name === call.tool);
          if (!tool) {
            // Unknown tool - add error result
            const errorResult = formatToolResult(call.tool, false, '', `Unknown tool: ${call.tool}`);
            messages.push({ role: "user", content: errorResult });
            toolsUsed.push({
              tool: call.tool,
              ok: false,
              summary: `Unknown tool: ${call.tool}`,
              raw: call.input
            });
            continue;
          }
          
          // Fix 2: write_file content validation guard
          if (call.tool === 'write_file' && typeof call.input.content !== 'string') {
            console.log(`[ReactAgent] BLOCKED: write_file requires "content" string parameter`);
            const errorResult = formatToolResult(call.tool, false, '', 'write_file requires a "content" string parameter');
            messages.push({ role: "user", content: errorResult });
            toolsUsed.push({
              tool: call.tool,
              ok: false,
              summary: `write_file: failed — requires "content" string parameter`,
              raw: call.input
            });
            continue;
          }
          
          // Execute the tool
          const toolContext = { workspaceRoot: process.cwd(), runId: ctx.runId };
          const result = await tool.execute(call.input, toolContext);
          
          // Tool Use Discipline: Increment cumulative counter
          cumulativeToolCallCount++;
          
          // Format tool result
          const toolResult = formatToolResult(call.tool, result.ok, result.output, result.error);
          messages.push({ role: "user", content: toolResult });
          
          // Record tool usage
          toolsUsed.push({
            tool: call.tool,
            ok: result.ok,
            summary: result.ok
              ? `${call.tool}: ok (${result.output.length} chars)`
              : `${call.tool}: failed — ${result.error ?? 'unknown'}`,
            raw: call.input
          });
          
          // Fix 3: Track file changes with content diff for Pappy verification
          if (result.ok && ['write_file', 'create_file', 'delete_file', 'modify_file'].includes(call.tool)) {
            const filePath = typeof call.input.path === 'string' ? call.input.path : '';
            if (filePath) {
              const content = typeof call.input.content === 'string' ? call.input.content : undefined;
              const diff = content ? content.slice(0, 2000) : undefined; // Truncate for storage
              filesChanged.push({
                path: filePath,
                changeType: call.tool === 'delete_file' ? 'D' : call.tool === 'create_file' ? 'A' : 'M',
                diff
              });
            }
          }
          
          // === LOOP DETECTION CHECKS ===
          
          // Record this tool call in history for loop detection
          const callSig = `${call.tool}:${JSON.stringify(call.input)}`;
          callHistory.push(callSig);

          // Check 1: Empty/error result loop
          if (!result.ok || !result.output || result.output.trim() === '' || result.output.startsWith('Error')) {
            consecutiveEmptyResults++;
            if (consecutiveEmptyResults >= this.EMPTY_RESULT_LIMIT) {
              console.warn(`[ReactAgent] Empty/error result loop: ${consecutiveEmptyResults} consecutive failures`);
              stoppedBecause = 'loop_detected';
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: `${call.tool} returning empty/error`,
                occurrences: consecutiveEmptyResults
              };
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
      
      const cleanedLastOutput = stripToolCalls(lastModelOutput);
      // Prefer accumulated output (set on each iteration) over a fresh strip of
      // the last response — if stripping left nothing, fall back to the raw
      // tool-stripped output so the user always sees something rather than an
      // empty string that bubbles up as "did not complete as expected".
      const finalOutput = currentOutputText || cleanedLastOutput.trim();
      
      // ── No-final-output detection ─────────────────────────────────────────
      // If the run ended without a FINAL ANSWER: and the derived output is empty
      // (or only whitespace), surface this explicitly. Callers and Pappy need to
      // know the run produced no deliverable even though tools may have fired.
      const effectiveOutput = finalOutput.trim();
      // Graceful fallback: a model that skipped the FINAL ANSWER: marker but produced
      // real text is still done — don't penalise it with max_iterations.
      if (effectiveOutput && stoppedBecause === 'max_iterations') {
        stoppedBecause = 'done';
      }
      if (!finalAnswerFound && effectiveOutput.length === 0 && stoppedBecause === 'max_iterations') {
        stoppedBecause = 'no_final_output';
        console.warn(
          `[ReactAgent] no_final_output: run completed ${iterationCount} iteration(s) ` +
          `with ${toolsUsed.length} tool event(s) but produced no FINAL ANSWER.`
        );
      }
      
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
      stoppedBecause = 'error';
      error = err instanceof Error ? err.message : String(err);
      
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