import type { LLMAdapter, LLMMessage, LLMRequest } from "@clawde/miranda-core";
import {
  extractFilesChangedFromCommandOutput,
  type AHPPacket,
  type OrcaLLMService,
  type OrcaRunCtx,
  type OrcaToolService,
} from "@clawde/orca-core";
import { formatToolResult as sharedFormatToolResult, runAgentLoop } from "@clawde/agent-loop-core";
import type { AgentAdapter, AgentTask, AgentResult, ThoughtRecord, AgentRunContext } from "./AgentAdapter";
import type { RoleName } from "maestro-core";

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

const OPEN_TOOL_CALL_TAG = "<tool_call>";
const PROMPT_SEPARATOR = "\n\n---\n\n";

function normalizeFileMutationToolName(toolName: string): string {
  return toolName.startsWith("desktop-commander_")
    ? toolName.slice("desktop-commander_".length)
    : toolName;
}

function isWriteToolName(toolName: string): boolean {
  return normalizeFileMutationToolName(toolName) === "write_file";
}

function fileChangeTypeForTool(toolName: string): FileChange["changeType"] | undefined {
  switch (normalizeFileMutationToolName(toolName)) {
    case "create_file":
      return "A";
    case "delete_file":
      return "D";
    case "write_file":
    case "modify_file":
    case "edit_block":
      return "M";
    default:
      return undefined;
  }
}

function recordFileChange(filesChanged: FileChange[], next: FileChange): void {
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

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
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

// Maps known tool names → their positional parameter names, in order.
// Used to parse function-call-syntax tool invocations that models sometimes
// emit inside markdown code blocks instead of <tool_call> XML.
const TOOL_POSITIONAL_PARAMS: Readonly<Record<string, string[]>> = {
  write_file:     ["path", "content"],
  "desktop-commander_write_file": ["path", "content"],
  read_file:      ["path"],
  list_directory: ["path"],
  run_command:    ["command"],
  search_files:   ["query", "path"],
  delete_file:    ["path"],
  move_file:      ["source", "destination"],
  copy_file:      ["source", "destination"],
};

/**
 * Parse Python/JS-style function call syntax: `toolName("arg1", "arg2")`.
 * Returns null when the tool is unknown or args cannot be unambiguously parsed.
 */
function parseFunctionCallSyntax(text: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const fnMatch = /^([\w-]+)\s*\(/.exec(trimmed);
  if (!fnMatch) return null;
  const tool = fnMatch[1]!;
  const paramNames = TOOL_POSITIONAL_PARAMS[tool];
  if (!paramNames) return null;

  const parenStart = trimmed.indexOf("(");
  const parenEnd = trimmed.lastIndexOf(")");
  if (parenStart === -1 || parenEnd <= parenStart) return null;

  const argsStr = trimmed.slice(parenStart + 1, parenEnd).trim();
  if (!argsStr) return { tool, input: {} };

  // Split on top-level commas, respecting string literals and nested parens.
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let strChar = "";
  let escaped = false;
  let current = "";
  for (const ch of argsStr) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && inStr) { escaped = true; current += ch; continue; }
    if (!inStr && (ch === '"' || ch === "'")) { inStr = true; strChar = ch; current += ch; continue; }
    if (inStr && ch === strChar) { inStr = false; current += ch; continue; }
    if (!inStr && ch === "(") { depth++; current += ch; continue; }
    if (!inStr && ch === ")") { depth--; current += ch; continue; }
    if (!inStr && ch === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());

  function unquoteArg(s: string): string {
    const t = s.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      try {
        return JSON.parse('"' + t.slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'") + '"') as string;
      } catch {
        return t.slice(1, -1).replace(/\\'/g, "'");
      }
    }
    return t;
  }

  const input: Record<string, unknown> = {};
  args.forEach((arg, idx) => {
    const name = paramNames[idx] ?? `arg${idx + 1}`;
    input[name] = unquoteArg(arg);
  });
  return { tool, input };
}

/**
 * Scan markdown fenced code blocks and attempt to extract tool calls from
 * their contents. Handles both JSON-format (`{"tool":"name",...}`) and
 * function-call-format (`write_file("path","content")`).
 * Called as a last-resort fallback when no <tool_call> blocks are present.
 */
function parseCodeBlockToolCalls(
  text: string,
): Array<{ tool: string; input: Record<string, unknown> }> {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const codeBlockRe = /(?:```|~~~)[\w]*[ \t]*\n([\s\S]*?)(?:```|~~~)/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRe.exec(text)) !== null) {
    const body = match[1]!.trim();
    if (!body || body.length < 3) continue;
    // Try JSON-format first: {"tool": "name", ...}
    const jsonCall = parseToolCallBody(body);
    if (jsonCall) { calls.push(jsonCall); continue; }
    // Try function-call-format: toolName("arg1", "arg2")
    const fnCall = parseFunctionCallSyntax(body);
    if (fnCall) calls.push(fnCall);
  }
  return calls;
}

function parseToolCalls(text: string): {
  calls: Array<{ tool: string; input: Record<string, unknown> }>;
  malformedCount: number;
} {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let malformedCount = 0;

  const strictBlockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = strictBlockRe.exec(text)) !== null) {
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
        `[ReactAgent] Malformed tool block - all parse strategies failed.\n` +
        `  Block content (first 200 chars): ${body.slice(0, 200).replace(/\n/g, "\\n")}`,
      );
    }
  }

  if (calls.length === 0) {
    const idx = text.lastIndexOf(OPEN_TOOL_CALL_TAG);
    if (idx !== -1) {
      const body = text.slice(idx + OPEN_TOOL_CALL_TAG.length)
        .replace(/<\/tool_call>[\s\S]*$/, "")
        .trim();

      if (body.length > 5) {
        let parsed = false;

        const call = parseToolCallBody(body);
        if (call) {
          calls.push(call);
          parsed = true;
        }

        if (!parsed) {
          malformedCount++;
          console.warn(
            `[ReactAgent] Malformed unclosed tool block at end of response.\n` +
            `  Fragment (first 200 chars): ${body.slice(0, 200).replace(/\n/g, "\\n")}`,
          );
        }
      }
    }
  }

  // Fallback: if no <tool_call> tags were found at all, scan for tool calls
  // wrapped in markdown code fences. Some models emit tool calls as code
  // blocks instead of the required XML format — we recover silently here so
  // the run still makes progress rather than burning all iterations retrying.
  if (calls.length === 0 && malformedCount === 0) {
    const codeBlockCalls = parseCodeBlockToolCalls(text);
    if (codeBlockCalls.length > 0) {
      console.log(
        `[ReactAgent] Recovered ${codeBlockCalls.length} tool call(s) from markdown code block(s). ` +
        `Model should use <tool_call>{"tool":"NAME",...}</tool_call> format instead.`,
      );
      calls.push(...codeBlockCalls);
    }
  }

  return { calls, malformedCount };
}

const REACT_PROMPT_BLOCK = `

EXECUTION MODEL - READ THIS FIRST:
1. Call a tool. Wait for the result.
2. Reason about what you learned (Thought/Observation/Next).
3. Call another tool if needed. Repeat until you have everything required.
4. Only write FINAL ANSWER: when ALL required work is done (files read, files written if asked).

CRITICAL: You MUST call at least one tool before writing FINAL ANSWER: whenever your task involves reading files, analyzing a repo, or saving output. "I think I should look at..." is NOT a tool call - make the actual call.

After receiving a tool result, reason before acting again:

Thought: [what did I just learn? what does it mean for the task?]
Observation: [current state of the task based on everything so far]
Next: [what to do next and why - or "Task is complete" if done]

FILE WRITING - MANDATORY:
If your task involves creating or modifying a file (any filename with an extension, e.g. .ts .js .py .json .md):
1. Call write_file with the complete file content BEFORE writing your final answer
2. Your FINAL ANSWER must confirm what was written - it must NOT contain the file content itself
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
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*$/g, "")
    .trim();
}

function extractFinalAnswer(rawText: string): string | null {
  const marker = "FINAL ANSWER:";
  const idx = rawText.indexOf(marker);
  if (idx !== -1) {
    return rawText.slice(idx + marker.length).trim();
  }
  return null;
}

function stripThoughtBlocks(text: string): string {
  let result = text.replace(
    /^(Thought|Observation|Next):\s*[\s\S]*?(?=\n(?:Thought|Observation|Next|FINAL ANSWER):|\n\n|$)/gim,
    "",
  );
  result = result.replace(/^(Thought|Observation|Next):.*$/gm, "");
  result = result.replace(/^(Good[,.] I can see|I can see|I'll start|I want to make sure|I need to:?|Now I'll|Now I need|Now let me|Let me continue|Let me explore|OK[,.]|Alright[,.])\b.*$/gmi, "");
  result = result.replace(/^\s*\d+\.\s+(The |Check |Look |Read |Verify |Examine |Inspect |Review |Analyze |Search |Find |Any ).*$/gmi, "");
  result = result.replace(/[.]\s*(?:Now\s+)?[Ll]et me (?:also\s+|just\s+|quickly\s+|then\s+|now\s+|go ahead and\s+)?(?:think|check|look|see|read|search|verify|review|examine|analyze|inspect|investigate|find|determine|try|continue|explore|understand)[^.!?\n]*[.!?]?/gi, ".");
  result = result.replace(/[.]\s*I (?:should|need to|want to|'ll|will) (?:check|look|read|verify|examine|inspect|review|analyze|search|find|explore|investigate|continue|start|begin|make sure|understand)[^.!?\n]*[.!?]?/g, ".");
  return result
    .replace(/\n{3,}/g, "\n\n")
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

function buildSharedToolPrompt(tools: Tool[]): string {
  const toolSchemaLines = tools.flatMap((tool) => {
    const params = tool.schema?.properties
      ? Object.entries(tool.schema.properties as Record<string, { type?: string; description?: string }>)
          .map(([k, v]) => `  - ${k} (${v.type ?? "string"}): ${v.description ?? ""}`)
          .join("\n")
      : "";
    return params
      ? [`- ${tool.name}: ${tool.description}\n${params}`]
      : [`- ${tool.name}: ${tool.description}`];
  });

  return tools.length > 0
    ? [
        "## Available Tools",
        ...toolSchemaLines,
        "",
        "### Tool Call Format",
        "To invoke a tool you MUST use this exact XML format - never output tool names as plain text:",
        "",
        '<tool_call>{"tool": "TOOL_NAME", "PARAM1": "VALUE1", "PARAM2": "VALUE2"}</tool_call>',
        'Do not write tool_name{"param":"value"} or put the tool name outside the JSON object.',
        "",
        "Only ONE tool_call per response. Wait for the result before calling the next tool.",
      ].join("\n")
    : "## Available Tools\nNo tools are available for this task. Work from the provided context only.";
}

type TaskPromptContract = {
  intent: string;
  goals: string[];
  doneCriteria: string[];
  constraints: string[];
  repairDirective?: string;
  promptSource: "agent_task" | "ahp_packet";
  packetId?: string;
};

function stringifyPromptValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifyPromptValue(entry))
      .filter((entry) => entry.length > 0)
      .join(", ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function buildTaskPromptContract(task: AgentTask, packet?: AHPPacket): TaskPromptContract {
  if (!packet) {
    return {
      intent: task.intent,
      goals: task.goals,
      doneCriteria: task.doneCriteria,
      constraints: [],
      promptSource: "agent_task",
    };
  }

  const repairDirective = uniqueNonEmpty(
    packet.inputs
      .filter((input) => input.type === "repair_directive")
      .map((input) => stringifyPromptValue(input.value)),
  ).join("\n\n");
  const objective = packet.objective.trim();
  const goals = uniqueNonEmpty(
    packet.inputs
      .filter((input) => input.type !== "repair_directive")
      .map((input) => stringifyPromptValue(input.value))
      .filter((value) => value && value !== objective),
  );
  const constraints = uniqueNonEmpty(
    packet.constraints.map((constraint) =>
      constraint.enforcer && constraint.enforcer !== constraint.rule
        ? `${constraint.rule} (${constraint.enforcer})`
        : constraint.rule,
    ),
  );

  return {
    intent: objective || task.intent,
    goals: goals.length > 0 ? goals : task.goals,
    doneCriteria: [...packet.expectedOutput.acceptanceCriteria],
    constraints,
    repairDirective: repairDirective || undefined,
    promptSource: "ahp_packet",
    packetId: packet.id,
  };
}

function renderTaskPrompt(
  role: RoleName,
  contract: TaskPromptContract,
  toolPrompt: string,
  fileWriteDirective: string,
): string {
  if (contract.promptSource === "ahp_packet") {
    const lines: string[] = [
      `${fileWriteDirective}## AHP Packet Assignment`,
      `Role: **${role}**`,
    ];

    if (contract.packetId) {
      lines.push(`Packet: ${contract.packetId}`);
    }

    lines.push("", "### Objective", contract.intent);

    if (contract.goals.length > 0) {
      lines.push("", "### Inputs", ...contract.goals.map((goal) => `- ${goal}`));
    }

    if (contract.constraints.length > 0) {
      lines.push("", "### Constraints", ...contract.constraints.map((constraint) => `- ${constraint}`));
    }

    if (contract.repairDirective) {
      lines.push("", "### Repair Directive", contract.repairDirective);
    }

    if (contract.doneCriteria.length > 0) {
      lines.push("", "### Acceptance Criteria", ...contract.doneCriteria.map((criterion) => `- ${criterion}`));
    }

    lines.push("", toolPrompt);
    return lines.join("\n");
  }

  const lines: string[] = [
    `${fileWriteDirective}## Task Intent`,
    contract.intent,
    "",
    "## Goals",
    ...contract.goals.map((goal) => `- ${goal}`),
  ];

  if (contract.doneCriteria.length > 0) {
    lines.push("", "## Done Criteria", ...contract.doneCriteria.map((criterion) => `- ${criterion}`));
  }

  lines.push("", toolPrompt);
  return lines.join("\n");
}

function toSharedLLMService(
  adapter: LLMAdapter,
  defaults: { maxTokens: number; temperature: number },
): OrcaLLMService {
  function buildRequest(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; enableThinking?: boolean; abortSignal?: AbortSignal },
  ): LLMRequest {
    const sepIdx = prompt.indexOf(PROMPT_SEPARATOR);
    const messages: LLMMessage[] = sepIdx !== -1
      ? [
          { role: "system", content: prompt.slice(0, sepIdx) },
          { role: "user", content: prompt.slice(sepIdx + PROMPT_SEPARATOR.length) },
        ]
      : [{ role: "user", content: prompt }];

    return {
      model: "",
      messages,
      temperature: opts?.temperature ?? defaults.temperature,
      maxTokens: opts?.maxTokens ?? defaults.maxTokens,
      signal: opts?.abortSignal,
      ...(opts?.enableThinking !== undefined && { enableThinking: opts.enableThinking }),
    };
  }

  return {
    async complete(prompt, opts) {
      const request = buildRequest(prompt, opts);
      if (opts?.onToken && adapter.stream) {
        const response = await adapter.stream(request, opts.onToken);
        return { text: response.content };
      }
      const response = await adapter.complete(request);
      return { text: response.content };
    },

    async stream(prompt, options, onChunk) {
      const request = buildRequest(prompt, options);
      if (adapter.stream) {
        const response = await adapter.stream(request, onChunk);
        return { text: response.content };
      }
      const response = await adapter.complete(request);
      onChunk(response.content);
      return { text: response.content };
    },
  };
}

function toSharedToolService(tools: Tool[], ctx: AgentRunContext): OrcaToolService {
  const service: OrcaToolService & {
    getSchema(name: string): Tool["schema"] | undefined;
  } = {
    execute(name: string, input: Record<string, unknown>) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return Promise.resolve({
          ok: false,
          output: "",
          error: `Unknown tool: ${name}`,
        });
      }
      return tool.execute(input, {
        workspaceRoot: ctx.workspaceRoot ?? process.cwd(),
        runId: ctx.runId,
        abortSignal: ctx.abortSignal,
        requestApproval: ctx.requestToolApproval
          ? (toolName: string, args: Record<string, unknown>, _reason: string) =>
              ctx.requestToolApproval!(toolName, args)
          : undefined,
      });
    },

    formatForPrompt() {
      return buildSharedToolPrompt(tools);
    },

    getSchema(name: string) {
      return tools.find((tool) => tool.name === name)?.schema;
    },
  };

  return service;
}

function toSharedRunCtx(
  ctx: AgentRunContext,
  llm: OrcaLLMService,
  tools: OrcaToolService,
): OrcaRunCtx {
  return {
    llm,
    runId: ctx.runId,
    abortSignal: ctx.abortSignal,
    recordTrace: ctx.recordTrace,
    tools,
    toolNamesAllowed: ctx.toolNamesAllowed,
    emit: ctx.emit,
    subagentDepth: ctx.subagentDepth,
    workspaceContext: ctx.workspaceContext,
    gate: ctx.gate,
    ahpRootPacket: ctx.ahpRootPacket,
    ahpPacket: ctx.ahpPacket,
    workspaceRoot: ctx.workspaceRoot,
  };
}

export class ReactAgentAdapter implements AgentAdapter {
  readonly role: RoleName;
  private llmAdapter: LLMAdapter;
  private systemPrompt: string;
  private maxIterations: number;
  private maxTokens: number;
  private temperature: number;

  private readonly LOOP_WINDOW = 3;
  private readonly THRASH_WINDOW = 6;
  private readonly EMPTY_RESULT_LIMIT = 3;
  private readonly PARSE_FAILURE_LIMIT = 3;

  constructor(
    llmAdapter: LLMAdapter,
    systemPrompt: string,
    role: RoleName,
    maxIterations: number = 10,
    maxTokens: number = 8192,
    temperature: number = 0.7,
  ) {
    this.llmAdapter = llmAdapter;
    this.systemPrompt = systemPrompt;
    this.role = role;
    this.maxIterations = maxIterations;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  private async runSharedLoopFallback(task: AgentTask, tools: Tool[], ctx: AgentRunContext): Promise<AgentResult> {
    const toolService = toSharedToolService(tools, ctx);
    const llmService = toSharedLLMService(this.llmAdapter, {
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    });
    const sharedCtx = toSharedRunCtx(ctx, llmService, toolService);
    const contract = buildTaskPromptContract(task, ctx.ahpPacket);
    const needsFileWrite = taskExplicitlyRequestsFileSave(
      `${contract.intent} ${contract.goals.join(" ")} ${contract.doneCriteria.join(" ")}`,
    );
    const taskPrompt = renderTaskPrompt(
      this.role,
      contract,
      buildSharedToolPrompt(tools),
      needsFileWrite
        ? "**ACTION REQUIRED: Call write_file to save the file content to disk. Do NOT output the file content inline - use the tool.**\n\n"
        : "",
    );
    const result = await runAgentLoop(this.systemPrompt, taskPrompt, toolService, sharedCtx, contract.doneCriteria);
    return {
      outputText: result.text,
      thoughts: [],
      toolsUsed: result.toolEvents,
      filesChanged: result.filesChanged,
      iterationCount: 0,
      stoppedBecause: "done",
    };
  }

  async run(task: AgentTask, tools: Tool[], ctx: AgentRunContext): Promise<AgentResult> {
    const thoughts: ThoughtRecord[] = [];
    const toolsUsed: ToolEvent[] = [];
    const filesChanged: FileChange[] = [];
    let iterationCount = 0;
    let currentOutputText = "";
    let lastModelOutput = "";
    let stoppedBecause: "done" | "max_iterations" | "loop_detected" | "parse_failure_loop" | "no_final_output" | "error" = "max_iterations";
    let error: string | undefined;

    const callHistory: string[] = [];
    let consecutiveEmptyResults = 0;
    let consecutiveParseFailures = 0;
    let loopEvidence: { iteration: number; repeatedCall: string; occurrences: number } | undefined;

    let cumulativeToolCallCount = 0;
    let toolLimitWarningInjected = false;
    let finalAnswerFound = false;
    let lastRejectedFinalAnswer = "";

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
          "To invoke a tool you MUST use this exact XML format - never output tool names as plain text:",
          "",
          '<tool_call>{"tool": "TOOL_NAME", "PARAM1": "VALUE1", "PARAM2": "VALUE2"}</tool_call>',
          'Do not write tool_name{"param":"value"} or put the tool name outside the JSON object.',
          "",
          "Example - run a shell command:",
          '<tool_call>{"tool": "run_command", "command": "ls -la"}</tool_call>',
          "",
          "Example - read a file:",
          '<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>',
          "",
          "Only ONE tool_call per response. Wait for the result before calling the next tool.",
        ].join("\n")
      : "## Available Tools\nNo tools are available for this task. Work from the provided context only.";

    const conversationHistory = task.conversationHistory || [];
    const contract = buildTaskPromptContract(task, ctx.ahpPacket);
    const intentAndGoals = `${contract.intent} ${contract.goals.join(" ")} ${contract.doneCriteria.join(" ")}`;
    const needsFileWrite = taskExplicitlyRequestsFileSave(intentAndGoals);
    const fileWriteDirective = needsFileWrite
      ? "**ACTION REQUIRED: Call write_file to save the file content to disk. Do NOT output the file content inline - use the tool.**\n\n"
      : "";
    const taskContext = renderTaskPrompt(this.role, contract, toolPrompt, fileWriteDirective);

    const fullSystemPrompt = `${this.systemPrompt}${REACT_PROMPT_BLOCK}`;

    let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: fullSystemPrompt },
      ...conversationHistory,
      { role: "user", content: taskContext },
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
      promptSource: contract.promptSource,
      packetId: contract.packetId,
      systemPrompt: fullSystemPrompt,
      taskContext,
    });

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        throwIfAborted(ctx.abortSignal);
        iterationCount = iteration + 1;

        if (iteration > 0) {
          ctx.onStreamReset?.();
        }

        let response;
        const useStreaming = ctx.onStreamToken && this.llmAdapter.stream;
        ctx.recordTrace?.("agent.iteration.request", {
          role: this.role,
          iteration: iterationCount,
          useStreaming: !!useStreaming,
          messages,
        });

        if (useStreaming) {
          response = await this.llmAdapter.stream!(
            {
              model: "",
              messages,
              maxTokens: this.maxTokens,
              temperature: this.temperature,
              signal: ctx.abortSignal,
            },
            ctx.onStreamToken!,
          );
        } else {
          response = await this.llmAdapter.complete({
            model: "",
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

        const thoughtMatch = modelOutput.match(/Thought:\s*([\s\S]*?)(?:\n|$)/i);
        const observationMatch = modelOutput.match(/Observation:\s*([\s\S]*?)(?:\n|$)/i);
        const nextMatch = modelOutput.match(/Next:\s*([\s\S]*?)(?:\n|$)/i);

        const thought = thoughtMatch ? thoughtMatch[1].trim() : "";
        const observation = observationMatch ? observationMatch[1].trim() : "";
        const next = nextMatch ? nextMatch[1].trim() : "";

        if (thought || observation || next) {
          const thoughtRecord: ThoughtRecord = {
            iteration: iterationCount,
            thought,
            observation,
            next,
          };
          thoughts.push(thoughtRecord);
          ctx.recordTrace?.("agent.iteration.thought", {
            role: this.role,
            iteration: iterationCount,
            thoughtRecord,
          });

          if (ctx.emit) {
            ctx.emit({
              type: "maestro:thought",
              taskId: ctx.runId,
              iteration: iterationCount,
              thought,
              observation,
              next,
            });
          }
        } else {
          console.log(`[ReactAgent] No Thought block found in iteration ${iterationCount} - model may have skipped format`);
        }

        const { calls: toolCalls, malformedCount } = parseToolCalls(modelOutput);
        ctx.recordTrace?.("agent.iteration.tool_parse", {
          role: this.role,
          iteration: iterationCount,
          malformedCount,
          toolCalls,
        });

        const hasRawToolCallTag = modelOutput.includes("<tool_call>");
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
            `(limit=${this.PARSE_FAILURE_LIMIT})`,
          );
          messages.push({
            role: "user",
            content:
              'Your tool call was not properly formatted and could not be parsed.\n' +
              'Tool calls MUST be valid JSON inside <tool_call>...</tool_call> tags with a "tool" key, e.g.:\n' +
              '<tool_call>{"tool": "read_file", "path": "src/index.ts"}</tool_call>\n' +
              'Please retry with a correctly formatted tool call, or write your FINAL ANSWER: if done.',
          });
          if (consecutiveParseFailures >= this.PARSE_FAILURE_LIMIT) {
            console.warn(
              `[ReactAgent] parse_failure_loop: ${consecutiveParseFailures} consecutive malformed ` +
              `tool blocks - stopping run.`,
            );
            stoppedBecause = "parse_failure_loop";
            loopEvidence = {
              iteration: iterationCount,
              repeatedCall: "malformed <tool_call> block",
              occurrences: consecutiveParseFailures,
            };
            ctx.recordTrace?.("agent.loop_detected", {
              role: this.role,
              iteration: iterationCount,
              stoppedBecause,
              loopEvidence,
            });
            break;
          }
          continue;
        } else if (!hasRawToolCallTag || toolCalls.length > 0) {
          consecutiveParseFailures = 0;
        }

        const cleanedOutput = stripToolCalls(modelOutput);
        const finalAnswer = extractFinalAnswer(cleanedOutput);
        if (finalAnswer) {
          finalAnswerFound = true;
        }

        const iterationsRemaining = this.maxIterations - iteration - 1;
        if (iterationsRemaining === 2 && iteration >= 1 && !toolLimitWarningInjected && !finalAnswerFound) {
          toolLimitWarningInjected = true;
          const allTaskTextForWarn = `${contract.intent} ${contract.goals.join(" ")} ${contract.doneCriteria.join(" ")}`;
          const taskImpliesFileSaveForWarn = taskExplicitlyRequestsFileSave(allTaskTextForWarn);
          const writeFileCalledForWarn = toolsUsed.some((e) => isWriteToolName(e.tool));
          const writeFileReminder = taskImpliesFileSaveForWarn && !writeFileCalledForWarn
            ? "\n\nCRITICAL: Your task requires saving a file. You MUST call write_file with the complete file content in your NEXT response - before writing your final answer."
            : "";
          messages.push({
            role: "user",
            content: `You have 2 turns remaining.${writeFileReminder}\nAfter any required tool call (e.g. write_file), your next response MUST be your FINAL ANSWER using the FINAL ANSWER: marker.`,
          });
          continue;
        }

        if (toolCalls.length === 0) {
          if (finalAnswer) {
            const allTaskText = `${contract.intent} ${contract.goals.join(" ")}`;
            const taskImpliesToolUse = (
              /\b(analyz|investigat|examin|read|list|search|find|save|write|creat)\w*/i.test(allTaskText) ||
              /\b\w+\.\w{2,5}\b/.test(allTaskText)
            );
            if (taskImpliesToolUse && cumulativeToolCallCount === 0) {
              messages.push({
                role: "user",
                content:
                  "Your task requires you to investigate files and/or write output to disk, but you have not called any tools yet. " +
                  "Do NOT write a final answer until you have:\n" +
                  "1. Used read_file or list_directory to examine the relevant files\n" +
                  "2. Called write_file if the task asks you to save a file\n\n" +
                  "Start by calling a tool now. Do not describe what you plan to do - make the actual tool call.",
              });
              continue;
            }
            const taskImpliesFileSave = taskExplicitlyRequestsFileSave(allTaskText);
            const writeFileCalled = toolsUsed.some((e) => isWriteToolName(e.tool));
            if (taskImpliesFileSave && !writeFileCalled) {
              lastRejectedFinalAnswer = finalAnswer;
              messages.push({
                role: "user",
                content:
                  "Your task explicitly asks you to save a file, but you have not called write_file yet. " +
                  "You MUST call write_file with the complete file content before writing your FINAL ANSWER. " +
                  "Call write_file now.",
              });
              continue;
            }
            currentOutputText = finalAnswer;
            stoppedBecause = "done";
            ctx.recordTrace?.("agent.final_answer", {
              role: this.role,
              iteration: iterationCount,
              outputText: currentOutputText,
            });
            break;
          }

          const extractedText = stripThoughtBlocks(cleanedOutput);
          const trimmed = extractedText.trim();
          const looksLikePureThinking = trimmed.length < 500
            && !/\n/.test(trimmed)
            && /^(Good|OK|Alright|Let me|I('ll| will| need| want| should)|Now |First)/im.test(trimmed);
          const isSubstantive = trimmed.length > 0 && !looksLikePureThinking;
          if (isSubstantive && trimmed.length > currentOutputText.trim().length) {
            currentOutputText = extractedText;
          }
          messages.push({ role: "user", content: "Your response was not properly formatted. Please use the FINAL ANSWER: marker for your final response, or use tool calls to complete the task." });
          continue;
        }

        for (const call of toolCalls) {
          throwIfAborted(ctx.abortSignal);
          const resolvedCall = resolveToolCall(call, availableTools);
          if (!resolvedCall) {
            const errorResult = sharedFormatToolResult(call.tool, false, "", `Unknown tool: ${call.tool}`);
            messages.push({ role: "user", content: errorResult });
            toolsUsed.push({
              tool: call.tool,
              ok: false,
              summary: `Unknown tool: ${call.tool}`,
              raw: call.input,
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
            const gateResult = sharedFormatToolResult(toolName, false, "", gateError);
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
              summary: `${toolName}: blocked - ${gateError}`,
              raw: toolInput,
            });
            continue;
          }

          if (isWriteToolName(toolName) && typeof toolInput.content !== "string") {
            console.log("[ReactAgent] BLOCKED: write_file requires \"content\" string parameter");
            const errorResult = sharedFormatToolResult(toolName, false, "", 'write_file requires a "content" string parameter');
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
              summary: 'write_file: failed - requires "content" string parameter',
              raw: toolInput,
            });
            continue;
          }

          const toolContext = {
            workspaceRoot: ctx.workspaceRoot ?? process.cwd(),
            runId: ctx.runId,
            abortSignal: ctx.abortSignal,
            requestApproval: ctx.requestToolApproval
              ? (requestedTool: string, args: Record<string, unknown>, _reason: string) =>
                  ctx.requestToolApproval!(requestedTool, args)
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
          const commandFileChanges = result.ok
            ? extractFilesChangedFromCommandOutput(result.output, {
                workspaceRoot: ctx.workspaceRoot ?? process.cwd(),
                cwd: typeof toolInput.cwd === "string" ? toolInput.cwd : undefined,
              })
            : [];
          ctx.recordTrace?.("agent.tool.result", {
            role: this.role,
            iteration: iterationCount,
            tool: toolName,
            requestedTool: resolvedCall.requestedTool,
            input: toolInput,
            result,
          });

          cumulativeToolCallCount++;

          const toolResult = sharedFormatToolResult(toolName, result.ok, result.output, result.error);
          messages.push({ role: "user", content: toolResult });

          const enrichedRaw = { ...toolInput } as Record<string, unknown>;
          if (commandFileChanges.length > 0) {
            enrichedRaw["_filesChangedForDiff"] = commandFileChanges;
          }
          if (result.ok && isWriteToolName(toolName) && typeof toolInput.content === "string") {
            enrichedRaw["_contentForDiff"] = toolInput.content;
          }
          if (result.ok && result.output.trim().length > 0) {
            enrichedRaw["_outputForProof"] = result.output.slice(0, 4000);
          }

          toolsUsed.push({
            tool: toolName,
            ok: result.ok,
            summary: result.ok
              ? `${toolName}: ok (${result.output.length} chars)`
              : `${toolName}: failed - ${result.error ?? "unknown"}`,
            raw: enrichedRaw,
          });

          const fileChangeType = result.ok ? fileChangeTypeForTool(toolName) : undefined;
          if (fileChangeType) {
            const filePath = typeof toolInput.path === "string" ? toolInput.path : "";
            if (filePath) {
              const content = typeof toolInput.content === "string" ? toolInput.content : undefined;
              const diff = content ? content.slice(0, 2000) : undefined;
              recordFileChange(filesChanged, {
                path: filePath,
                changeType: fileChangeType,
                diff,
              });
            }
          }
          for (const file of commandFileChanges) {
            recordFileChange(filesChanged, file);
          }

          const callSig = `${toolName}:${JSON.stringify(toolInput)}`;
          callHistory.push(callSig);

          if (!result.ok || !result.output || result.output.trim() === "" || result.output.startsWith("Error")) {
            consecutiveEmptyResults++;
            if (consecutiveEmptyResults >= this.EMPTY_RESULT_LIMIT) {
              console.warn(`[ReactAgent] Empty/error result loop: ${consecutiveEmptyResults} consecutive failures`);
              stoppedBecause = "loop_detected";
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: `${toolName} returning empty/error`,
                occurrences: consecutiveEmptyResults,
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
            consecutiveEmptyResults = 0;
          }

          if (callHistory.length >= this.LOOP_WINDOW) {
            const window = callHistory.slice(-this.LOOP_WINDOW);
            if (window.every((s) => s === window[0])) {
              console.warn(`[ReactAgent] Loop detected: "${window[0]}" repeated ${this.LOOP_WINDOW} times`);
              stoppedBecause = "loop_detected";
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: window[0],
                occurrences: this.LOOP_WINDOW,
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

          if (callHistory.length >= this.THRASH_WINDOW) {
            const window = callHistory.slice(-this.THRASH_WINDOW);
            const evens = window.filter((_, i) => i % 2 === 0);
            const odds = window.filter((_, i) => i % 2 !== 0);
            const isThrashing =
              evens.every((s) => s === evens[0]) &&
              odds.every((s) => s === odds[0]) &&
              evens[0] !== odds[0];

            if (isThrashing) {
              console.warn(`[ReactAgent] Thrash detected: alternating between "${evens[0]}" and "${odds[0]}"`);
              stoppedBecause = "loop_detected";
              loopEvidence = {
                iteration: iterationCount,
                repeatedCall: `${evens[0]} ↔ ${odds[0]}`,
                occurrences: this.THRASH_WINDOW,
              };
              break;
            }
          }
        }

        if (stoppedBecause === "loop_detected") {
          break;
        }

        const allToolsSucceeded = toolCalls.every((call) => {
          const lastEvent = toolsUsed[toolsUsed.length - toolCalls.indexOf(call) - 1];
          return lastEvent?.ok === true;
        });
        const hasTextResponse = stripToolCalls(modelOutput).trim().length > 0;
        const noDanglingToolCall = !modelOutput.includes("<tool_call>") ||
          (toolCalls.length > 0 &&
           !modelOutput.slice(modelOutput.lastIndexOf("</tool_call>") + 12).includes("<tool_call>"));

        if (
          stoppedBecause === "max_iterations" &&
          allToolsSucceeded &&
          hasTextResponse &&
          noDanglingToolCall &&
          finalAnswerFound
        ) {
          if (finalAnswer) {
            currentOutputText = finalAnswer;
          } else if (lastRejectedFinalAnswer.trim().length > 0) {
            currentOutputText = lastRejectedFinalAnswer;
          }
          stoppedBecause = "done";
          ctx.recordTrace?.("agent.loop.early_exit", {
            iteration: iterationCount,
            reason: "tools_complete",
          });
          break;
        }
      }

      const allTaskTextForRescue = `${contract.intent} ${contract.goals.join(" ")} ${contract.doneCriteria.join(" ")}`;
      const taskImpliesFileSaveRescue = taskExplicitlyRequestsFileSave(allTaskTextForRescue);
      const writeFileCalledRescue = toolsUsed.some((e) => isWriteToolName(e.tool));

      if (
        taskImpliesFileSaveRescue &&
        !writeFileCalledRescue &&
        lastRejectedFinalAnswer.trim().length > 100 &&
        iterationCount < 4
      ) {
        const pathMatch =
          allTaskTextForRescue.match(/\b([\w.\-/]+\.(?:md|txt|ts|js|json|yaml|yml|py|sh|csv))\b/i);
        const targetPath = pathMatch?.[1] ?? "";
        const writeTool = availableTools.find((t) => isWriteToolName(t.name));
        if (targetPath && writeTool) {
          try {
            ctx.recordTrace?.("agent.postloop_write_rescue", { targetPath, contentLength: lastRejectedFinalAnswer.length });
            const writeResult = await writeTool.execute(
              { path: targetPath, content: lastRejectedFinalAnswer },
              { workspaceRoot: ctx.workspaceRoot },
            );
            toolsUsed.push({
              tool: writeTool.name,
              ok: writeResult.ok,
              summary: writeResult.ok ? `Rescued: wrote ${targetPath}` : writeResult.error ?? "write failed",
              raw: { path: targetPath, _contentForDiff: lastRejectedFinalAnswer },
            });
            if (writeResult.ok) {
              recordFileChange(filesChanged, {
                path: targetPath,
                changeType: "A",
                diff: lastRejectedFinalAnswer.slice(0, 2000),
              });
              currentOutputText = lastRejectedFinalAnswer;
            }
          } catch (rescueErr) {
            ctx.recordTrace?.("agent.postloop_write_rescue.error", { error: String(rescueErr) });
          }
        }
      } else if (taskImpliesFileSaveRescue && !writeFileCalledRescue && iterationCount >= 4) {
        ctx.recordTrace?.("agent.loop.rescue.skipped", {
          reason: "loop_exhausted",
          iterations: iterationCount,
        });
      }

      if (!finalAnswerFound && toolsUsed.length > 0 && stoppedBecause === "max_iterations") {
        try {
          ctx.recordTrace?.("agent.finalization.request", {
            role: this.role,
            iterationCount,
            toolCount: toolsUsed.length,
          });
          const finalization = await this.llmAdapter.complete({
            model: "",
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
            stoppedBecause = "done";
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
      let finalOutput = currentOutputText || cleanedLastOutput.trim();

      const effectiveOutput = finalOutput.trim();
      const strippedForClassification = stripThoughtBlocks(effectiveOutput).trim();
      if (!finalAnswerFound && toolsUsed.length > 0 && stoppedBecause === "max_iterations") {
        stoppedBecause = "no_final_output";
        finalOutput = "";
        console.warn(
          `[ReactAgent] no_final_output: run exhausted ${iterationCount} iteration(s) ` +
          `after ${toolsUsed.length} tool event(s) without a FINAL ANSWER.`,
        );
      }
      if (strippedForClassification && !looksLikePureProgress(strippedForClassification) && stoppedBecause === "max_iterations") {
        stoppedBecause = "done";
      }
      if (!finalAnswerFound && strippedForClassification.length === 0 && stoppedBecause === "max_iterations") {
        stoppedBecause = "no_final_output";
        console.warn(
          `[ReactAgent] no_final_output: run completed ${iterationCount} iteration(s) ` +
          `with ${toolsUsed.length} tool event(s) but produced no FINAL ANSWER.`,
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
        loopEvidence,
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

      if (tools.length === 0 && !ctx.recordTrace) {
        try {
          return await this.runSharedLoopFallback(task, tools, ctx);
        } catch {
          // Fall through to the legacy error result.
        }
      }

      stoppedBecause = "error";
      error = err instanceof Error ? err.message : String(err);
      ctx.recordTrace?.("agent.run.error", {
        role: this.role,
        iterationCount,
        error,
      });

      return {
        outputText: "",
        thoughts,
        toolsUsed,
        filesChanged,
        iterationCount,
        stoppedBecause,
        error,
        loopEvidence,
      };
    }
  }
}
