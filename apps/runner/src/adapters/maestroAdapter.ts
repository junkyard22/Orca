import * as fs from "fs";
import * as path from "path";
import {
  createMaestroCore,
  selectRole,
  getRolePrompt,
  pickCoreRole as pickCoreRoleFromTask,
  BRAIN_DECOMPOSE_SYSTEM,
  parseBrainDecision,
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
import type { AHPPacket } from "@clawde/miranda-core";
import { AHPLifecycle, transitionAHPLifecycle } from "@clawde/miranda-core";
import { Dewey } from "@clawde/dewey-core";
import type { BrainPlan, UserBrief } from "@clawde/dewey-core";
import type { ExtendedOrcaToolService } from "./toolService.js";
import { traceEvent } from "./tracerHooks.js";

// ---------------------------------------------------------------------------
// MaestroAdapter — wraps maestro-core's MaestroCore to satisfy MaestroPort.
//
// LIVE routing path (post-hardening patch):
//   maestro-core.orchestrate()  →  task classification + risk metadata (sync)
//   routeRequest()              →  Brain-owned single routing entry point:
//     ├─ simple tasks:  heuristic selectRole()/pickCoreRole() → direct decision
//     │                 (no Brain LLM call; zero extra latency for simple asks)
//     └─ complex tasks: ONE Brain LLM call (BRAIN_DECOMPOSE_SYSTEM) → direct
//                       or decompose; Brain's role choice is authoritative here
//   getRolePrompt()             →  load that role's system prompt
//   ctx.llm.complete()          →  actual text generation
//
// Brain owns routing for decompose-candidate tasks. selectRole()/pickCoreRole()
// heuristics are subordinate helpers: used for simple-task direct decisions and
// as a fallback when the Brain LLM call fails.
//
// Maestro never touches a model directly; ctx.llm is the ONLY LLM surface
// it uses. The concrete service (currently directLLM in the runner) is
// injected by the app shell — not Miranda's stage pipeline.
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
 * Returns the path where the Orca desktop app stores its settings.
 * Mirrors Electron's app.getPath("userData") + "orca-settings.json".
 */
function getDesktopSettingsPath(): string {
  const appName = "Orca";
  if (process.platform === "win32") {
    return path.join(process.env["APPDATA"] ?? "", appName, "orca-settings.json");
  } else if (process.platform === "darwin") {
    return path.join(process.env["HOME"] ?? "", "Library", "Application Support", appName, "orca-settings.json");
  }
  return path.join(
    process.env["XDG_CONFIG_HOME"] ?? path.join(process.env["HOME"] ?? "", ".config"),
    appName, "orca-settings.json",
  );
}

/**
 * Load available roles from settings. Preference order:
 *   1. Desktop app settings (AppData/Orca/orca-settings.json) — new provider/role format
 *   2. Root orca-settings.json — legacy runner format
 *   3. Built-in defaults
 *
 * Only role names matter here (for routing decisions). API keys are not read
 * because the desktop app encrypts them with Electron's safeStorage.
 */
function loadRoleSettings(): OrcaSettings {
  // 1. Try desktop app settings (new format: { providers: [...], roles: { name: { providerId, model } } })
  const desktopPath = getDesktopSettingsPath();
  if (fs.existsSync(desktopPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(desktopPath, "utf-8")) as Record<string, unknown>;
      if (Array.isArray(raw["providers"]) && raw["roles"] && typeof raw["roles"] === "object") {
        const providers = raw["providers"] as Array<{ id: string; type?: string }>;
        const rawRoles = raw["roles"] as Record<string, { providerId?: string; model?: string }>;
        const roles: Record<string, RoleSettings> = {};
        for (const [roleName, roleEntry] of Object.entries(rawRoles)) {
          if (roleEntry.providerId && roleEntry.model) {
            const prov = providers.find((p) => p.id === roleEntry.providerId);
            roles[roleName] = { provider: prov?.type ?? "custom", model: roleEntry.model, label: roleName };
          }
        }
        if (Object.keys(roles).length > 0) {
          return { roles };
        }
      }
    } catch {
      // fall through
    }
  }

  // 2. Fall back to root orca-settings.json (legacy runner format: { roles: { name: { provider, model } } })
  try {
    const content = fs.readFileSync(path.join(process.cwd(), "orca-settings.json"), "utf-8");
    return JSON.parse(content) as OrcaSettings;
  } catch {
    // fall through
  }

  // 3. Built-in defaults
  return {
    roles: {
      brain:        { provider: "openrouter", model: "openai/gpt-4o-mini",        label: "GPT-4o Mini" },
      strong_model: { provider: "openrouter", model: "qwen/qwen3-coder-next",      label: "Qwen3 Coder Next" },
      cheap_model:  { provider: "openrouter", model: "qwen/qwen3-coder-next",      label: "Qwen3 Coder Next" },
      utility:      { provider: "openrouter", model: "openai/gpt-4o-mini",         label: "GPT-4o Mini" },
      reviewer:     { provider: "openrouter", model: "deepseek/deepseek-chat",     label: "DeepSeek Chat" },
      narrator:     { provider: "openrouter", model: "qwen/qwen2.5-7b-instruct",   label: "Qwen2.5 7B Instruct" },
    },
  };
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

      // 2. Dewey pre-flight — brief the table before routing.
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

      // 3. Brain-owned routing decision — single entry point for all requests.
      //    Simple tasks: heuristic direct decision, no Brain LLM call.
      //    Decompose-candidate tasks: one Brain LLM call; Brain's decision is authoritative.
      const routing = await routeRequest(task, orch, ctx, settings);
      traceEvent({ type: "brain:route", data: routing });

      // ── AHP packet flow ──────────────────────────────────────────────────
      // Brain creates the packet (PENDING) immediately after the routing
      // decision.  Miranda then authorises execution (PENDING → RUNNING).
      // The packet is threaded through every subsequent role and returned in
      // OrcaMaestroResult so the host runtime can hand it to Pappy.
      const ahpNow = new Date().toISOString();
      const ahpPacket: AHPPacket = {
        id: orch.run_id,
        objective: task.originalUserMessage,
        lifecycle: AHPLifecycle.PENDING,
        inputs: task.goals.map((g, i) => ({ id: `input-${i}`, type: "goal", value: g })),
        constraints: Object.entries(task.constraints ?? {}).map(([rule, value]) => ({
          rule,
          enforcer: String(value),
        })),
        expectedOutput: {
          schema: {},
          acceptanceCriteria: routing.done_criteria ?? task.goals,
        },
        trace: [{
          timestamp: ahpNow,
          state: AHPLifecycle.PENDING,
          actor: "brain",
          note: routing.path === "direct"
            ? `Brain routed direct to role: ${routing.role}`
            : `Brain decomposed into ${routing.subtasks.length} subtask(s)`,
        }],
        meta: { ackRequired: false, createdAt: ahpNow, updatedAt: ahpNow },
      };

      // Miranda: PENDING → RUNNING — authorises tool execution for this run.
      transitionAHPLifecycle(AHPLifecycle.PENDING, AHPLifecycle.RUNNING);
      ahpPacket.lifecycle = AHPLifecycle.RUNNING;
      ahpPacket.trace.push({
        timestamp: new Date().toISOString(),
        state: AHPLifecycle.RUNNING,
        actor: "miranda",
        note: "Lifecycle PENDING→RUNNING; execution authorised",
      });
      ahpPacket.meta.updatedAt = new Date().toISOString();
      traceEvent({ type: "ahp:lifecycle", data: { lifecycle: AHPLifecycle.RUNNING, id: ahpPacket.id } });

      if (routing.path === "decompose") {
        const decomposeResult = await runSubagentPool(task, routing.subtasks, orch, ctx, ahpPacket);
        const allFailed = decomposeResult.subagentRuns?.every((r) => r.status === "failed") ?? false;
        const decomposeState = allFailed ? AHPLifecycle.FAILED : AHPLifecycle.COMPLETE;
        transitionAHPLifecycle(AHPLifecycle.RUNNING, decomposeState);
        ahpPacket.lifecycle = decomposeState;
        ahpPacket.trace.push({
          timestamp: new Date().toISOString(),
          state: decomposeState,
          actor: "maestro",
          note: `Subagent pool complete: ${decomposeResult.subagentRuns?.length ?? 0} agent(s)`,
        });
        ahpPacket.meta.updatedAt = new Date().toISOString();
        traceEvent({ type: "ahp:lifecycle", data: { lifecycle: decomposeState, id: ahpPacket.id } });
        return { ...decomposeResult, ahpPacket };
      }

      const { role, isFallback } = routing;

      // 4. Build candidate plan for Dewey review then run single-agent path.
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
      // Dewey suggestions collected across non-approved passes.
      // Threaded into the agent prompt as advisory notes (not plan mutation).
      const collectedSuggestions: string[] = [];

      while (!approved && attempts < 3) {
        const deweyReview = await dewey.reviewPlan(approvedPlan, task.originalUserMessage, brief);
        traceEvent({ type: "dewey:review", data: deweyReview });

        if (deweyReview.approved) {
          approved = true;
        } else {
          lastConcerns = deweyReview.concerns;
          // Collect suggestions as advisory notes — do not mutate approvedPlan.steps.
          // They will be threaded into the agent prompt via deweyAdvisory, not
          // injected into the plan's goal list (which would be plan mutation).
          for (const s of deweyReview.suggestions) {
            if (!collectedSuggestions.includes(s)) collectedSuggestions.push(s);
          }
          console.error("[Dewey] Pre-flight concerns:", deweyReview.concerns);
          attempts++;
        }
      }

      if (!approved) {
        transitionAHPLifecycle(AHPLifecycle.RUNNING, AHPLifecycle.INCONCLUSIVE);
        ahpPacket.lifecycle = AHPLifecycle.INCONCLUSIVE;
        ahpPacket.trace.push({
          timestamp: new Date().toISOString(),
          state: AHPLifecycle.INCONCLUSIVE,
          actor: "dewey",
          note: `Pre-flight blocked: ${lastConcerns.join("; ")}`,
        });
        ahpPacket.meta.updatedAt = new Date().toISOString();
        return {
          outputText: `I want to make sure I do this right for you. ${lastConcerns.join(" ")}`,
          toolEvents: [],
          filesChanged: [],
          summary: `dewey_review_blocked`,
          ahpPacket,
        };
      }

      // 7. Single-agent path.
      // Pass any Dewey advisory suggestions as non-blocking notes to the agent.
      const result = await runSingleAgent(
        task, role, isFallback, orch, ctx, false, brief,
        collectedSuggestions.length > 0 ? collectedSuggestions : undefined,
        ahpPacket,
      );

      // Transition the packet RUNNING → COMPLETE/FAILED after execution.
      const anyToolFailed = result.toolEvents?.some((e) => !e.ok) ?? false;
      const singleState = anyToolFailed ? AHPLifecycle.FAILED : AHPLifecycle.COMPLETE;
      transitionAHPLifecycle(AHPLifecycle.RUNNING, singleState);
      ahpPacket.lifecycle = singleState;
      ahpPacket.trace.push({
        timestamp: new Date().toISOString(),
        state: singleState,
        actor: "maestro",
        note: `Single-agent execution complete (role: ${role})`,
      });
      ahpPacket.meta.updatedAt = new Date().toISOString();
      traceEvent({ type: "ahp:lifecycle", data: { lifecycle: singleState, id: ahpPacket.id } });

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

      return { ...result, ahpPacket };
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
 *   code/implement     → strong_model
 *   review/audit       → reviewer
 *   utility tasks      → utility
 *   quick edit hints   → cheap_model
 *   default/fallback   → narrator (NOT brain — brain is only for planning)
 */
function pickCoreRole(
  task: OrcaTaskSpec,
  settings: OrcaSettings,
): CoreRoleName {
  const availableRoles = new Set(getAvailableCoreRoles(settings));
  
  // Handle repair tasks first — always route to strong_model
  if (task.intent === "repair") {
    if (availableRoles.has("strong_model")) return "strong_model";
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

/** @internal exported only for validation tests — do not use outside tests. */
export function buildTaskPrompt(
  task: OrcaTaskSpec,
  role: string,
  isFallback: boolean,
  workspaceContext?: WorkspaceContext,
  deweyBrief?: Pick<UserBrief, "suggestedTone" | "relevantPreferences">,
  isSubagent: boolean = false,
  deweyAdvisory?: string[],
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

  // ── Dewey advisory notes ───────────────────────────────────────────────────
  // Non-blocking concerns Dewey raised during pre-flight review.
  // Advisory only — the agent must not treat these as hard requirements.
  if (deweyAdvisory && deweyAdvisory.length > 0) {
    lines.push(
      "",
      "### User Context Notes",
      ...deweyAdvisory.map((note) => `- ${note}`),
    );
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
  deweyAdvisory?: string[],
  ahpPacket?: AHPPacket,
): Promise<OrcaMaestroResult> {
  // Subagents may carry a forcedRole in context (set by runSubagentPool).
  const effectiveRole = (
    typeof task.context?.["forcedRole"] === "string"
      ? task.context["forcedRole"]
      : role
  ) as RoleName;

  // Worker role appends trace entry on receipt of the packet.
  if (ahpPacket) {
    ahpPacket.trace.push({
      timestamp: new Date().toISOString(),
      state: AHPLifecycle.RUNNING,
      actor: effectiveRole,
      note: `Worker role received packet${isSubagent ? " (subagent)" : ""}`,
    });
    ahpPacket.meta.updatedAt = new Date().toISOString();
  }

  const systemPrompt = getRolePrompt(effectiveRole);
  const taskPrompt = buildTaskPrompt(task, effectiveRole, isFallback, ctx.workspaceContext, deweyBrief, isSubagent, deweyAdvisory);

  ctx.recordTrace?.("maestro.role.call", {
    role: effectiveRole,
    systemPrompt,
    taskPrompt,
    isRepair: task.intent === "repair",
    isSubagent,
  });

  let outputText: string;
  let toolEvents: OrcaMaestroResult["toolEvents"] = [];
  let filesChanged: OrcaFileChange[] = [];

  if (ctx.tools) {
    const result = await runAgentLoop(systemPrompt, taskPrompt, ctx.tools, ctx);
    outputText = result.text;
    toolEvents = result.toolEvents;
    filesChanged = result.filesChanged;
  } else {
    const { text } = await ctx.llm.stream(
      `${systemPrompt}\n\n---\n\n${taskPrompt}`,
      { maxTokens: 4096 },
      (chunk) => ctx.emit?.({ type: "stream:token", taskId: ctx.runId, chunk }),
    );
    outputText = text;
  }

  ctx.recordTrace?.("maestro.role.response", {
    role: effectiveRole,
    outputText,
    toolCount: toolEvents?.length ?? 0,
  });

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
 * Pre-filter guard for subagent decomposition.
 *
 * Brain (via packages/maestro-core/src/decompose.ts — BRAIN_DECOMPOSE_SYSTEM)
 * is the authoritative owner of routing and decomposition decisions.
 * This function is a coarse pre-filter only: it gates whether to fire the
 * speculative planner_deep LLM call at all.
 *
 * The previous heuristic fired on generic words like "also", "and", "then",
 * hitting nearly every multi-sentence prompt and burning an unnecessary LLM
 * pre-flight call on single-deliverable tasks. Tightened to require explicit
 * concrete file mentions — a reliable signal that multiple distinct file
 * artifacts are expected and parallel subagents genuinely help.
 */
function shouldDecompose(message: string): boolean {
  // Require > 2 explicitly named concrete filenames. Generic connector words
  // ("also", "and", "then") are not sufficient — they appear in nearly all
  // multi-sentence prompts regardless of whether decomposition is warranted.
  const filePattern = /\b[A-Za-z0-9_-]+\.(ts|js|tsx|jsx|py|json|md|yaml|yml)\b/gi;
  const fileMatches = message.match(filePattern);
  return (fileMatches?.length ?? 0) > 2;
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
  /** Advisory context set by Brain for this specific department. */
  coordinationHint?: string;
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

// ---------------------------------------------------------------------------
// Brain-owned routing decision types (adapter-local; distinct from Brain's
// JSON output schema types in decompose.ts).
// ---------------------------------------------------------------------------

interface MaestroDirectDecision {
  path: "direct";
  role: string;
  isFallback: boolean;
  done_criteria?: string[];
  /** 'heuristic': selectRole() decided, no Brain LLM call.
   *  'brain':     Brain LLM called; Brain's role choice is used. */
  source: "heuristic" | "brain";
}

interface MaestroDecomposeDecision {
  path: "decompose";
  subtasks: DecomposedSubtask[];
  done_criteria?: string[];
  synthesis_hint?: string;
}

/** Union of the two possible routing decisions returned by routeRequest(). */
export type MaestroRoutingDecision = MaestroDirectDecision | MaestroDecomposeDecision;

// ---------------------------------------------------------------------------
// Department → Subtask mapping with sibling coordination context
// ---------------------------------------------------------------------------

/**
 * Map Brain's DepartmentTask array to DecomposedSubtask[] with sibling context.
 *
 * Each subtask receives a list of sibling task descriptions so parallel
 * subagents are aware of what other agents are producing.
 *
 * @internal exported for validation tests only.
 */
export function mapDepartmentsToSubtasks(
  departments: Array<{ head: string; subtask: string; context?: string }>,
): DecomposedSubtask[] {
  const siblingDescriptions = departments.map(
    (d) => `${d.head}: ${d.subtask.slice(0, 80)}`,
  );
  return departments.map((dept, i) => ({
    role: dept.head,
    task: dept.subtask,
    // Each subtask knows every other department's brief description.
    siblings: siblingDescriptions.filter((_, j) => j !== i),
    // Thread Brain's advisory context for this department through to the prompt.
    coordinationHint: dept.context,
  }));
}

// ---------------------------------------------------------------------------
// Brain-owned routing entry point
// ---------------------------------------------------------------------------

/**
 * The single authoritative routing function — every request passes through here.
 *
 * Decision flow:
 *   1. Heuristic gate (shouldDecompose): if the task clearly does not need
 *      decomposition, return a direct decision immediately — no Brain LLM call,
 *      no added latency for simple requests.
 *   2. If gate passes: make ONE Brain LLM call using BRAIN_DECOMPOSE_SYSTEM.
 *      Brain decides "direct" (returns its own role choice, takes precedence
 *      over heuristic) or "decompose" (returns a department list with sibling
 *      context populated via mapDepartmentsToSubtasks).
 *   3. If Brain call fails: fall back to heuristic direct decision.
 *
 * Consolidates the previously split selectRole()/pickCoreRole() +
 * shouldAttemptSubagentDecomposition()/decomposeTask() paths. Helpers are
 * invoked from here and are subordinate to this entry point.
 */
async function routeRequest(
  task: OrcaTaskSpec,
  orch: OrchestrationResult,
  ctx: OrcaRunCtx,
  settings: OrcaSettings,
): Promise<MaestroRoutingDecision> {
  // Compute heuristic role — always needed (direct result or Brain-call fallback).
  const roleCtx = buildRoleSelectorContext(task);
  const coreRole = pickCoreRole(task, settings);
  const { role: heuristicRole, isFallback, warning } = selectRole(
    roleCtx,
    ALL_OPTIONAL_ROLES,
    coreRole,
  );
  if (warning) {
    console.warn(`[MaestroAdapter] Role warning: ${warning}`);
  }

  // Heuristic gate: skip Brain LLM call for tasks that clearly don't need
  // decomposition. Identical logic to shouldAttemptSubagentDecomposition().
  const depth = ctx.subagentDepth ?? 0;
  const isReadOnly = Boolean(
    task.permissions && !task.permissions.fileWrite && !task.permissions.shellExec,
  );
  const isDecomposeCandidate =
    depth === 0 &&
    !isReadOnly &&
    orch.classification.multiStep &&
    shouldDecompose(task.originalUserMessage);

  if (!isDecomposeCandidate) {
    // Heuristic direct decision — no Brain LLM call needed.
    return { path: "direct", role: heuristicRole, isFallback, source: "heuristic" };
  }

  // Brain routing call — one LLM call decides direct vs. decompose.
  // Brain's role choice (direct path) takes precedence over the heuristic role.
  try {
    const { text } = await ctx.llm.complete(
      `${BRAIN_DECOMPOSE_SYSTEM}\n\n---\n\n${task.originalUserMessage}`,
      { maxTokens: 1024, simple: true },
    );

    const decision = parseBrainDecision(text);

    if (decision.routing === "direct") {
      return {
        path: "direct",
        role: decision.role,
        isFallback: false,
        done_criteria: decision.done_criteria,
        source: "brain",
      };
    }

    // Brain decided decompose — map departments to subtasks with sibling context.
    return {
      path: "decompose",
      subtasks: mapDepartmentsToSubtasks(decision.departments),
      done_criteria: decision.done_criteria,
      synthesis_hint: decision.synthesis_hint,
    };
  } catch {
    // Brain call failed — fall back to heuristic direct decision.
    traceEvent({ type: "brain:route_fallback", data: { reason: "brain_decision_failed", heuristicRole } });
    return { path: "direct", role: heuristicRole, isFallback: true, source: "heuristic" };
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
  ahpPacket?: AHPPacket,
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
    // st.siblings is populated by mapDepartmentsToSubtasks() when Brain routed.
    // siblingFiles fallback covers manually-constructed DecomposedSubtask[] with outputPath.
    siblings: st.siblings || siblingFiles.filter((f) => f !== path.basename(st.outputPath || "")),
    dependedOnBy: st.dependedOnBy,
    coordinationHint: st.coordinationHint,
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
    // Build coordination context for this subagent.
    const coordinationContext: Record<string, unknown> = {
      forcedRole: agent.role,
    };
    if (agent.outputPath) {
      coordinationContext.outputPath = agent.outputPath;
    }

    // Inject coordination context whenever multiple subagents run in parallel.
    // Previously gated on outputPath, which Brain routing never provides.
    // Now fires unconditionally for multi-agent pools — derives sibling context
    // from mapDepartmentsToSubtasks() siblings or task descriptions as fallback.
    if (agents.length > 1) {
      const siblingRefs = agents
        .filter((a) => a.subagentId !== agent.subagentId)
        .map((a) => `${a.role}: ${a.task.slice(0, 80)}`);
      const siblingList =
        agent.siblings && agent.siblings.length > 0 ? agent.siblings : siblingRefs;
      coordinationContext.coordination = {
        siblings: siblingList,
        exportName: agent.exportName,
        dependedOnBy: agent.dependedOnBy,
        message:
          `You are one of ${agents.length} parallel agents working on this task. ` +
          `Other agents are handling: ${siblingRefs.join("; ")}.` +
          (agent.coordinationHint ? ` Context: ${agent.coordinationHint}` : ""),
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
        undefined, // deweyBrief
        undefined, // deweyAdvisory
        ahpPacket,
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
  const MAX_ITERATIONS = 5;
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
    const { text } = await ctx.llm.stream(
      conversation,
      { maxTokens: 4096, simple: true },
      (chunk) => ctx.emit?.({ type: "stream:token", taskId: ctx.runId, chunk }),
    );
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

      ctx.recordTrace?.("tool.call", { tool: call.tool, input: call.input });
      const result = await tools.execute(call.tool, call.input);
      const outputText = normalizeToolText(result.output);
      const errorText = result.error === undefined ? undefined : normalizeToolText(result.error);
      ctx.recordTrace?.("tool.result", { tool: call.tool, ok: result.ok, output: outputText, error: errorText });

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

  return { text: cleanText, toolEvents, filesChanged };
}
