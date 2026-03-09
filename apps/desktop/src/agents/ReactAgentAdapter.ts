import type { LLMAdapter } from "@clawde/miranda-core";
import type { OrcaRunCtx, OrcaToolService } from "@clawde/orca-core";
import type { AgentAdapter, AgentTask, AgentResult, ThoughtRecord } from "./AgentAdapter";
import type { RoleName } from "maestro-core";

// Type definitions that should be imported from existing files
type Tool = { name: string; description: string; execute: (input: Record<string, unknown>, context: any) => Promise<{ ok: boolean; output: string; error?: string }> };
type ToolEvent = { tool: string; ok: boolean; summary: string; raw?: unknown };
type FileChange = { path: string; changeType: "A" | "M" | "D"; diff?: string };

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseToolCalls(text: string): Array<{ tool: string; input: Record<string, unknown> }> {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  // Strict: closed <tool_call>...<tool_call>
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      const { tool, ...input } = parsed;
      if (typeof tool === 'string' && tool) calls.push({ tool, input });
    } catch {
      // XML-attribute style: TOOLNAME<arg_key>k</arg_key><arg_value>v</arg_value>
      const body = match[1]!;
      const toolNameMatch = /^([\w-]+)/.exec(body.trim());
      if (toolNameMatch) {
        const tool = toolNameMatch[1]!;
        const input: Record<string, unknown> = {};
        const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
        let m: RegExpExecArray | null;
        while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
        if (tool) calls.push({ tool, input });
      }
    }
  }
  // Lenient: unclosed <tool_call> at end of text (some models omit the closing tag)
  if (calls.length === 0) {
    const openTag = '<tool_call>';
    const idx = text.lastIndexOf(openTag);
    if (idx !== -1) {
      const body = text.slice(idx + openTag.length).replace(/<\/tool_call>[\s\S]*$/, '').trim();
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const { tool, ...input } = parsed;
        if (typeof tool === 'string' && tool) calls.push({ tool, input });
      } catch {
        // XML-attribute style fallback
        const toolNameMatch = /^([\w-]+)/.exec(body);
        if (toolNameMatch) {
          const tool = toolNameMatch[1]!;
          const input: Record<string, unknown> = {};
          const argRe = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([^<]*)<\/arg_value>/g;
          let m: RegExpExecArray | null;
          while ((m = argRe.exec(body)) !== null) input[m[1]!] = m[2]!;
          if (tool) calls.push({ tool, input });
        }
      }
    }
  }
  return calls;
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

CRITICAL RULES:
- Your Thought/Observation/Next blocks are INTERNAL REASONING ONLY
- They must NEVER appear in your final answer to the user
- Never call a tool without a preceding Thought block
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
  return text
    .replace(/Thought:.*?(?=\n\n|\nObservation:|\nNext:|\nFINAL ANSWER:|$)/gs, '')
    .replace(/Observation:.*?(?=\n\n|\nThought:|\nNext:|\nFINAL ANSWER:|$)/gs, '')
    .replace(/Next:.*?(?=\n\n|\nThought:|\nObservation:|\nFINAL ANSWER:|$)/gs, '')
    .trim();
}

export class ReactAgentAdapter implements AgentAdapter {
  readonly role: RoleName;
  private llmAdapter: LLMAdapter;
  private systemPrompt: string;
  private maxIterations: number;
  
  // Loop detection constants
  private readonly LOOP_WINDOW = 3;        // consecutive identical calls = loop
  private readonly THRASH_WINDOW = 6;      // alternating pattern window
  private readonly EMPTY_RESULT_LIMIT = 3; // consecutive empty/error results = loop

  constructor(
    llmAdapter: LLMAdapter,
    systemPrompt: string,
    role: RoleName,
    maxIterations: number = 10
  ) {
    this.llmAdapter = llmAdapter;
    this.systemPrompt = systemPrompt;
    this.role = role;
    this.maxIterations = maxIterations;
  }

  async run(task: AgentTask, tools: Tool[], ctx: OrcaRunCtx): Promise<AgentResult> {
    const thoughts: ThoughtRecord[] = [];
    const toolsUsed: ToolEvent[] = [];
    const filesChanged: FileChange[] = [];
    let iterationCount = 0;
    let currentOutputText = '';
    let lastModelOutput = '';
    let stoppedBecause: 'done' | 'max_iterations' | 'loop_detected' | 'error' = 'max_iterations';
    let error: string | undefined;
    
    // Loop detection state
    const callHistory: string[] = [];
    let consecutiveEmptyResults = 0;
    let loopEvidence: { iteration: number; repeatedCall: string; occurrences: number } | undefined;
    
    // Build initial conversation history
    let conversationHistory = task.conversationHistory || [];
    
    // Add system prompt and task context
    const taskContext = [
      `## Task Intent`,
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
    let messages = [
      { role: "system", content: fullSystemPrompt },
      ...conversationHistory,
      { role: "user", content: taskContext }
    ];
    
    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        iterationCount = iteration + 1;
        
        // Call the model
        const response = await this.llmAdapter.complete({
          messages,
          maxTokens: 4096,
          temperature: 0.7
        });
        
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
        const toolCalls = parseToolCalls(modelOutput);
        
        if (toolCalls.length === 0) {
          const cleanedOutput = stripToolCalls(modelOutput);
          const finalAnswer = extractFinalAnswer(cleanedOutput);

          if (finalAnswer) {
            currentOutputText = finalAnswer;
            stoppedBecause = 'done';
            break;
          }

          currentOutputText = stripThoughtBlocks(cleanedOutput);
          stoppedBecause = 'done';
          break;
        }
        
        // Execute tool calls
        for (const call of toolCalls) {
          // Find the tool in the provided tools array
          const tool = tools.find(t => t.name === call.tool);
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
          
          // Execute the tool
          const toolContext = { workspaceRoot: process.cwd(), runId: ctx.runId };
          const result = await tool.execute(call.input, toolContext);
          
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
          
          // Track file changes (this would need to be enhanced based on actual tool implementations)
          if (result.ok && ['write_file', 'create_file', 'delete_file', 'modify_file'].includes(call.tool)) {
            const filePath = typeof call.input.path === 'string' ? call.input.path : '';
            if (filePath) {
              filesChanged.push({
                path: filePath,
                changeType: call.tool === 'delete_file' ? 'D' : call.tool === 'create_file' ? 'A' : 'M'
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
      const finalOutput = currentOutputText || stripThoughtBlocks(cleanedLastOutput);
      
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