import * as fs from "fs";
import * as path from "path";
import {
  createMaestroCore,
  selectRole,
  getRolePrompt,
  pickCoreRole as pickCoreRoleFromTask,
} from "maestro-core";
import type {
  RoleName,
  OptionalRoleName,
  TaskContext as RoleSelectorContext,
  OrchestrationResult,
  CoreRoleName,
} from "maestro-core";
import type {
  MaestroPort,
  OrcaMaestroResult,
  OrcaFileChange,
  OrcaRunCtx,
  OrcaTaskSpec,
  OrcaToolService,
  OrcaLLMService,
  WorkspaceContext,
} from "@clawde/orca-core";
import { Dewey } from "@clawde/dewey-core";
import type { BrainPlan, UserBrief } from "@clawde/dewey-core";
import type { ExtendedOrcaToolService } from "./toolService.js";
import { traceEvent } from "./tracerHooks.js";

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

// ---------------------------------------------------------------------------
// Role Settings Loader
// ---------------------------------------------------------------------------

export interface RoleSettings {
  provider: string;
  model: string;
  label: string;
}

export interface OrcaSettings {
  roles: Record<string, RoleSettings>;
}

/**
 * Load available roles from orca-settings.json at runtime.
 * Falls back to default core roles if file is not found.
 */
function loadRoleSettings(): OrcaSettings {
  const settingsPath = path.join(process.cwd(), "orca-settings.json");
  
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(content) as OrcaSettings;
  } catch {
    // Fall back to default roles if file not found
    return {
      roles: {
        brain: { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
        coder_strong: { provider: "openrouter", model: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next" },
        coder_cheap: { provider: "openrouter", model: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next" },
        utility: { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
        reviewer: { provider: "openrouter", model: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
        narrator: { provider: "openrouter", model: "qwen/qwen2.5-7b-instruct", label: "Qwen2.5 7B Instruct" },
      },
    };
  }
}

/**
 * Get the list of available core role names from settings.
 */
function getAvailableCoreRoles(settings: OrcaSettings): string[] {
  return Object.keys(settings.roles);
}

/**
 * Format available roles as a comma-separated string for prompts.
 */
function formatAvailableRoles(settings: OrcaSettings): string {
  return getAvailableCoreRoles(settings).join(", ");
}

export function createMaestroAdapter(): MaestroPort {
  const maestro = createMaestroCore();
  const dewey = new Dewey();
  const settings = loadRoleSettings();

  // Start the Dewey session asynchronously — non-blocking at startup.
  dewey.startSession().catch((err: unknown) => {
    console.warn("[Dewey] Failed to start session:", err);
  });

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
        pickCoreRole(task, settings),
      );

      if (warning) {
        console.warn(`[MaestroAdapter] Role warning: ${warning}`);
      }

      traceEvent({ type: "brain:route", data: { role, isFallback, warning, coreRole: pickCoreRole(task, settings) } });

      // 4. Dewey pre-flight — brief the table before Brain routes.
      const brief = await dewey.brief(task.originalUserMessage);
      ctx.emit?.({
        type: "dewey:brief",
        taskId: ctx.runId,
        userName: brief.userName,
        suggestedTone: brief.suggestedTone,
        relevantPreferences: brief.relevantPreferences,
        relevantContext: brief.relevantContext,
      });
      traceEvent({ type: "dewey:brief", data: brief });

      // 5. Subagent decomposition — only at top level, only for multiStep tasks.
      //    planner_deep breaks the task into independent parallel subtasks.
      //    subagentDepth guard prevents recursive subagent spawning.
      //    DIRECT ROUTING: Skip decomposition for simple single-deliverable tasks.
      if (shouldAttemptSubagentDecomposition(task, orch, ctx)) {
        const subtasks = await decomposeTask(task.originalUserMessage, ctx.llm, settings);
        if (subtasks !== null && subtasks.length > 1) {
          return runSubagentPool(task, subtasks, orch, ctx);
        }
      }

      // 6. Build candidate plan for Dewey review then run single-agent path.
      //    Dewey review loop: up to 3 attempts to get plan approved.
      const candidatePlan: BrainPlan = {
        steps: task.goals,
        toolsRequired: ctx.tools ? ["tools_available"] : [],
        role,
      };

      let approvedPlan = candidatePlan;
      let approved = false;
      let attempts = 0;
      let lastConcerns: string[] = [];
      let lastSuggestions: string[] = [];

      while (!approved && attempts < 3) {
        const deweyReview = await dewey.reviewPlan(approvedPlan, task.originalUserMessage, brief);
        traceEvent({ type: "dewey:review", data: deweyReview });

        if (deweyReview.approved) {
          approved = true;
        } else {
          lastConcerns = deweyReview.concerns;
          lastSuggestions = deweyReview.suggestions;
          console.log("[Dewey] Pre-flight concerns:", deweyReview.concerns);

          // Revise: inject concerns into goals for the next attempt.
          approvedPlan = {
            ...approvedPlan,
            steps: [
              ...approvedPlan.steps,
              ...deweyReview.suggestions,
            ],
          };
          attempts++;
        }
      }

      if (!approved) {
        return {
          outputText: `I want to make sure I do this right for you. ${lastConcerns.join(" ")}`,
          toolEvents: [],
          filesChanged: [],
          summary: `dewey_blocked concerns=${lastConcerns.length} suggestions=${lastSuggestions.length}`,
        };
      }

      // 7. Single-agent path.
      const result = await runSingleAgent(task, role, isFallback, orch, ctx, false, brief);

      // 8. Dewey post-flight observation.
      dewey.observe({
        taskType: String(orch.classification.type ?? "general"),
        taskSummary: task.originalUserMessage.slice(0, 120),
        timestamp: new Date().toISOString(),
        verdict: result.toolEvents?.some((e) => !e.ok) ? "WARN" : "PASS",
        preferencesApplied: brief.relevantPreferences,
        newSignals: deriveDeweySignals(task),
      }).catch((err: unknown) => {
        console.warn("[Dewey] Failed to record observation:", err);
      });

      return result;
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
 * Uses pickCoreRole from maestro-core which routes based on task keywords.
 *
 * Priority order (first match wins):
 *   writing/creative   → narrator (song, poem, story, essay, letter, email, etc.)
 *   planning           → brain (decompose and route only, never execute)
 *   code/implement     → coder_strong
 *   review/audit       → reviewer
 *   utility tasks      → utility
 *   quick edit hints   → coder_cheap
 *   default/fallback   → narrator (NOT brain — brain is only for planning)
 */
function pickCoreRole(
  task: OrcaTaskSpec,
  settings: OrcaSettings,
): CoreRoleName {
  const availableRoles = new Set(getAvailableCoreRoles(settings));
  
  // Handle repair tasks first — always route to coder_strong
  if (task.intent === "repair") {
    if (availableRoles.has("coder_strong")) return "coder_strong";
  }

  // Use the maestro-core pickCoreRole function for pattern-based routing
  // This handles writing/creative → narrator, planning → brain, etc.
  const roleFromTask = pickCoreRoleFromTask(task.originalUserMessage);
  
  // If the selected role is available, use it
  if (availableRoles.has(roleFromTask)) {
    return roleFromTask;
  }
  
  // Fallback: if the preferred role is not available, fall back to narrator
  // Brain is NOT used as fallback — brain is only for explicit planning requests
  if (availableRoles.has("narrator")) return "narrator";
  
  // Return first available role as last resort
  const firstRole = getAvailableCoreRoles(settings)[0];
  return (firstRole as CoreRoleName) ?? "narrator";
}

function describeDeweySignal(signal: string): string {
  switch (signal) {
    case "prefer_brief":
      return "Prefer brief responses.";
    case "prefer_detailed":
      return "Prefer detailed explanations when useful.";
    case "prefer_formal_tone":
      return "Prefer a formal tone.";
    case "prefer_bullets":
      return "Prefer bullet lists for structured answers.";
    case "prefer_json":
      return "Prefer JSON for structured output when appropriate.";
    case "prefer_table":
      return "Prefer tables for comparisons or structured data.";
    default:
      return signal.replace(/_/g, " ");
  }
}

export function deriveDeweySignals(task: OrcaTaskSpec): string[] {
  const message = task.originalUserMessage.toLowerCase();
  const signals = new Set<string>();
  const requestsJsonOutput =
    task.outputFormat === "json" ||
    /\b(as|in)\s+json\b|\bjson\s+(format|output)\b|\b(return|respond|answer|reply)\s+(with\s+)?json\b|\bmachine-readable\b|\bstructured output\b/.test(message);

  if (/\bbrief\b|\bconcise\b|\bshort\b|\bquick summary\b/.test(message)) {
    signals.add("prefer_brief");
  }
  if (/\bdetailed\b|\bthorough\b|\bin depth\b|\bstep[- ]by[- ]step\b/.test(message)) {
    signals.add("prefer_detailed");
  }
  if (/\bformal\b|\bprofessionally\b|\bprofessional tone\b/.test(message)) {
    signals.add("prefer_formal_tone");
  }

  if (task.outputFormat === "bullets" || /\bbullet(s)?\b|\blist\b/.test(message)) {
    signals.add("prefer_bullets");
  }
  if (requestsJsonOutput) {
    signals.add("prefer_json");
  }
  if (task.outputFormat === "table" || /\btable\b|\btabular\b|\bcolumns?\b/.test(message)) {
    signals.add("prefer_table");
  }

  return [...signals];
}

// ---------------------------------------------------------------------------
// Task prompt builder
// ---------------------------------------------------------------------------

function buildTaskPrompt(
  task: OrcaTaskSpec,
  role: string,
  isFallback: boolean,
  workspaceContext?: WorkspaceContext,
  deweyBrief?: Pick<UserBrief, "suggestedTone" | "relevantPreferences">,
  isSubagent: boolean = false,
): string {
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

  if (task.permissions) {
    const executionLimits: string[] = [];
    if (!task.permissions.fileWrite) {
      executionLimits.push("Read-only task: do not create, modify, or delete files.");
    }
    if (!task.permissions.shellExec) {
      executionLimits.push("Do not run shell commands for this task.");
    }
    const allowedTools = Array.isArray(task.permissions.toolsAllowed)
      ? task.permissions.toolsAllowed.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
      : [];
    if (allowedTools.length > 0) {
      executionLimits.push(`Allowed tools: ${allowedTools.join(", ")}`);
    }
    if (executionLimits.length > 0) {
      lines.push("", "### Execution Limits", ...executionLimits.map((line) => `- ${line}`));
    }
  }

  // ── Workspace context ──────────────────────────────────────────────────────
  // Gives the model grounding: which branch, what recently changed, etc.
  if (deweyBrief) {
    const preferenceLines = [
      ...(deweyBrief.suggestedTone !== "casual" ? [`Suggested tone: ${deweyBrief.suggestedTone}`] : []),
      ...deweyBrief.relevantPreferences.slice(0, 6).map(describeDeweySignal),
    ];
    if (preferenceLines.length > 0) {
      lines.push("", "### User Preferences", ...preferenceLines.map((line) => `- ${line}`));
    }
  }

  if (workspaceContext) {
    const ws: string[] = [`cwd: ${workspaceContext.cwd}`];
    if (workspaceContext.gitBranch)        ws.push(`branch: ${workspaceContext.gitBranch}`);
    if (workspaceContext.gitCommit)        ws.push(`commit: ${workspaceContext.gitCommit}`);
    if (workspaceContext.gitCommitMessage) ws.push(`last commit: ${workspaceContext.gitCommitMessage}`);
    if (workspaceContext.recentlyModifiedFiles?.length) {
      ws.push(`recently modified: ${workspaceContext.recentlyModifiedFiles.slice(0, 10).join(", ")}`);
    }
    lines.push("", "### Workspace", ws.join("\n"));
    
    // ── Subagent workspace warning ───────────────────────────────────────────
    // Prevents subagents from referencing files outside the current workspace.
    if (isSubagent) {
      lines.push(
        "",
        "⚠ **Important**: All file paths must be relative to cwd above.",
        "Do not reference files in other packages (e.g. packages/dewey-core).",
        "If you need to read a file, confirm it exists under cwd first."
      );
    }

    // ── Subagent coordination context ────────────────────────────────────────
    // Tells subagents about sibling files and coordination requirements.
    // Read coordination from task.context which is populated by runSubagentPool.
    if (isSubagent && task.context?.["coordination"]) {
      const coord = task.context["coordination"] as { siblings?: string[]; exportName?: string; dependedOnBy?: string[]; message?: string };
      lines.push("", "### Coordination Context");
      if (coord.message) {
        lines.push(coord.message);
      }
      if (coord.siblings && coord.siblings.length > 0) {
        lines.push(`- **Sibling files being created**: ${coord.siblings.join(", ")}`);
      }
      if (coord.exportName) {
        lines.push(`- **Your export name**: ${coord.exportName}`);
      }
      if (coord.dependedOnBy && coord.dependedOnBy.length > 0) {
        lines.push(`- **Depended on by**: ${coord.dependedOnBy.join(", ")}`);
      }
    }
  }

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  if (task.context != null && Object.keys(task.context).length > 0) {
    // Strip internal routing keys + conversation history before showing raw JSON
    const {
      hasImages: _hi,
      errorOutput: _eo,
      fileCount: _fc,
      deepPlan: _dp,
      filePath: _fp,
      forcedRole: _fr,
      conversationHistory: convHistory,
      ...userCtx
    } = task.context as Record<string, unknown>;

    // ── Conversation history ───────────────────────────────────────────────
    // Rendered as readable dialogue so the model can resolve back-references.
    const conversationTurns = normalizeConversationHistory(convHistory);
    if (conversationTurns.length > 0) {
      lines.push("", "### Conversation History");
      for (const turn of conversationTurns) {
        lines.push(`**User:** ${turn.user}`);
        const preview = turn.assistant.length > 400
          ? `${turn.assistant.slice(0, 400)}…`
          : turn.assistant;
        lines.push(`**You previously replied:** ${preview}`);
        lines.push("");
      }
    }

    if (Object.keys(userCtx).length > 0) {
      lines.push("", "### Context", JSON.stringify(userCtx, null, 2));
    }
  }

  return lines.join("\n");
}

export function normalizeConversationHistory(
  history: unknown,
): Array<{ user: string; assistant: string }> {
  if (!Array.isArray(history)) return [];

  const turns: Array<{ user: string; assistant: string }> = [];
  let pendingUserMessage: string | undefined;

  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;

    if (typeof record["user"] === "string" && typeof record["assistant"] === "string") {
      turns.push({ user: record["user"], assistant: record["assistant"] });
      pendingUserMessage = undefined;
      continue;
    }

    if (record["role"] === "user" && typeof record["content"] === "string") {
      pendingUserMessage = record["content"];
      continue;
    }

    if (
      record["role"] === "assistant" &&
      typeof record["content"] === "string" &&
      pendingUserMessage !== undefined
    ) {
      turns.push({ user: pendingUserMessage, assistant: record["content"] });
      pendingUserMessage = undefined;
    }
  }

  return turns;
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
  isSubagent: boolean = false,
  deweyBrief?: Pick<UserBrief, "suggestedTone" | "relevantPreferences">,
): Promise<OrcaMaestroResult> {
  // Subagents may carry a forcedRole in context (set by runSubagentPool).
  const effectiveRole = (
    typeof task.context?.["forcedRole"] === "string"
      ? task.context["forcedRole"]
      : role
  ) as RoleName;

  const systemPrompt = getRolePrompt(effectiveRole);
  const taskPrompt = buildTaskPrompt(task, effectiveRole, isFallback, ctx.workspaceContext, deweyBrief, isSubagent);

  let outputText: string;
  let toolEvents: OrcaMaestroResult["toolEvents"] = [];
  let filesChanged: OrcaFileChange[] = [];

  if (ctx.tools) {
    const result = await runAgentLoop(systemPrompt, taskPrompt, ctx.tools, ctx);
    outputText = result.text;
    toolEvents = result.toolEvents;
    filesChanged = result.filesChanged;
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
    filesChanged,
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
 * Direct routing threshold — skip decomposition for simple tasks.
 * Returns true only if the task appears to require multiple independent deliverables.
 */
function shouldDecompose(message: string): boolean {
  // Count distinct deliverables by looking for plural/quantity indicators
  const deliverableKeywords = [
    /\b(files?|functions?|modules?|components?|endpoints?|routes?|services?)\b/gi,
    /\b(each|every|all|multiple|several|various)\b/gi,
    /\b(first|second|third|then|also|and)\b/gi,
  ];

  let deliverableCount = 0;
  for (const regex of deliverableKeywords) {
    const matches = message.match(regex);
    if (matches) {
      deliverableCount += matches.length;
    }
  }

  // If fewer than 3 distinct deliverables, skip decomposition
  if (deliverableCount < 3) {
    return false;
  }

  // Check for explicit multi-file/function mentions
  const filePattern = /\b([A-Za-z0-9_-]+\.(ts|js|tsx|jsx|py|json|md|yaml|yml))\b/gi;
  const fileMatches = message.match(filePattern);
  if (fileMatches && fileMatches.length > 2) {
    return true;
  }

  // Check for multiple function names (camelCase or snake_case patterns)
  const functionPattern = /\b([a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z]+)\b/g;
  const functionMatches = message.match(functionPattern);
  if (functionMatches && functionMatches.length > 2) {
    return true;
  }

  return deliverableCount >= 3;
}

/**
 * Subtask with coordination metadata for parallel execution.
 */
export interface DecomposedSubtask {
  role: string;
  task: string;
  outputPath?: string;
  exportName?: string;
  dependedOnBy?: string[];
  siblings?: string[];
}

export function shouldAttemptSubagentDecomposition(
  task: OrcaTaskSpec,
  orch: Pick<OrchestrationResult, "classification">,
  ctx: Pick<OrcaRunCtx, "subagentDepth">,
): boolean {
  const depth = ctx.subagentDepth ?? 0;
  const isReadOnly = Boolean(
    task.permissions &&
    !task.permissions.fileWrite &&
    !task.permissions.shellExec,
  );

  return (
    depth === 0 &&
    !isReadOnly &&
    orch.classification.multiStep &&
    shouldDecompose(task.originalUserMessage)
  );
}

/**
 * Ask planner_deep to break a multi-step task into independent parallel
 * subtasks. Returns an array of subtask objects with coordination metadata,
 * or null if decomposition fails or produces a single-item list.
 */
async function decomposeTask(
  originalMessage: string,
  llm: OrcaLLMService,
  settings: OrcaSettings,
): Promise<DecomposedSubtask[] | null> {
  const systemPrompt = getRolePrompt("planner_deep");
  const availableRoles = formatAvailableRoles(settings);
  const decompositionPrompt = [
    "## Task Decomposition",
    "",
    "Break the following request into the smallest set of INDEPENDENT parallel subtasks.",
    "Respond with ONLY a valid JSON array — no markdown fences, no explanation.",
    "",
    "Format: [{",
    '  "role": "ROLE",',
    '  "task": "DESCRIPTION",',
    '  "outputPath": "src/utils/filename.ts (optional, for file-producing tasks)",',
    '  "exportName": "functionName (optional, for function exports)",',
    '  "dependedOnBy": ["src/utils/index.ts"] (optional, files that will import this)",',
    '  "siblings": ["other1.ts", "other2.ts"] (optional, other files being created)',
    "},...]",
    "",
    `Available roles: ${availableRoles}, debugger, reader`,
    "",
    "## Coordination Requirements",
    "When multiple subtasks produce files that will be combined:",
    "- Specify the exact output path for each subtask (outputPath)",
    "- Specify the exact export name each subtask must use (exportName)",
    "- Tell each subtask what the other subtasks are producing (siblings)",
    "- Tell each subtask what will import or depend on its output (dependedOnBy)",
    "",
    "Rules:",
    "- Maximum 5 subtasks",
    "- Each subtask MUST be fully independent (no subtask requires another's output)",
    "- If the task is a single unit of work, return exactly one item",
    "- Assign the most appropriate role to each subtask",
    "- For file-producing tasks, always include outputPath",
    "- For function exports, always include exportName",
    "",
    "Task to decompose:",
    originalMessage,
  ].join("\n");

  try {
    const { text } = await llm.complete(
      `${systemPrompt}\n\n---\n\n${decompositionPrompt}`,
      { maxTokens: 2048 },
    );

    // Strip markdown code fences the model may wrap the JSON in.
    const stripped = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return null;

    const subtasks = (parsed as unknown[])
      .filter((item): item is DecomposedSubtask =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>)["role"] === "string" &&
        typeof (item as Record<string, unknown>)["task"] === "string",
      )
      .map((item) => {
        const obj = item as unknown as Record<string, unknown>;
        return {
          role: obj.role as string,
          task: obj.task as string,
          outputPath: typeof obj.outputPath === "string" ? obj.outputPath : undefined,
          exportName: typeof obj.exportName === "string" ? obj.exportName : undefined,
          dependedOnBy: Array.isArray(obj.dependedOnBy) ? obj.dependedOnBy as string[] : undefined,
          siblings: Array.isArray(obj.siblings) ? obj.siblings as string[] : undefined,
        };
      })
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
  subtasks: DecomposedSubtask[],
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

  // Extract sibling file names for coordination context
  const siblingFiles = subtasks
    .map((st) => st.outputPath)
    .filter((p): p is string => !!p)
    .map((p) => path.basename(p));

  console.error(
    `[MaestroAdapter] decompose  subtasks=${subtasks.length}  run_id=${orch.run_id}`,
  );

  // Spawn all subagents (emit spawned events eagerly, before they run).
  const agents = subtasks.map((st, i) => ({
    subagentId: `${ctx.runId}_sa${i}`,
    role: st.role,
    task: st.task,
    outputPath: st.outputPath,
    exportName: st.exportName,
    siblings: st.siblings || siblingFiles.filter((f) => f !== path.basename(st.outputPath || "")),
    dependedOnBy: st.dependedOnBy,
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
    // Build coordination context for this subagent
    const coordinationContext: Record<string, unknown> = {
      forcedRole: agent.role,
    };
    
    // Add coordination metadata if available
    if (agent.outputPath) {
      coordinationContext.outputPath = agent.outputPath;
      coordinationContext.coordination = {
        siblings: agent.siblings,
        exportName: agent.exportName,
        dependedOnBy: agent.dependedOnBy,
        message: `Other agents are simultaneously creating: ${agent.siblings?.join(", ") || "related files"}. Your file will be imported by: ${agent.dependedOnBy?.join(", ") || "index files"}.`,
      };
    }

    const subSpec: OrcaTaskSpec = {
      originalUserMessage: agent.task,
      intent: agent.task,
      goals: [agent.task],
      constraints: task.constraints,
      permissions: task.permissions,
      outputFormat: task.outputFormat,
      context: { ...task.context, ...coordinationContext },
    };

    try {
      const result = await runSingleAgent(
        subSpec,
        agent.role,
        false,
        orch,
        childCtx,
        true,  // isSubagent
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
    { maxTokens: 4096, simple: true },
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

export interface ParsedCall {
  tool: string;
  input: Record<string, unknown>;
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

async function runAgentLoop(
  systemPrompt: string,
  taskPrompt: string,
  tools: OrcaToolService,
  ctx: OrcaRunCtx,
): Promise<{
  text: string;
  toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]>;
  filesChanged: OrcaFileChange[];
}> {
  const MAX_ITERATIONS = 10;
  const toolEvents: NonNullable<OrcaMaestroResult["toolEvents"]> = [];
  const filesChanged: OrcaFileChange[] = [];

  // Full conversation grows with each turn so the model always has context.
  let conversation =
    `${systemPrompt}\n\n${tools.formatForPrompt()}\n\n---\n\n${taskPrompt}`;

  let lastText = "";

  // Dedup guard — skip any tool call with the exact same signature as one
  // already executed this run. Prevents the model from calling write_file
  // (or any tool) in a loop with identical arguments.
  const executedCallSigs = new Set<string>();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { text } = await ctx.llm.complete(conversation, { maxTokens: 8192, simple: true });
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
      // Dedup: skip if we've already executed the exact same call this run.
      const callSig = `${call.tool}:${JSON.stringify(call.input)}`;
      if (executedCallSigs.has(callSig)) {
        console.warn(`[MaestroAdapter] Skipping duplicate tool call: ${call.tool} (identical args already executed)`);
        conversation += formatToolResult(call.tool, false, "Duplicate call skipped — this exact call was already executed successfully.");
        continue;
      }
      executedCallSigs.add(callSig);

      console.error(
        `[MaestroAdapter] tool:call  name=${call.tool}  iteration=${i + 1}/${MAX_ITERATIONS}`,
      );

      // Miranda: before_tool_run gate
      const schema = (ctx.tools as ExtendedOrcaToolService | undefined)?.getSchema?.(call.tool);
      const beforeGate = ctx.gate?.beforeToolRun({ tool: call.tool, args: call.input, schema });
      if (beforeGate && !beforeGate.allowed) {
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

      const result = await tools.execute(call.tool, call.input);
      const outputText = normalizeToolText(result.output);
      const errorText = result.error === undefined ? undefined : normalizeToolText(result.error);

      // Miranda: after_tool_run gate
      ctx.gate?.afterToolRun({ tool: call.tool, args: call.input }, { ok: result.ok, output: outputText });

      toolEvents.push({
        tool: call.tool,
        ok: result.ok,
        summary: result.ok
          ? `${call.tool}: ok (${outputText.length} chars)`
          : `${call.tool}: failed — ${result.error ?? "unknown"}`,
        raw: call.input,
      });

      // Capture written content so Pappy can verify the diff.
      if (call.tool === "write_file" && result.ok) {
        const filePath = typeof call.input["path"] === "string" ? call.input["path"] : "";
        const content  = typeof call.input["content"] === "string" ? call.input["content"] : undefined;
        if (filePath) {
          filesChanged.push({ path: filePath, changeType: "A", diff: content });
        }
      }

      console.error(
        `[MaestroAdapter] tool:result ok=${result.ok}  chars=${outputText.length}`,
      );

      conversation += formatToolResult(call.tool, result.ok, outputText, errorText);

      // Completion signal: after a successful write_file, tell the model the
      // task is done. Ask it to output the full written content so the user
      // sees the actual result, not a summary of what was saved.
      if (call.tool === "write_file" && result.ok) {
        const writtenPath = typeof call.input["path"] === "string" ? call.input["path"] : "the file";
        conversation += `\n\nUser: "${writtenPath}" has been written successfully. The task is complete. Output the full content you just wrote so the user can see it. Do not call any more tools.`;
      }
    }
  }

  // Strip any dangling <tool_call> blocks from the final response
  // (can happen if the model starts a call but we hit MAX_ITERATIONS).
  const cleanText = lastText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();

  return { text: cleanText, toolEvents, filesChanged };
}
