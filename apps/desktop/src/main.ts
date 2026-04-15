import "dotenv/config";
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from "electron";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Dewey } from "@clawde/dewey-core";
import { createMirandaGate } from "@clawde/miranda-core";
import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter, LLMMessage as Message } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
  createRunAnalysisWriter,
  createChildPacket,
  registerChildOnRoot,
  appendAHPTrace,
  AHPLifecycle,
  deriveFilesChangedFromToolEvents,
  SqliteStore,
} from "@clawde/orca-core";
import type {
  OrcaRuntime,
  OrcaEvent,
  OrcaEventType,
  MaestroPort,
  OrcaMaestroResult,
  OrcaRunCtx,
  OrcaTaskSpec,
  OrcaLLMService,
  OrcaPipelineTrace,
  OrcaToolService,
  AHPPacket,
} from "@clawde/orca-core";
import { buildToolBootstrap } from "@clawde/tool-bootstrap";
import type { BootstrappedTool } from "@clawde/tool-bootstrap";
import { createBenson } from "@clawde/benson-core";
import {
  createMaestroCore,
  getRolePrompt,
  BRAIN_DECOMPOSE_SYSTEM,
  parseBrainDecision,
  buildSynthesisPrompt,
  BrainDecisionValidationError,
  ModelFallbackPoolManager,
  createSimpleFallbackPool,
  type PoolModelEntry,
} from "maestro-core";
import type {
  RoleName,
  DecomposeDecision,
  DepartmentTask,
} from "maestro-core";
import {
  getAuthView,
  saveAuthConfig,
  verifyAppPassword,
} from "./auth";
import type {
  LocalAuthView,
  SaveLocalAuthInput,
} from "./auth";
import { loadSettings, saveSettings } from "./settings";
import type { OrcaSettings, ProviderEntry, RoleEntry, McpServerConfig } from "./settings";
import { RoleAgentAdapter } from "./agents/RoleAgentAdapter";
import type { AgentRunContext, AgentResult, AgentTask } from "./agents/AgentAdapter";

type AgentTool = {
  name: string;
  description: string;
  schema?: {
    required?: string[];
    properties?: Record<string, { type: string }>;
  };
  execute: (
    input: Record<string, unknown>,
    context: {
      workspaceRoot?: string;
      runId?: string;
      abortSignal?: AbortSignal;
      requestApproval?: (tool: string, args: Record<string, unknown>, reason: string) => Promise<boolean>;
    },
  ) => Promise<{ ok: boolean; output: string; error?: string }>;
};

type AppAuthStatus = LocalAuthView & {
  locked: boolean;
};

function getPipelineTraceDir(): string {
  return join(app.getPath("userData"), "pipeline-traces");
}

function getPipelineTracePath(taskId: string): string {
  return join(getPipelineTraceDir(), `${taskId}.json`);
}

// Run analysis artifacts — written to ORCA_RUNS_DIR (default ~/.orca/runs/)
const runsDir = process.env["ORCA_RUNS_DIR"]?.trim() ??
  join(homedir(), ".orca", "runs");
const analysisWriter = createRunAnalysisWriter(runsDir);

async function writePipelineTrace(trace: OrcaPipelineTrace): Promise<void> {
  const dir = getPipelineTraceDir();
  mkdirSync(dir, { recursive: true });
  const filePath = getPipelineTracePath(trace.taskId);
  await writeFile(filePath, JSON.stringify(trace, null, 2), "utf8");
  console.log(`[Orca]   pipeline:trace    ${filePath}`);
  return analysisWriter.writeTrace(trace);
}

async function readPipelineTrace(taskId: string): Promise<OrcaPipelineTrace | null> {
  const filePath = getPipelineTracePath(taskId);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as OrcaPipelineTrace;
  } catch {
    return null;
  }
}

function normalizeConversationHistory(rawHistory: unknown): Message[] {
  if (!Array.isArray(rawHistory)) return [];

  if (rawHistory.every((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "role" in entry &&
    "content" in entry,
  )) {
    return rawHistory as Message[];
  }

  const normalized: Message[] = [];
  for (const entry of rawHistory) {
    if (!entry || typeof entry !== "object") continue;
    const turn = entry as { user?: unknown; assistant?: unknown };
    if (typeof turn.user === "string" && turn.user.length > 0) {
      normalized.push({ role: "user", content: turn.user });
    }
    if (typeof turn.assistant === "string" && turn.assistant.length > 0) {
      normalized.push({ role: "assistant", content: turn.assistant });
    }
  }

  return normalized;
}

type DesktopBrainRouting =
  | {
      path: "direct";
      role: RoleName;
      doneCriteria: string[];
      brainDecision?: string;
      decision: DecomposeDecision;
    }
  | {
      path: "decompose";
      departments: DepartmentTask[];
      doneCriteria: string[];
      synthesisHint?: string;
      brainDecision?: string;
      decision: DecomposeDecision;
    };

// ── Brain routing helper ───────────────────────────────────────────────────

async function brainRoute(
  task: OrcaTaskSpec,
  ctx: OrcaRunCtx,
  roleAdapters: Partial<Record<RoleName, OrcaLLMService>>,
): Promise<DesktopBrainRouting> {
  const brainLLM = roleAdapters['brain'] ?? ctx.llm;

  // Small, fast JSON call to decide routing. One repair pass on schema validation failure.
  const basePrompt = `${BRAIN_DECOMPOSE_SYSTEM}\n\n---\n\n${buildTaskPrompt(task)}`;
  let decision: DecomposeDecision | null = null;
  let repairReason: string | null = null;
  let brainDecision: string | undefined;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const prompt = repairReason !== null
      ? `${basePrompt}\n\n---REPAIR---\nYour previous response was rejected. Reason: ${repairReason}\n\nFix the error and output ONLY a bare JSON object with no surrounding text.`
      : basePrompt;
    ctx.recordTrace?.("brain.route.prompt", { attempt, prompt });
    let responseText = "";
    try {
      const { text } = await brainLLM.complete(prompt, {
        maxTokens: 512,
        temperature: 0,
        abortSignal: ctx.abortSignal,
      });
      responseText = text;
      ctx.recordTrace?.("brain.route.response", { attempt, text: responseText });
      decision = parseBrainDecision(responseText);
      brainDecision = responseText.trim();
      break;
    } catch (err) {
      if (err instanceof BrainDecisionValidationError) {
        repairReason = err.reason;
        ctx.recordTrace?.("brain.route.validation_error", {
          attempt,
          reason: err.reason,
          text: responseText,
        });
        // Loop continues for one repair attempt.
      } else {
        ctx.recordTrace?.("brain.route.error", {
          attempt,
          error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        break; // Unexpected error — stop retrying.
      }
    }
  }

  const resolved: DecomposeDecision = decision ?? { routing: 'direct', role: 'brain' };
  if (!decision) {
    ctx.recordTrace?.("brain.route.fallback", {
      reason: "brain routing did not yield a valid decision; defaulting to direct brain",
    });
  }
  const doneCriteria = resolved.done_criteria ?? [];
  if (resolved.routing === "decompose") {
    const departments = resolved.departments.slice(0, 3);
    ctx.recordTrace?.("brain.route.final", {
      decision: resolved,
      path: "decompose",
      departments,
      doneCriteria,
      brainDecision,
    });
    return {
      path: "decompose",
      departments,
      synthesisHint: resolved.synthesis_hint,
      doneCriteria,
      brainDecision,
      decision: resolved,
    };
  }

  ctx.recordTrace?.("brain.route.final", {
    decision: resolved,
    path: "direct",
    role: resolved.role,
    doneCriteria,
    brainDecision,
  });

  return {
    path: "direct",
    role: resolved.role as RoleName,
    doneCriteria,
    brainDecision,
    decision: resolved,
  };
}


// ── Maestro adapter ────────────────────────────────────────────────────────
// Three-tier architecture:
// Tier 1: LLMAdapter (raw model calls) - already exists
// Tier 2: ReactAgentAdapter (ReAct loop implementation) 
// Tier 3: RoleAgentAdapter (role-aware wrapper)

function buildMaestroAdapter(
  /** Per-role LLM adapters. Falls back to ctx.llm (brain) when a role has no dedicated entry. */
  configuredAdapters: Map<RoleName, LLMAdapter>,
  availableTools: AgentTool[],
  /** Model entries for fallback support */
  modelEntries?: Map<string, { provider: ProviderEntry; model: string }>,
  /** Fallback pool manager for model selection */
  poolManager?: ModelFallbackPoolManager,
  /** Per-role generation settings sourced from orca-settings.json */
  roleSettings?: Map<RoleName, { maxTokens?: number; temperature?: number }>,
  /** Workspace folder — flows into tool execution so write_file uses the right root */
  workspaceRoot?: string,
  /**
   * Optional per-role static tool allowlists sourced from settings.roles[role].toolsAllowed.
   * Applied on top of the per-task dynamic filter from Benson (ctx.toolNamesAllowed).
   * Omit to allow all tools for all roles.
   */
  roleStaticAllowLists?: Map<RoleName, Set<string>>,
): MaestroPort {
  const maestroCore = createMaestroCore();
  const logger = console;

  // Build one RoleAgentAdapter per configured role
  const roleAgents = new Map<RoleName, RoleAgentAdapter>();
  for (const [role, llmAdapter] of configuredAdapters) {
    const rs = roleSettings?.get(role);
    roleAgents.set(role, new RoleAgentAdapter(role, llmAdapter, undefined, rs?.maxTokens, rs?.temperature));
  }

  /**
   * Tool filtering is applied in four layers (outermost → innermost):
   *
   *  Layer 1 — server.enabled   (bootstrap time, loadMcpExtensions)
   *    MCP servers whose config has `enabled: false` are never connected.
   *
   *  Layer 2 — load success     (bootstrap time, buildToolBootstrap)
   *    Extensions whose onLoad() throws and MCP servers that fail to connect
   *    are silently skipped; their tools never appear in availableTools.
   *
   *  Layer 3 — role allowlist   (call time, settings.roles[role].toolsAllowed)
   *    Permanent per-role restriction. Omitting toolsAllowed means "all tools".
   *    Applied FIRST at call time so the task filter works within the role budget.
   *
   *  Layer 4 — task allowlist   (call time, Benson → ctx.toolNamesAllowed)
   *    Per-task dynamic restriction from intent parsing. Must be a subset of
   *    whatever Layer 3 passes through.
   */
  const selectToolsForRole = (ctx: OrcaRunCtx, role: RoleName): AgentTool[] => {
    // Layer 3: static per-role filter (coarser — permanent role budget)
    let tools = availableTools;
    const staticAllowed = roleStaticAllowLists?.get(role);
    if (staticAllowed) {
      tools = tools.filter((t) => staticAllowed.has(t.name));
    }
    // Layer 4: dynamic per-task filter (finer — Benson intent)
    if (Array.isArray(ctx.toolNamesAllowed)) {
      const taskAllowed = new Set(ctx.toolNamesAllowed);
      tools = tools.filter((t) => taskAllowed.has(t.name));
    }
    return tools;
  };

  const createWorkerPacket = (
    task: OrcaTaskSpec,
    ctx: OrcaRunCtx,
    role: RoleName,
    doneCriteria: string[],
    workerIndex: number,
    objective: string,
  ): AHPPacket | undefined => {
    if (!ctx.ahpRootPacket) return undefined;
    const safeRole = role.replace(/[^a-z0-9_-]/gi, "_");
    const childPacket = createChildPacket(ctx.ahpRootPacket.id, {
      id: `${ctx.runId}_${safeRole}_${workerIndex}_${Date.now().toString(36)}`,
      objective,
      inputs: [
        ...(task.goals ?? []).map((goal, index) => ({
          id: `goal-${index}`,
          type: "goal",
          value: goal,
        })),
        {
          id: "worker-objective",
          type: "subtask",
          value: objective,
        },
      ],
      constraints: Object.entries(task.constraints ?? {}).map(([rule, value]) => ({
        rule,
        enforcer: String(value),
      })),
      expectedOutput: {
        schema: {},
        acceptanceCriteria: doneCriteria.length > 0 ? doneCriteria : [objective],
      },
    });

    registerChildOnRoot(ctx.ahpRootPacket, childPacket);
    appendAHPTrace(childPacket, {
      timestamp: new Date().toISOString(),
      state: AHPLifecycle.PENDING,
      actor: "brain",
      note: `Brain routed desktop task to ${role}`,
    });
    const startedAt = new Date().toISOString();
    childPacket.lifecycle = AHPLifecycle.RUNNING;
    childPacket.meta.startedAt = startedAt;
    childPacket.meta.updatedAt = startedAt;
    appendAHPTrace(childPacket, {
      timestamp: startedAt,
      state: AHPLifecycle.RUNNING,
      actor: "miranda",
      note: "Worker execution authorised",
    });
    ctx.recordTrace?.("ahp.child_packet.created", {
      packet_id: childPacket.id,
      parentPacketId: childPacket.parentPacketId,
      role,
      workerIndex,
      acceptanceCriteria: childPacket.expectedOutput.acceptanceCriteria,
    });
    return childPacket;
  };

  const finalizeWorkerPacket = (
    childPacket: AHPPacket | undefined,
    ctx: OrcaRunCtx,
    role: RoleName,
    result: AgentResult,
  ): void => {
    if (!childPacket) return;
    const finishedAt = new Date().toISOString();
    const lifecycle = result.stoppedBecause === "done"
      ? AHPLifecycle.COMPLETE
      : result.stoppedBecause === "error"
        ? AHPLifecycle.FAILED
        : AHPLifecycle.INCONCLUSIVE;
    childPacket.lifecycle = lifecycle;
    childPacket.meta.completedAt = finishedAt;
    childPacket.meta.updatedAt = finishedAt;
    appendAHPTrace(childPacket, {
      timestamp: finishedAt,
      state: lifecycle,
      actor: role,
      note: `Agent stopped: ${result.stoppedBecause}; iterations=${result.iterationCount}`,
    });
    ctx.recordTrace?.("ahp.child_packet.finalized", {
      packet_id: childPacket.id,
      lifecycle,
      stoppedBecause: result.stoppedBecause,
      iterations: result.iterationCount,
    });
  };

  const selectAgentForRole = (
    role: RoleName,
    ctx: OrcaRunCtx,
  ): { agent: RoleAgentAdapter; selectedModelId: string } => {
    let selectedModelId = `${role}_primary`;
    let agent = roleAgents.get(role) ?? roleAgents.get("brain");
    if (!agent) {
      throw new Error(`No LLM adapter configured for role ${role} or brain`);
    }

    if (poolManager && modelEntries) {
      const selectedModel = poolManager.selectModel(role);
      if (selectedModel) {
        selectedModelId = selectedModel.id;
        const entry = modelEntries.get(selectedModel.id);
        const isPrimary = selectedModel.id === `${role}_primary`;
        if (entry && !isPrimary) {
          const fallbackAdapter = buildAdapterForProvider(entry.provider, entry.model);
          const rs = roleSettings?.get(role);
          agent = new RoleAgentAdapter(role, fallbackAdapter, undefined, rs?.maxTokens, rs?.temperature);
          logger.info(`[Maestro] Pool selected fallback model ${selectedModel.id} for role ${role}`);
        }
        ctx.recordTrace?.("maestro.model_selection", {
          role,
          selectedModelId: selectedModel.id,
          selectedModel,
          configuredEntry: entry,
          applied: !isPrimary && !!entry,
        });
      }
    }

    return { agent, selectedModelId };
  };

  const runRoleWorker = async (
    task: OrcaTaskSpec,
    ctx: OrcaRunCtx,
    role: RoleName,
    agentTask: AgentTask,
    options: {
      workerIndex: number;
      objective: string;
      streamTokens: boolean;
      subagent: boolean;
    },
  ): Promise<{
    role: RoleName;
    subagentId: string;
    objective: string;
    result: AgentResult;
    filesChanged: ReturnType<typeof deriveFilesChangedFromToolEvents>;
    childPacket?: AHPPacket;
  }> => {
    throwIfAborted(ctx.abortSignal);
    const subagentId = `${ctx.runId}:${role}:${options.workerIndex}`;
    const childPacket = createWorkerPacket(
      task,
      ctx,
      role,
      agentTask.doneCriteria,
      options.workerIndex,
      options.objective,
    );
    if (options.subagent) {
      ctx.emit?.({
        type: "subagent:spawned",
        taskId: ctx.runId,
        subagentId,
        role,
        task: options.objective,
      });
    }

    const { agent, selectedModelId } = selectAgentForRole(role, ctx);
    const taskTools = selectToolsForRole(ctx, role);
    if (taskTools.length === 0) {
      logger.warn(`[Maestro] WARNING: No tools passed to ${role} agent — tool calls will not be available`);
    }
    logger.info(`[Maestro] Passing ${taskTools.length} tools to ${role} agent: ${taskTools.map((tool) => tool.name).join(", ")}`);
    ctx.recordTrace?.("maestro.agent_dispatch", {
      role,
      subagentId,
      doneCriteria: agentTask.doneCriteria,
      agentTask,
      tools: taskTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      })),
    });

    const agentCtx: AgentRunContext = {
      ...ctx,
      subagentDepth: options.subagent ? (ctx.subagentDepth ?? 0) + 1 : ctx.subagentDepth,
      workspaceRoot: ctx.workspaceRoot ?? workspaceRoot,
      onStreamToken: options.streamTokens
        ? (chunk: string) => {
            ctx.emit?.({
              type: "stream:token",
              taskId: ctx.runId,
              chunk,
            });
          }
        : undefined,
      onStreamReset: options.streamTokens
        ? () => {
            ctx.emit?.({
              type: "stream:reset",
              taskId: ctx.runId,
            });
          }
        : undefined,
    };

    let result: AgentResult;
    try {
      result = await agent.run(agentTask, taskTools, agentCtx);
    } catch (err) {
      if (isAbortError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      result = {
        outputText: "",
        thoughts: [],
        toolsUsed: [],
        filesChanged: [],
        iterationCount: 0,
        stoppedBecause: "error",
        error: message,
      };
    }
    finalizeWorkerPacket(childPacket, ctx, role, result);

    if (poolManager) {
      if (result.stoppedBecause === "done") {
        poolManager.recordSuccess(role, selectedModelId);
      } else if (result.error) {
        poolManager.recordFailure(role, selectedModelId, result.error);
      }
    }

    const filesChanged = deriveFilesChangedFromToolEvents(result.toolsUsed, result.filesChanged);
    ctx.recordTrace?.("maestro.agent_result", {
      role,
      subagentId,
      result,
      filesChanged,
    });
    if (options.subagent) {
      if (result.stoppedBecause === "error") {
        ctx.emit?.({
          type: "subagent:failed",
          taskId: ctx.runId,
          subagentId,
          role,
          error: result.error ?? "Worker stopped with an error",
        });
      } else {
        ctx.emit?.({
          type: "subagent:done",
          taskId: ctx.runId,
          subagentId,
          role,
          ok: result.stoppedBecause === "done",
        });
      }
    }

    return { role, subagentId, objective: options.objective, result, filesChanged, childPacket };
  };

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      // 1. Classify and score risk (unchanged)
      const { classification, risk } = maestroCore.orchestrate(task.intent);
      ctx.recordTrace?.("maestro.orchestrate", { classification, risk });
      
      // 2. Brain routing call to pick role and done criteria
      // Convert Map<RoleName, LLMAdapter> to Partial<Record<RoleName, OrcaLLMService>>
      // for compatibility with brainRoute function
      const roleAdapters: Partial<Record<RoleName, OrcaLLMService>> = {};
      for (const [role, adapter] of configuredAdapters) {
        roleAdapters[role] = createDirectLLMService(adapter, '', { maxTokens: 8192, temperature: 0.7 });
      }
      
      throwIfAborted(ctx.abortSignal);
      const routing = await brainRoute(task, ctx, roleAdapters);

      // Dewey brief — inject user context into the pipeline event stream.
      // Non-critical: a Dewey failure must never abort the task.
      throwIfAborted(ctx.abortSignal);
      if (dewey) {
        try {
          const brief = await dewey.brief(task.intent);
          ctx.emit?.({
            type: 'dewey:brief',
            taskId: ctx.runId,
            userName:            brief.userName,
            suggestedTone:       brief.suggestedTone,
            relevantPreferences: brief.relevantPreferences,
            relevantContext:     brief.relevantContext,
          });
        } catch (err) {
          ctx.recordTrace?.("dewey.error", {
            error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          });
        }
      }

      if (routing.path === "decompose") {
        const departments: DepartmentTask[] = routing.departments.length > 0
          ? routing.departments
          : [{ head: "brain", subtask: task.intent }];
        ctx.recordTrace?.("maestro.decompose.start", {
          departments,
          doneCriteria: routing.doneCriteria,
          synthesisHint: routing.synthesisHint,
        });

        const workerRuns = await Promise.all(departments.map((department, index) => {
          const role = department.head as RoleName;
          const objective = department.context
            ? `${department.subtask}\n\nContext: ${department.context}`
            : department.subtask;
          const workerTask: AgentTask = {
            intent: department.subtask,
            goals: [department.subtask, ...(department.context ? [department.context] : [])],
            doneCriteria: [department.subtask],
            conversationHistory: normalizeConversationHistory(task.context?.conversationHistory),
          };
          return runRoleWorker(task, ctx, role, workerTask, {
            workerIndex: index,
            objective,
            streamTokens: false,
            subagent: true,
          });
        }));

        const departmentOutputs = workerRuns.map((run) => ({
          head: run.role,
          subtask: run.objective,
          output: run.result.outputText?.trim()
            ? run.result.outputText
            : `[${run.role} stopped: ${run.result.stoppedBecause}${run.result.error ? `; ${run.result.error}` : ""}]`,
        }));
        const synthesisPrompt = buildSynthesisPrompt(
          task.originalUserMessage ?? task.intent,
          departmentOutputs,
          routing.synthesisHint,
        );

        let outputText = "";
        let synthesisError: string | undefined;
        try {
          ctx.emit?.({ type: "stream:reset", taskId: ctx.runId });
          const brainLLM = roleAdapters["brain"] ?? ctx.llm;
          const { text } = await brainLLM.complete(synthesisPrompt, {
            maxTokens: 4096,
            temperature: 0.2,
            abortSignal: ctx.abortSignal,
            onToken: (chunk: string) => {
              ctx.emit?.({
                type: "stream:token",
                taskId: ctx.runId,
                chunk,
              });
            },
          });
          outputText = text.trim();
        } catch (err) {
          if (isAbortError(err)) throw err;
          synthesisError = err instanceof Error ? err.message : String(err);
        }

        if (!outputText) {
          outputText = departmentOutputs
            .map((output) => `## ${output.head}\n${output.output}`)
            .join("\n\n");
        }

        const toolEvents = workerRuns.flatMap((run) => run.result.toolsUsed);
        const filesChanged = deriveFilesChangedFromToolEvents(
          toolEvents,
          workerRuns.flatMap((run) => run.result.filesChanged),
        );
        const childPackets = workerRuns
          .map((run) => run.childPacket)
          .filter((packet): packet is AHPPacket => packet !== undefined);
        const incompleteRuns = workerRuns.filter((run) => run.result.stoppedBecause !== "done");
        const stoppedBecause = synthesisError
          ? "error"
          : incompleteRuns.length > 0
            ? "no_final_output"
            : "done";
        const incompleteError = incompleteRuns
          .map((run) => `${run.role}: ${run.result.stoppedBecause}${run.result.error ? ` (${run.result.error})` : ""}`)
          .join("; ");
        const errorMessage = synthesisError ?? (incompleteError || undefined);

        ctx.recordTrace?.("maestro.decompose.synthesis", {
          workerCount: workerRuns.length,
          incompleteCount: incompleteRuns.length,
          synthesisError,
          outputText,
        });

        return {
          outputText,
          summary: `brain decomposed to ${workerRuns.length} worker(s) — stopped: ${stoppedBecause}`,
          toolEvents,
          filesChanged,
          doneCriteria: routing.doneCriteria,
          metadata: {
            role: "brain",
            brainDecision: routing.brainDecision,
            thoughts: workerRuns.flatMap((run) => run.result.thoughts),
            iterationCount: workerRuns.reduce((sum, run) => sum + run.result.iterationCount, 0),
            stoppedBecause,
            errorMessage,
            filesChanged,
          },
          ahpChildPackets: childPackets,
          subagentRuns: workerRuns.map((run) => ({
            subagentId: run.subagentId,
            role: run.role,
            task: run.objective,
            status: run.result.stoppedBecause === "done" ? "done" : "failed",
            outputText: run.result.outputText,
            error: run.result.error,
          })),
        };
      }

      const agentTask: AgentTask = {
        intent: task.intent,
        goals: task.goals ?? [],
        doneCriteria: routing.doneCriteria,
        conversationHistory: normalizeConversationHistory(task.context?.conversationHistory),
      };
      const worker = await runRoleWorker(task, ctx, routing.role, agentTask, {
        workerIndex: 0,
        objective: task.originalUserMessage ?? task.intent,
        streamTokens: true,
        subagent: false,
      });
      const { result, filesChanged, childPacket } = worker;

      return {
        outputText: result.outputText,
        summary: `${routing.role} agent — ${result.iterationCount} iterations — stopped: ${result.stoppedBecause}`,
        toolEvents: result.toolsUsed,
        filesChanged,
        doneCriteria: routing.doneCriteria,
        metadata: {
          role: routing.role,
          brainDecision: routing.brainDecision,
          thoughts: result.thoughts,
          iterationCount: result.iterationCount,
          stoppedBecause: result.stoppedBecause,
          loopEvidence: result.loopEvidence,
          errorMessage: result.error,
          filesChanged,
        },
        ahpPacket: childPacket,
      };
    }
  };
}

/**
 * Build the task prompt that goes to a specialist role.
 * Includes conversation history, goals, constraints, and any other context.
 */
function buildTaskPrompt(task: OrcaTaskSpec, role?: string): string {
  const isRepair = task.intent === "repair";

  const header = isRepair
    ? "## Repair Task\nYou are fixing defects identified in a previous attempt.\n" +
      "Address every issue listed in the context below without changing unrelated behaviour."
    : role ? `## Task\nRole: **${role}**` : "## Task";

  const lines: string[] = [
    header,
    "",
    "### Request",
    task.originalUserMessage ?? task.intent,
    "",
    "### Goals",
    ...(task.goals?.map((g: string) => `- ${g}`) ?? ['- Complete the task']),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  if (task.context != null && Object.keys(task.context).length > 0) {
    const { hasImages: _hi, errorOutput: _eo, fileCount: _fc, deepPlan: _dp, filePath: _fp, conversationHistory: _ch, ...userCtx } = task.context as Record<string, unknown>;
    const history = normalizeConversationHistory(task.context["conversationHistory"]);
    if (history?.length) {
      lines.push(
        "",
        "### History usage",
        "Resolve references like 'it', 'that file', 'the file you just created', and 'same as before' from the conversation history below before deciding what to do.",
      );
      const transcript = history
        .map((message) => `${String(message.role).toUpperCase()}: ${message.content}`)
        .join("\n\n");
      lines.push("", "### Conversation history", transcript);
    }

    if (Object.keys(userCtx).length > 0) {
      lines.push("", "### Context", JSON.stringify(userCtx, null, 2));
    }
  }

  return lines.join("\n");
}

// ── Orca pod ───────────────────────────────────────────────────────────────

type BensonHandle = ReturnType<typeof createBenson>;

let runtime: OrcaRuntime | null = null;
let benson: BensonHandle | null = null;
let store: SqliteStore | null = null;
let fallbackPoolManager: ModelFallbackPoolManager | null = null;
let dewey: InstanceType<typeof Dewey> | null = null;
let mcpDispose: (() => Promise<void>) | null = null;
let activeAbortResolve: ((error?: string) => void) | null = null;
let activeAbortController: AbortController | null = null;
let appAuthStatus: AppAuthStatus = {
  enabled: false,
  hasPassword: false,
  locked: false,
};
/** Tool names loaded by the most recent successful bootstrap — included in init-status. */
let _bootstrapTools: { all: string[]; mcp: string[] } = { all: [], mcp: [] };
/** Non-fatal warnings from the most recent initOrca (e.g. unconfigured core roles). */
let _initWarnings: string[] = [];

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

function buildAdapterForProvider(
  provider: ProviderEntry,
  model: string,
  enableThinking?: boolean,
): LLMAdapter {
  if (provider.type === 'ollama') {
    return new OllamaAdapter({
      baseUrl:      provider.baseUrl || 'http://localhost:11434',
      defaultModel: model,
    });
  }
  // openrouter, deepseek, siliconflow, openai, anthropic, zai, custom
  return new OpenAICompatAdapter({
    baseUrl:        provider.baseUrl,
    apiKey:         provider.apiKey || undefined,
    defaultModel:   model,
    enableThinking,
  });
}

/**
 * Build fallback pool configuration from settings.
 * Each role can have a primary model and fallback models.
 */
function buildFallbackPoolConfig(s: OrcaSettings): {
  poolManager: ModelFallbackPoolManager;
  modelEntries: Map<string, { provider: ProviderEntry; model: string }>;
} {
  const modelEntries = new Map<string, { provider: ProviderEntry; model: string }>();
  const pools: Partial<Record<RoleName, ReturnType<typeof createSimpleFallbackPool>>> = {};

  const ALL_ROLES: RoleName[] = [
    'brain', 'strong_model', 'cheap_model', 'utility',
    'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader', 'vision',
  ];

  for (const roleName of ALL_ROLES) {
    const roleEntry = s.roles?.[roleName];
    if (!roleEntry?.providerId || !roleEntry?.model) continue;

    const primaryProvider = s.providers?.find((p) => p.id === roleEntry.providerId);
    if (!primaryProvider) continue;

    // Build model entries for this role
    const models: Array<{ id: string; model: string; providerId: string }> = [];

    // Primary model
    const primaryId = `${roleName}_primary`;
    models.push({ id: primaryId, model: roleEntry.model, providerId: roleEntry.providerId });
    modelEntries.set(primaryId, { provider: primaryProvider, model: roleEntry.model });

    // Fallback models
    if (roleEntry.fallbacks) {
      roleEntry.fallbacks.forEach((fallback, index) => {
        const fallbackProvider = s.providers?.find((p) => p.id === fallback.providerId);
        if (!fallbackProvider) return;

        const fallbackId = `${roleName}_fallback_${index}`;
        models.push({ id: fallbackId, model: fallback.model, providerId: fallback.providerId });
        modelEntries.set(fallbackId, { provider: fallbackProvider, model: fallback.model });
      });
    }

    // Create pool for this role
    if (models.length > 0) {
      pools[roleName] = createSimpleFallbackPool(roleName, models);
    }
  }

  const poolManager = new ModelFallbackPoolManager({ pools }, false);
  return { poolManager, modelEntries };
}

/**
 * Serialises concurrent initOrca calls so that saving settings while the
 * initial MCP bootstrap is still running queues the new call rather than
 * running two bootstraps simultaneously (which would race on mcpDispose).
 */
let _initOrcaChain: Promise<string | null> = Promise.resolve(null);

function initOrca(s: OrcaSettings): Promise<string | null> {
  _initOrcaChain = _initOrcaChain.then(() => _initOrcaImpl(s));
  return _initOrcaChain;
}

async function _initOrcaImpl(s: OrcaSettings): Promise<string | null> {
  runtime = null;
  benson  = null;
  fallbackPoolManager = null;
  _initWarnings = [];

  // Dispose any previous MCP connections before re-initialising
  if (mcpDispose) {
    try { await mcpDispose(); } catch { /* best-effort */ }
    mcpDispose = null;
  }

  if (!dewey) {
    dewey = new Dewey();
  }

  // Always initialise the store so session history is accessible even when
  // the brain role isn't configured yet.
  if (!store) {
    store = new SqliteStore(
      join(app.getPath('userData'), 'orca-runs.db')
    );
  }

  const brainRole = s.roles?.['brain'];
  if (!brainRole?.providerId || !brainRole?.model) {
    return "Brain role not configured.\nClick ⚙ Settings → add a provider and assign it to the Brain role.";
  }

  const provider = s.providers?.find((p) => p.id === brainRole.providerId);
  if (!provider) {
    return "Brain role points to an unknown provider.\nClick ⚙ Settings to re-configure.";
  }

  if (provider.type !== 'ollama' && !provider.apiKey) {
    return `Provider "${provider.name}" has no API key.\nClick ⚙ Settings to add it.`;
  }

  try {
    const model = brainRole.model;

    // Build fallback pool configuration
    const { poolManager, modelEntries } = buildFallbackPoolConfig(s);
    fallbackPoolManager = poolManager;

    // Brain is the fallback LLM used by ctx.llm for any role without a
    // dedicated entry in roleAdapters.
    const llm = createDirectLLMService(
      buildAdapterForProvider(provider, model),
      model,
      { maxTokens: 8192, temperature: 0.7 },
    );

    // Build a per-role LLM adapter for every role that has a configured provider + model.
    const ALL_ROLES: RoleName[] = [
      'brain', 'strong_model', 'cheap_model', 'utility',
      'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader', 'vision',
    ];
    const adapterMap = new Map<RoleName, LLMAdapter>();
    for (const roleName of ALL_ROLES) {
      const roleEntry = s.roles?.[roleName];
      if (!roleEntry?.providerId || !roleEntry?.model) continue;
      const roleProv = s.providers?.find((p) => p.id === roleEntry.providerId);
      if (!roleProv) continue;
      if (roleProv.type !== 'ollama' && !roleProv.apiKey) continue;
      adapterMap.set(roleName, buildAdapterForProvider(roleProv, roleEntry.model, roleEntry.enableThinking));
    }

    // Warn if core routing roles are not configured — tasks will silently fall back to brain.
    for (const role of ['strong_model', 'cheap_model'] as const) {
      if (!adapterMap.has(role)) {
        _initWarnings.push(
          `"${role}" role is not configured — tasks will fall back to Brain. ` +
          `Click ⚙ Settings to assign a model.`
        );
      }
    }

    const workspaceRoot = s.workspaceRoot || join(homedir(), "Orca");
    mkdirSync(workspaceRoot, { recursive: true });

    // Inject GITHUB_TOKEN for the ext-github static extension (github_clone_repo, etc.).
    // Primary source: settings.githubToken (dedicated field, always visible in Settings).
    // Fallback: GitHub MCP server PAT (for users who configured it there first).
    const ghMcpServer = s.mcpServers?.find((srv) => srv.id === "github-mcp");
    const ghToken = s.githubToken || ghMcpServer?.env?.["GITHUB_PERSONAL_ACCESS_TOKEN"];
    if (ghToken) {
      process.env["GITHUB_TOKEN"] = ghToken;
    } else {
      delete process.env["GITHUB_TOKEN"];
    }

    // Build unified tool stack: core workbench + ext-* + MCP servers
    const bootstrap = await buildToolBootstrap({
      workspaceRoot,
      mcpServers: s.mcpServers ?? [],
      log: (msg) => console.log(msg),
    });
    mcpDispose = bootstrap.dispose;
    _bootstrapTools = { all: bootstrap.allToolNames, mcp: bootstrap.mcpToolNames };

    // Map BootstrappedTool[] → AgentTool[], threading abort + approval through
    const availableTools: AgentTool[] = bootstrap.allTools.map((tool: BootstrappedTool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      execute(input, context) {
        return tool.execute(input, {
          workspaceRoot: context.workspaceRoot ?? workspaceRoot,
          runId: context.runId ?? '',
          abortSignal: context.abortSignal,
          requestApproval: context.requestApproval,
        });
      },
    }));
    const toolService = bootstrap.toolService;

    // Build per-role static tool allowlists from config
    const roleStaticAllowLists = new Map<RoleName, Set<string>>();
    for (const [roleName, roleEntry] of Object.entries(s.roles ?? {})) {
      if (roleEntry?.toolsAllowed && roleEntry.toolsAllowed.length > 0) {
        roleStaticAllowLists.set(roleName as RoleName, new Set(roleEntry.toolsAllowed));
      }
    }

    // Build per-role generation settings map (maxTokens, temperature) from config
    const roleGenSettings = new Map<RoleName, { maxTokens?: number; temperature?: number }>();
    for (const [roleName, roleEntry] of Object.entries(s.roles ?? {})) {
      if (roleEntry && (roleEntry.maxTokens !== undefined || roleEntry.temperature !== undefined)) {
        roleGenSettings.set(roleName as RoleName, {
          maxTokens:   roleEntry.maxTokens,
          temperature: roleEntry.temperature,
        });
      }
    }

    // Pass model entries to maestro adapter for fallback support
    const maestro = buildMaestroAdapter(
      adapterMap, availableTools, modelEntries, poolManager, roleGenSettings, workspaceRoot,
      roleStaticAllowLists.size > 0 ? roleStaticAllowLists : undefined,
    );
    const pappy   = createPappyPort();

    const gate = createMirandaGate({ verbose: s.verbose === true });
    runtime = createOrcaRuntime({
      maestro,
      pappy,
      llm,
      maxRepairPasses: s.maxRepairPasses,
      tools: toolService,
      store,
      writeTrace: writePipelineTrace,
      requestToolApproval,
      budgetUsd: s.budgetUsd,
      gate,
    });
    analysisWriter.attachRuntime(runtime);
    benson  = createBenson({ executeTask: runtime.executeTask.bind(runtime) });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function emitAuthStatus(): void {
  win?.webContents.send("auth-status", appAuthStatus);
}

function deriveAuthStatus(locked = appAuthStatus.locked): AppAuthStatus {
  const view = getAuthView();
  return {
    ...view,
    locked: view.enabled && view.hasPassword ? locked : false,
  };
}

function setAppAuthStatus(next: AppAuthStatus): AppAuthStatus {
  appAuthStatus = next;
  emitAuthStatus();
  return appAuthStatus;
}

function refreshAuthStatus(locked = appAuthStatus.locked): AppAuthStatus {
  return setAppAuthStatus(deriveAuthStatus(locked));
}

function isAppLocked(): boolean {
  return appAuthStatus.locked;
}

function lockedError(message = "Orca is locked. Unlock the app to continue."): string {
  return message;
}

function getWindowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orca.ico")
    : join(__dirname, "..", "orca.ico");
}

function createTray(): void {
  // Use the light-mark PNG explicitly (white mark on transparent bg) rather
  // than inheriting from the window ICO. Crop to square then resize to 16×16
  // so the mark is never distorted or scaled from a non-square canvas.
  const raw = nativeImage.createFromPath(join(__dirname, "..", "renderer", "orca-logo-dark.png"));
  const { width: w, height: h } = raw.getSize();
  const cropSz = Math.min(w, h);
  const square = raw.crop({ x: Math.floor((w - cropSz) / 2), y: Math.floor((h - cropSz) / 2), width: cropSz, height: cropSz });
  const icon = square.resize({ width: 16, height: 16, quality: "best" });
  tray = new Tray(icon);
  tray.setToolTip("Orca");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Orca",
      click: () => {
        if (win) {
          win.show();
          win.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        tray?.destroy();
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("double-click", () => {
    if (win) {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    } else {
      createWindow();
    }
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width:           660,
    height:          820,
    minWidth:        480,
    minHeight:       500,
    frame:           false,
    transparent:     false,
    backgroundColor: "#0f0f0f",
    roundedCorners:  true,
    hasShadow:       true,
    show:            false,
    center:          true,
    icon:            getWindowIconPath(),
    webPreferences: {
      preload:          join(__dirname, "preload.js"),
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          false,
    },
  });

  win.loadFile(join(__dirname, "..", "renderer", "index.html"));

  win.once("ready-to-show", async () => {
    win!.show();
    win!.focus();
    const settings = await loadSettings();
    const err = await initOrca(settings);
    win!.webContents.send("init-status", { ok: err === null, error: err, tools: _bootstrapTools, warnings: _initWarnings });
    emitAuthStatus();
  });

  // Intercept close → hide to tray instead of destroying the window.
  win.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      win?.hide();
    }
  });

  win.on("maximize",   () => win?.webContents.send("win:maximize-change", true));
  win.on("unmaximize", () => win?.webContents.send("win:maximize-change", false));
  win.on("closed", () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:maximize", () => {
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on("win:close",    () => {
  if (tray) {
    win?.hide();
  } else {
    win?.close();
  }
});

// ── Tool approval: renderer approves/denies each tool call before it runs ──
// When the desktop app runs tools (agent-loop mode), each call sends a
// "tool:request" event to the renderer and blocks until the user responds.
const pendingApprovals = new Map<string, (approved: boolean) => void>();

function resolvePendingApprovals(approved: boolean): void {
  for (const resolve of pendingApprovals.values()) {
    resolve(approved);
  }
  pendingApprovals.clear();
}

function lockApp(): AppAuthStatus {
  resolvePendingApprovals(false);
  if (activeAbortResolve) {
    activeAbortResolve("Locked.");
    activeAbortResolve = null;
  }
  return refreshAuthStatus(true);
}

function unlockApp(password: string): { ok: true; auth: AppAuthStatus } | { ok: false; error: string } {
  if (!appAuthStatus.enabled || !appAuthStatus.hasPassword) {
    return { ok: false, error: "App lock is not enabled." };
  }

  if (!verifyAppPassword(password)) {
    return { ok: false, error: "Incorrect password." };
  }

  return { ok: true, auth: refreshAuthStatus(false) };
}

ipcMain.on("tool:approve", (_ev, { id, approved }: { id: string; approved: boolean }) => {
  pendingApprovals.get(id)?.(approved);
  pendingApprovals.delete(id);
});

/**
 * Ask the renderer to approve a tool call. Returns true if approved.
 * Used by the tool service wiring when tools are added to the desktop adapter.
 */
export function requestToolApproval(
  tool: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (isAppLocked()) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingApprovals.set(id, resolve);
    win?.webContents.send("tool:request", { id, tool, args });
    // Auto-deny after 60 s if the user doesn't respond
    setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        resolve(false);
      }
    }, 60_000);
  });
}

ipcMain.handle("auth:status", () => appAuthStatus);

ipcMain.handle("auth:unlock", (_ev, password: string) => unlockApp(String(password ?? "")));

ipcMain.handle("auth:lock", () => lockApp());

ipcMain.handle("auth:save", (_ev, input: SaveLocalAuthInput) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError("Unlock Orca before changing the app lock.") };
  }

  const result = saveAuthConfig(input);
  if (!result.ok) {
    return result;
  }

  setAppAuthStatus({
    ...result.auth,
    locked: false,
  });
  return result;
});

ipcMain.handle("settings:get", async () => {
  if (isAppLocked()) return null;
  return loadSettings();
});

// ── Workspace folder picker ────────────────────────────────────────────────

ipcMain.handle("workspace:select", async () => {
  if (isAppLocked()) return "";
  if (!win) return "";
  const result = await dialog.showOpenDialog(win, {
    title:      "Select workspace folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.filePaths[0] ?? "";
});

// ── Model discovery ────────────────────────────────────────────────────────

async function fetchModelsFromProvider(
  p: { type: string; baseUrl: string; apiKey: string },
): Promise<string[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (p.apiKey) headers["Authorization"] = `Bearer ${p.apiKey}`;

  if (p.type === "ollama") {
    const base = (p.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const res  = await fetch(`${base}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name).sort();
  }

  if (p.type === "anthropic") {
    // Anthropic exposes GET /v1/models; fall back to a known list if it fails.
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key":         p.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        const ids = (data.data ?? []).map((m) => m.id).sort();
        if (ids.length) return ids;
      }
    } catch { /* fall through to static list */ }
    return [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ];
  }

  // Alibaba Coding Plan: no /models endpoint — return known model list directly.
  if (p.type === "alibaba_coding_plan") {
    return [
      "qwen3.5-plus",
      "qwen3-coder-plus",
      "qwen3-coder-next",
      "qwen3-coder-flash",
      "qwen3-235b-a22b",
      "glm-5",
    ];
  }

  // OpenAI-compatible: GET /models
  const base = (p.baseUrl || "").replace(/\/$/, "");
  const res  = await fetch(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id).sort();
}

ipcMain.handle("models:fetch", async (_ev, p: { type: string; baseUrl: string; apiKey: string }) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError() };
  }

  try {
    const models = await fetchModelsFromProvider(p);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("settings:save", async (_ev, s: OrcaSettings) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError("Unlock Orca before saving settings.") };
  }

  try {
    await saveSettings(s);
    const err = await initOrca(s);
    win?.webContents.send("init-status", { ok: err === null, error: err, tools: _bootstrapTools, warnings: _initWarnings });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Session history ────────────────────────────────────────────────────────

ipcMain.handle("sessions:list", async () => {
  if (isAppLocked()) return [];
  if (!store) return [];
  return store.getRecentRuns(30);
});

ipcMain.handle("session:load", async (_ev, id: string) => {
  if (isAppLocked()) return null;
  if (!store) return null;
  return store.getRun(id);
});

ipcMain.handle("session:trace", async (_ev, id: string) => {
  if (isAppLocked()) return null;
  return readPipelineTrace(id);
});

ipcMain.handle("session:delete", async (_ev, id: string) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError() };
  }

  if (!store) return { ok: false, error: "Store not initialized" };
  try {
    await store.deleteRun(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ── Session resume — restore Benson's conversation history ─────────────────
// The renderer passes the turns it already has in its chat view so that
// subsequent messages pick up context from the previous session.
ipcMain.handle(
  "session:resume",
  (_ev, turns: Array<{ user: string; assistant: string }>) => {
    if (isAppLocked()) return { ok: false, error: lockedError() };
    if (!benson) return { ok: false, error: "Orca is not initialized." };
    if (!Array.isArray(turns)) return { ok: false, error: "turns must be an array." };
    const safe = turns
      .filter((t) => typeof t?.user === "string" && typeof t?.assistant === "string")
      .map((t) => ({ user: t.user, assistant: t.assistant }));
    benson.setHistory(safe);
    return { ok: true, count: safe.length };
  },
);

// ── Abort control for the active task ──────────────────────────────────────
ipcMain.on("task:abort", () => {
  if (activeAbortResolve) {
    console.log("[Orca] ✖ task:abort requested by user");
    resolvePendingApprovals(false);
    activeAbortResolve();
    activeAbortResolve = null;
  }
});

ipcMain.handle("send-message", async (_ev, text: string) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError() };
  }

  // Reject concurrent requests — the agent loop is stateful and cannot safely
  // run two tasks at the same time.  The caller should stop the active task
  // first (task:abort) before sending a new message.
  if (activeAbortController) {
    return { ok: false, error: "A task is already running. Stop it before sending a new message." };
  }

  // If init is still running (MCP servers connecting), wait for it.
  const stillInitializing = _initOrcaChain.then(() => null).catch(() => null);
  await stillInitializing;

  if (!benson || !runtime)
    return { ok: false, error: "Orca is not initialized — open ⚙ Settings to set your API key." };

  const normalizedText = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalizedText) {
    return { ok: false, error: "Message is empty." };
  }

  const abortController = new AbortController();
  activeAbortController = abortController;

  // Build a promise that resolves when the user hits Stop.
  const abortPromise = new Promise<{ ok: false; error: string }>((resolve) => {
    activeAbortResolve = (error = "Stopped.") => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error(error));
      }
      resolve({ ok: false, error });
    };
  });

  const EVENT_TYPES: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result",  "repair:start",  "task:done", "stream:token", "stream:reset",
    "pipeline:summary",
    "dewey:brief", "miranda:checkpoint",
    "subagent:spawned", "subagent:done", "subagent:failed",
  ];
  // Capture pipeline:summary so it can be embedded in the IPC reply — the
  // renderer may receive the invoke response before the orca-event message
  // if they arrive on different IPC channels (race condition on long tasks).
  let capturedPipelineSummary: OrcaEvent | undefined;
  // Track streaming state for dedicated orca:stream-start/chunk/end channels.
  let isStreaming = false;
  let streamRunId = "";
  const unsubs = EVENT_TYPES.map((type) =>
    runtime!.on(type, (e: OrcaEvent) => {
      win?.webContents.send("orca-event", e);
      if (e.type === "pipeline:summary") capturedPipelineSummary = e;
      // ── Console trace ──────────────────────────────────────────────────
      switch (e.type) {
        case "task:start":
          console.log(`\n[Orca] ▶ task:start  intent="${e.intent}"  id=${e.taskId}`);
          break;
        case "maestro:start":
          console.log(`[Orca]   maestro:start  attempt=${e.attempt}  repair=${e.isRepair}`);
          break;
        case "maestro:done":
          console.log(`[Orca]   maestro:done   attempt=${e.attempt}  repair=${e.isRepair}  hasOutput=${e.hasOutput}`);
          break;
        case "qc:result":
          console.log(`[Orca]   qc:result      attempt=${e.attempt}  verdict=${e.verdict}  issues=${e.issueCount}`);
          break;
        case "repair:start":
          console.log(`[Orca]   repair:start   pass=${e.pass}/${e.maxPasses}`);
          break;
        case "subagent:spawned":
          console.log(`[Orca]   worker:start   role=${e.role}  id=${e.subagentId}`);
          break;
        case "subagent:done":
          console.log(`[Orca]   worker:done    role=${e.role}  ok=${e.ok}`);
          break;
        case "subagent:failed":
          console.log(`[Orca]   worker:failed  role=${e.role}  error=${e.error}`);
          break;
        case "task:done":
          console.log(`[Orca] ■ task:done`);
          break;
        case "pipeline:summary":
          console.log(`[Orca]   pipeline:summary  role=${e.role}  verdict=${e.verdict}  confidence=${Math.round(e.confidence * 100)}%  issues=${e.issueCount}  duration=${e.durationMs}ms`);
          break;
        case "stream:token": {
          const te = e as Extract<OrcaEvent, { type: "stream:token" }>;
          if (!isStreaming) {
            isStreaming = true;
            streamRunId = te.taskId;
            win?.webContents.send("orca:stream-start", { runId: te.taskId });
          }
          win?.webContents.send("orca:stream-chunk", { chunk: te.chunk, runId: te.taskId });
          break;
        }
        case "stream:reset": {
          const re = e as Extract<OrcaEvent, { type: "stream:reset" }>;
          if (isStreaming) {
            isStreaming = false;
            win?.webContents.send("orca:stream-end", { runId: re.taskId });
          }
          break;
        }
      }
    }),
  );

  try {
    const taskPromise = benson.handleUserMessage(normalizedText, {
      abortSignal: abortController.signal,
    })
      .then((reply) => ({ ok: true as const, reply }))
      .catch((err) => {
        if (isAbortError(err)) {
          return { ok: false as const, error: err.message || "Stopped." };
        }
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      });

    const result = await Promise.race([
      taskPromise,
      abortPromise,
    ]);
    return { ...result, pipelineSummary: capturedPipelineSummary };
  } finally {
    if (isStreaming) {
      isStreaming = false;
      win?.webContents.send("orca:stream-end", { runId: streamRunId });
    }
    activeAbortResolve = null;   // clean up if task finished naturally
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    // Deny any tool approvals that the renderer never responded to.
    // These are orphaned because the task is over and their tool calls
    // will never execute — leaving them in the map wastes memory and
    // would cause the next task's abort handler to resolve stale entries.
    resolvePendingApprovals(false);
    unsubs.forEach((u) => u());
  }
});

// ── Single-instance lock ────────────────────────────────────────────────────
// If another instance is already running, focus its window and quit this one.

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  app.whenReady().then(() => {
    refreshAuthStatus(true);
    createTray();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // With a tray icon the app stays alive even when all windows are closed.
  app.on("window-all-closed", () => {
    if (process.platform === "darwin") app.quit();
    // On Windows/Linux: do nothing — tray keeps the process alive.
  });
}

// Close SQLite store on quit
app.on("before-quit", () => {
  store?.close();
});

// Close MCP server connections on quit
app.on("will-quit", () => {
  mcpDispose?.().catch(console.error);
});
