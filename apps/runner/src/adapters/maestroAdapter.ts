import {
  createMaestroCore,
  selectRole,
  getRolePrompt,
} from "maestro-core";
import type {
  RoleName,
  OptionalRoleName,
  TaskContext as RoleSelectorContext,
  OrchestrationResult,
} from "maestro-core";
import type {
  MaestroPort,
  OrcaMaestroResult,
  OrcaRunCtx,
  OrcaTaskSpec,
  OrcaToolService,
  OrcaLLMService,
} from "@clawde/orca-core";

// ---------------------------------------------------------------------------
// MaestroAdapter — wraps maestro-core's MaestroCore to satisfy MaestroPort.
//
// Responsibilities are split deliberately:
//   maestro-core.orchestrate()  →  task classification + risk metadata (sync)
//   selectRole()                →  pick the best department head for this task
//   getRolePrompt()             →  load that department head's system prompt
//   ctx.llm.complete()          →  actual text generation (Miranda pipeline)
//
// Maestro never touches a model directly; ctx.llm is the ONLY LLM surface
// it uses (backed by Miranda's PLAN→ANSWER→CRITIQUE→REWRITE pipeline).
// ---------------------------------------------------------------------------

// All optional roles are treated as available in the adapter layer.
// When the settings panel (Phase 6) is wired in, this set will be derived
// from the user's configured model slots instead.
const ALL_OPTIONAL_ROLES = new Set<OptionalRoleName>([
  "planner_deep",
  "debugger",
  "reader",
  "vision",
]);

export function createMaestroAdapter(): MaestroPort {
  const maestro = createMaestroCore();

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      // 1. Classify the task synchronously — no model call needed here.
      const orch = maestro.orchestrate(task.originalUserMessage);

      // 2. Build role-selector context from the OrcaTaskSpec.
      const roleCtx = buildRoleSelectorContext(task);

      // 3. Pick the best role (optional-role detection + core-role heuristics).
      const { role, isFallback, warning } = selectRole(
        roleCtx,
        ALL_OPTIONAL_ROLES,
        pickCoreRole(task),
      );

      if (warning) {
        console.warn(`[MaestroAdapter] Role warning: ${warning}`);
      }

      // 4. Subagent decomposition — only at top level, only for multiStep tasks.
      //    planner_deep breaks the task into independent parallel subtasks.
      //    subagentDepth guard prevents recursive subagent spawning.
      const depth = ctx.subagentDepth ?? 0;
      if (depth === 0 && orch.classification.multiStep) {
        const subtasks = await decomposeTask(task.originalUserMessage, ctx.llm);
        if (subtasks !== null && subtasks.length > 1) {
          return runSubagentPool(task, subtasks, orch, ctx);
        }
      }

      // 5. Single-agent path.
      return runSingleAgent(task, role, isFallback, orch, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Role selection helpers
// ---------------------------------------------------------------------------

/**
 * Map OrcaTaskSpec fields onto the RoleSelector's TaskContext shape.
 */
function buildRoleSelectorContext(task: OrcaTaskSpec): RoleSelectorContext {
  const ctx = task.context ?? {};
  return {
    task:                task.originalUserMessage,
    hasImages:           Boolean(ctx["hasImages"]),
    errorOutput:         typeof ctx["errorOutput"] === "string" ? ctx["errorOutput"] : undefined,
    textLength:          task.originalUserMessage.length,
    fileCount:           typeof ctx["fileCount"] === "number" ? ctx["fileCount"] : undefined,
    isDeepPlanRequested: typeof ctx["deepPlan"] === "boolean" ? ctx["deepPlan"] : undefined,
    filePath:            typeof ctx["filePath"] === "string" ? ctx["filePath"] : undefined,
  };
}

/**
 * Heuristic core-role selection runs BEFORE selectRole's optional-role
 * detection. selectRole will override this if a special trigger fires.
 *
 * Priority order (first match wins):
 *   repair task      → coder_strong  (targeted fix)
 *   code/implement   → coder_strong
 *   quick edit hints → coder_cheap
 *   review/audit     → reviewer
 *   docs/write       → narrator
 *   default          → brain
 */
function pickCoreRole(task: OrcaTaskSpec): "brain" | "coder_strong" | "coder_cheap" | "reviewer" | "narrator" | "utility" {
  if (task.intent === "repair") return "coder_strong";

  const msg = task.originalUserMessage.toLowerCase();

  if (/\b(implement|build|create|add feature|write code|develop)\b/.test(msg))
    return "coder_strong";

  if (/\b(rename|reformat|fix typo|small (fix|change|edit)|update import|add field)\b/.test(msg))
    return "coder_cheap";

  if (/\b(review|audit|critique|check for (bugs|issues|problems)|is this (correct|right|good))\b/.test(msg))
    return "reviewer";

  if (/\b(document|write (a |the )?(readme|docs?|comment|jsdoc|tsdoc)|explain (to others|in plain))\b/.test(msg))
    return "narrator";

  return "brain";
}

// ---------------------------------------------------------------------------
// Task prompt builder
// ---------------------------------------------------------------------------

function buildTaskPrompt(task: OrcaTaskSpec, role: string, isFallback: boolean): string {
  const isRepair = task.intent === "repair";

  const header = isRepair
    ? "## Repair Task\nYou are fixing defects identified in a previous attempt.\n" +
      "Address every issue listed in the context below without changing unrelated behaviour."
    : `## Task\nRole: **${role}**${isFallback ? " (fallback — preferred role unavailable)" : ""}`;

  const lines: string[] = [
    header,
    "",
    "### Request",
    task.originalUserMessage,
    "",
    "### Goals",
    ...task.goals.map((g: string) => `- ${g}`),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  if (task.context != null && Object.keys(task.context).length > 0) {
    // Strip internal routing keys before showing to the model
    const { hasImages: _hi, errorOutput: _eo, fileCount: _fc, deepPlan: _dp, filePath: _fp, forcedRole: _fr, ...userCtx } = task.context as Record<string, unknown>;
    if (Object.keys(userCtx).length > 0) {
      lines.push("", "### Context", JSON.stringify(userCtx, null, 2));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Single-agent execution — the shared workhorse used both for top-level tasks
// (when no decomposition fires) and for individual subagents.
// ---------------------------------------------------------------------------

async function runSingleAgent(
  task: OrcaTaskSpec,
  role: string,
  isFallback: boolean,
  orch: OrchestrationResult,
  ctx: OrcaRunCtx,
): Promise<OrcaMaestroResult> {
  // Subagents may carry a forcedRole in context (set by runSubagentPool).
  const effectiveRole = (
    typeof task.context?.["forcedRole"] === "string"
      ? task.context["forcedRole"]
      : role
  ) as RoleName;

  const systemPrompt = getRolePrompt(effectiveRole);
  const taskPrompt = buildTaskPrompt(task, effectiveRole, isFallback);

  let outputText: string;
  let toolEvents: OrcaMaestroResult["toolEvents"] = [];

  if (ctx.tools) {
    const result = await runAgentLoop(systemPrompt, taskPrompt, ctx.tools, ctx);
    outputText = result.text;
    toolEvents = result.toolEvents;
  } else {
    const { text } = await ctx.llm.complete(
      `${systemPrompt}\n\n---\n\n${taskPrompt}`,
      { maxTokens: 4096 },
    );
    outputText = text;
  }

  return {
    outputText,
    toolEvents,
    summary: [
      `run_id=${orch.run_id}`,
      `role=${effectiveRole}${isFallback ? "(fallback)" : ""}`,
      `type=${String(orch.classification.type)}`,
      `risk=${orch.risk.riskScore.toFixed(2)}`,
      ...(toolEvents && toolEvents.length > 0 ? [`tools=${toolEvents.length}`] : []),
    ].join(" "),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Subagent decomposition + parallel pool
// ---------------------------------------------------------------------------

/**
 * Ask planner_deep to break a multi-step task into independent parallel
 * subtasks. Returns an array of {role, task} objects, or null if decomposition
 * fails or produces a single-item list (fall through to single-agent).
 */
async function decomposeTask(
  originalMessage: string,
  llm: OrcaLLMService,
): Promise<Array<{ role: string; task: string }> | null> {
  const systemPrompt = getRolePrompt("planner_deep");
  const decompositionPrompt = [
    "## Task Decomposition",
    "",
    "Break the following request into the smallest set of INDEPENDENT parallel subtasks.",
    "Respond with ONLY a valid JSON array — no markdown fences, no explanation.",
    "",
    'Format: [{"role":"ROLE","task":"DESCRIPTION"},...]',
    "",
    "Available roles: brain, coder_strong, coder_cheap, reviewer, narrator, debugger, reader",
    "Rules:",
    "- Maximum 5 subtasks",
    "- Each subtask MUST be fully independent (no subtask requires another's output)",
    "- If the task is a single unit of work, return exactly one item",
    "- Assign the most appropriate role to each subtask",
    "",
    "Task to decompose:",
    originalMessage,
  ].join("\n");

  try {
    const { text } = await llm.complete(
      `${systemPrompt}\n\n---\n\n${decompositionPrompt}`,
      { maxTokens: 1024 },
    );

    // Strip markdown code fences the model may wrap the JSON in.
    const stripped = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return null;

    const subtasks = (parsed as unknown[])
      .filter(
        (item): item is { role: string; task: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>)["role"] === "string" &&
          typeof (item as Record<string, unknown>)["task"] === "string",
      )
      .slice(0, 5);

    return subtasks.length > 0 ? subtasks : null;
  } catch {
    // Decomposition is best-effort. Fall back to single-agent on any error.
    return null;
  }
}

/**
 * Run multiple subtasks in parallel, each as an independent single-agent
 * call. Emits subagent events via ctx.emit. Synthesizes results when > 1
 * subagent completes successfully.
 */
async function runSubagentPool(
  task: OrcaTaskSpec,
  subtasks: Array<{ role: string; task: string }>,
  orch: OrchestrationResult,
  ctx: OrcaRunCtx,
): Promise<OrcaMaestroResult> {
  const allToolEvents: NonNullable<OrcaMaestroResult["toolEvents"]> = [];
  const subagentRuns: NonNullable<OrcaMaestroResult["subagentRuns"]> = [];

  // Build a child ctx that prevents recursive decomposition.
  const childCtx: OrcaRunCtx = {
    ...ctx,
    subagentDepth: (ctx.subagentDepth ?? 0) + 1,
  };

  console.error(
    `[MaestroAdapter] decompose  subtasks=${subtasks.length}  run_id=${orch.run_id}`,
  );

  // Spawn all subagents (emit spawned events eagerly, before they run).
  const agents = subtasks.map((st, i) => ({
    subagentId: `${ctx.runId}_sa${i}`,
    role: st.role,
    task: st.task,
  }));

  for (const agent of agents) {
    ctx.emit?.({
      type: "subagent:spawned",
      taskId: ctx.runId,
      subagentId: agent.subagentId,
      role: agent.role,
      task: agent.task,
    });
    console.error(
      `[MaestroAdapter] subagent:spawned  id=${agent.subagentId}  role=${agent.role}`,
    );
  }

  // Run all agents concurrently.
  const agentPromises = agents.map(async (agent) => {
    const subSpec: OrcaTaskSpec = {
      originalUserMessage: agent.task,
      intent: agent.task,
      goals: [agent.task],
      constraints: task.constraints,
      context: { ...task.context, forcedRole: agent.role },
    };

    try {
      const result = await runSingleAgent(
        subSpec,
        agent.role,
        false,
        orch,
        childCtx,
      );

      ctx.emit?.({
        type: "subagent:done",
        taskId: ctx.runId,
        subagentId: agent.subagentId,
        role: agent.role,
        ok: true,
      });
      console.error(`[MaestroAdapter] subagent:done  id=${agent.subagentId}`);

      return {
        ...agent,
        status: "done" as const,
        outputText: result.outputText ?? "",
        toolEvents: result.toolEvents ?? [],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ctx.emit?.({
        type: "subagent:failed",
        taskId: ctx.runId,
        subagentId: agent.subagentId,
        role: agent.role,
        error,
      });
      console.error(
        `[MaestroAdapter] subagent:failed  id=${agent.subagentId}  error=${error}`,
      );

      return {
        ...agent,
        status: "failed" as const,
        outputText: "",
        toolEvents: [] as NonNullable<OrcaMaestroResult["toolEvents"]>,
        error,
      };
    }
  });

  const results = await Promise.all(agentPromises);

  for (const r of results) {
    allToolEvents.push(...r.toolEvents);
    subagentRuns.push({
      subagentId: r.subagentId,
      role: r.role,
      task: r.task,
      status: r.status,
      outputText: r.outputText,
      error: "error" in r ? r.error : undefined,
    });
  }

  const successful = results.filter((r) => r.status === "done");

  let finalText: string;
  if (successful.length === 0) {
    finalText = "All subagents failed to complete the task.";
  } else if (successful.length === 1) {
    finalText = successful[0]!.outputText;
  } else {
    finalText = await synthesizeResults(task.originalUserMessage, successful, ctx.llm);
  }

  return {
    outputText: finalText,
    toolEvents: allToolEvents,
    subagentRuns,
    summary: [
      `run_id=${orch.run_id}`,
      `subagents=${results.length}`,
      `done=${successful.length}`,
      `failed=${results.length - successful.length}`,
      ...(allToolEvents.length > 0 ? [`tools=${allToolEvents.length}`] : []),
    ].join(" "),
  };
}

/**
 * Merge multiple subagent outputs into a single coherent response using
 * the brain role.
 */
async function synthesizeResults(
  originalMessage: string,
  results: Array<{ role: string; task: string; outputText: string }>,
  llm: OrcaLLMService,
): Promise<string> {
  const brainPrompt = getRolePrompt("brain");

  const resultBlocks = results
    .map(
      (r, i) =>
        `### Subtask ${i + 1} (role: ${r.role})\n**Task:** ${r.task}\n\n${r.outputText}`,
    )
    .join("\n\n");

  const synthesisPrompt = [
    "## Synthesis Task",
    "",
    "Multiple specialized agents completed parallel subtasks for the following request.",
    "Synthesize their outputs into one coherent, complete response.",
    "Remove redundancy. Preserve all important details. Speak directly to the user.",
    "",
    "## Original User Request",
    originalMessage,
    "",
    "## Subagent Outputs",
    "",
    resultBlocks,
    "",
    "## Your Task",
    "Produce a single unified answer that fully addresses the original request.",
  ].join("\n");

  const { text } = await llm.complete(
    `${brainPrompt}\n\n---\n\n${synthesisPrompt}`,
    { maxTokens: 4096 },
  );
  return text;
}

// ---------------------------------------------------------------------------
// Agent loop — allows the model to call tools in multiple turns until it
// produces a final answer (no <tool_call> block in its response).
//
// Calling convention (taught to the model via ToolRegistry.formatForPrompt()):
//
//   Model output:                    We feed back:
//   <tool_call>                      <tool_result tool="X" ok="true|false">
//   {"tool": "X", "arg": "val"}      ...output or error text...
//   </tool_call>                     </tool_result>
//
// The conversation grows with each iteration. Miranda sees the full context
// on every call so it has complete history.
// ---------------------------------------------------------------------------

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

interface ParsedCall {
  tool: string;
  input: Record<string, unknown>;
}

function parseToolCalls(text: string): ParsedCall[] {
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

function formatToolResult(tool: string, ok: boolean, output: string, error?: string): string {
  const status = ok ? 'ok="true"' : 'ok="false"';
  const body = ok ? output : (error ?? output ?? "unknown error");
  return `\n<tool_result tool="${tool}" ${status}>\n${body}\n</tool_result>`;
}

async function runAgentLoop(
  systemPrompt: string,
  taskPrompt: string,
  tools: OrcaToolService,
  ctx: OrcaRunCtx,
): Promise<{
  text: string;
  toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]>;
}> {
  const MAX_ITERATIONS = 10;
  const toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]> = [];

  // Full conversation grows with each turn so the model always has context.
  let conversation =
    `${systemPrompt}\n\n${tools.formatForPrompt()}\n\n---\n\n${taskPrompt}`;

  let lastText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { text } = await ctx.llm.complete(conversation, { maxTokens: 4096 });
    lastText = text;

    const calls = parseToolCalls(text);

    if (calls.length === 0) {
      // No tool calls — model is done.
      break;
    }

    // Append this assistant turn to the conversation.
    conversation += `\n\nAssistant:\n${text}`;

    // Execute each tool call and append results.
    for (const call of calls) {
      console.error(
        `[MaestroAdapter] tool:call  name=${call.tool}  iteration=${i + 1}/${MAX_ITERATIONS}`,
      );

      const result = await tools.execute(call.tool, call.input);

      toolEvents.push({
        tool: call.tool,
        ok: result.ok,
        summary: result.ok
          ? `${call.tool}: ok (${result.output.length} chars)`
          : `${call.tool}: failed — ${result.error ?? "unknown"}`,
        raw: call.input,
      });

      console.error(
        `[MaestroAdapter] tool:result ok=${result.ok}  chars=${result.output.length}`,
      );

      conversation += formatToolResult(call.tool, result.ok, result.output, result.error);
    }
  }

  // Strip any dangling <tool_call> blocks from the final response
  // (can happen if the model starts a call but we hit MAX_ITERATIONS).
  const cleanText = lastText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();

  return { text: cleanText, toolEvents };
}
