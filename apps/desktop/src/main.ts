import "dotenv/config";
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";

import { Dewey } from "@clawde/dewey-core";
import { createMirandaGate } from "@clawde/miranda-core";
import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter, LLMMessage as Message } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
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
  OrcaToolService,
} from "@clawde/orca-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
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
import type { OrcaSettings, ProviderEntry, RoleEntry } from "./settings";
import { RoleAgentAdapter } from "./agents/RoleAgentAdapter";
import type { AgentRunContext } from "./agents/AgentAdapter";

type AgentTool = {
  name: string;
  description: string;
  execute: (input: Record<string, unknown>, context: { workspaceRoot?: string; runId?: string }) => Promise<{ ok: boolean; output: string; error?: string }>;
};

type AppAuthStatus = LocalAuthView & {
  locked: boolean;
};

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

// ── Brain routing helper ───────────────────────────────────────────────────

async function brainRoute(
  task: OrcaTaskSpec,
  ctx: OrcaRunCtx,
  roleAdapters: Partial<Record<RoleName, OrcaLLMService>>,
): Promise<{ role: RoleName; doneCriteria: string[]; brainDecision?: string }> {
  const maestro = createMaestroCore();
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
    try {
      const { text } = await brainLLM.complete(prompt, { maxTokens: 512, temperature: 0 });
      decision = parseBrainDecision(text);
      brainDecision = text.trim();
      break;
    } catch (err) {
      if (err instanceof BrainDecisionValidationError) {
        repairReason = err.reason;
        // Loop continues for one repair attempt.
      } else {
        break; // Unexpected error — stop retrying.
      }
    }
  }

  // For now, we only handle direct routing in the new architecture
  // Decompose routing would need to be handled differently in the future
  const resolved = decision ?? { routing: 'direct' as const, role: 'brain' as const };
  const role = resolved.routing === 'direct' ? resolved.role : 'brain';
  const doneCriteria = resolved.done_criteria ?? [];

  return { role: role as RoleName, doneCriteria, brainDecision };
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
): MaestroPort {
  const maestroCore = createMaestroCore();
  const logger = console;

  // Build one RoleAgentAdapter per configured role
  const roleAgents = new Map<RoleName, RoleAgentAdapter>();
  for (const [role, llmAdapter] of configuredAdapters) {
    const rs = roleSettings?.get(role);
    roleAgents.set(role, new RoleAgentAdapter(role, llmAdapter, undefined, rs?.maxTokens, rs?.temperature));
  }

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      // 1. Classify and score risk (unchanged)
      const { classification, risk } = maestroCore.orchestrate(task.intent);
      
      // 2. Brain routing call to pick role and done criteria
      // Convert Map<RoleName, LLMAdapter> to Partial<Record<RoleName, OrcaLLMService>>
      // for compatibility with brainRoute function
      const roleAdapters: Partial<Record<RoleName, OrcaLLMService>> = {};
      for (const [role, adapter] of configuredAdapters) {
        roleAdapters[role] = createDirectLLMService(adapter, '', { maxTokens: 8192, temperature: 0.7 });
      }
      
      const routing = await brainRoute(task, ctx, roleAdapters);

      // Dewey brief — inject user context into the pipeline event stream.
      // Non-critical: a Dewey failure must never abort the task.
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
        } catch { /* non-critical */ }
      }

      // 3. Select model from fallback pool if available
      if (poolManager && modelEntries) {
        const selectedModel = poolManager.selectModel(routing.role);
        if (selectedModel) {
          const entry = modelEntries.get(selectedModel.id);
          if (entry) {
            logger.info(`[Maestro] Selected model ${selectedModel.id} for role ${routing.role}`);
          }
        }
      }
      
      // 4. Get the agent for the selected role
      const agent = roleAgents.get(routing.role) ?? roleAgents.get('brain')!;

      if (!availableTools || availableTools.length === 0) {
        logger.warn(`[Maestro] WARNING: No tools passed to ${routing.role} agent — tool calls will not be available`);
      }
      logger.info(`[Maestro] Passing ${availableTools.length} tools to ${routing.role} agent: ${availableTools.map((tool) => tool.name).join(', ')}`);
      
      // 5. Build agent context with streaming support
      const agentCtx: AgentRunContext = {
        ...ctx,
        workspaceRoot: workspaceRoot,   // ensure configured folder flows into tool execution
        onStreamToken: (chunk: string) => {
          // Emit stream:token event to renderer
          ctx.emit?.({
            type: 'stream:token',
            taskId: ctx.runId,
            chunk,
          });
        },
        onStreamReset: () => {
          // Emit stream:reset event to renderer
          ctx.emit?.({
            type: 'stream:reset',
            taskId: ctx.runId,
          });
        },
      };
      
      // 6. Hand off to the agent — it runs autonomously until done
      const result = await agent.run(
        {
          intent: task.intent,
          goals: task.goals ?? [],
          doneCriteria: routing.doneCriteria,
          conversationHistory: normalizeConversationHistory(task.context?.conversationHistory),
        },
        availableTools,
        agentCtx
      );

      // 7. Record success/failure to fallback pool manager
      if (poolManager) {
        if (result.stoppedBecause === 'done') {
          poolManager.recordSuccess(routing.role, `${routing.role}_primary`);
        } else if (result.error) {
          poolManager.recordFailure(routing.role, `${routing.role}_primary`, result.error);
        }
      }

      const filesChanged = deriveFilesChangedFromToolEvents(result.toolsUsed, result.filesChanged);
      
      // 8. Map AgentResult → OrcaMaestroResult
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
          filesChanged,
        },
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
let activeAbortResolve: ((error?: string) => void) | null = null;
let appAuthStatus: AppAuthStatus = {
  enabled: false,
  hasPassword: false,
  locked: false,
};

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
    'brain', 'coder_strong', 'coder_cheap', 'utility',
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

function initOrca(s: OrcaSettings): string | null {
  runtime = null;
  benson  = null;
  fallbackPoolManager = null;

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
      'brain', 'coder_strong', 'coder_cheap', 'utility',
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
    
    const toolRegistry = createCoreToolRegistry();
    const workspaceRoot = s.workspaceRoot || process.cwd();
    const availableTools: AgentTool[] = toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      execute(input, context) {
        return tool.execute(input, {
          workspaceRoot: context.workspaceRoot ?? workspaceRoot,
          runId: context.runId ?? '',
        });
      },
    }));
    const toolService: OrcaToolService = {
      execute(name, input) {
        const tool = toolRegistry.get(name);
        if (!tool) return Promise.resolve({
          ok: false, output: '',
          error: `Unknown tool: "${name}". Available: ${toolRegistry.list().map(t => t.name).join(', ')}`,
        });
        return tool.execute(input, { workspaceRoot, runId: '' });
      },
      formatForPrompt() {
        return `Workspace root: ${workspaceRoot}\n\n${toolRegistry.formatForPrompt()}`;
      },
    };

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
    const maestro = buildMaestroAdapter(adapterMap, availableTools, modelEntries, poolManager, roleGenSettings, workspaceRoot);
    const pappy   = createPappyPort();

    const gate = createMirandaGate({ verbose: false });
    runtime = createOrcaRuntime({ maestro, pappy, llm, maxRepairPasses: 2, tools: toolService, store, requestToolApproval, budgetUsd: s.budgetUsd, gate });
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

  win.once("ready-to-show", () => {
    win!.show();
    win!.focus();
    const settings = loadSettings();
    const err = initOrca(settings);
    win!.webContents.send("init-status", { ok: err === null, error: err });
    emitAuthStatus();
  });

  // Intercept close → hide to tray instead of destroying the window.
  win.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      win?.hide();
    }
  });

  win.on("closed", () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.on("win:minimize", () => win?.minimize());
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

ipcMain.handle("settings:get", () => {
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
    saveSettings(s);
    const err = initOrca(s);
    win?.webContents.send("init-status", { ok: err === null, error: err });
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

// ── Abort control for the active task ──────────────────────────────────────
ipcMain.on("task:abort", () => {
  if (activeAbortResolve) {
    console.log("[Orca] ✖ task:abort requested by user");
    activeAbortResolve();
    activeAbortResolve = null;
  }
});

ipcMain.handle("send-message", async (_ev, text: string) => {
  if (isAppLocked()) {
    return { ok: false, error: lockedError() };
  }
  if (!benson || !runtime)
    return { ok: false, error: "Orca is not initialized — open ⚙ Settings to set your API key." };

  const normalizedText = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalizedText) {
    return { ok: false, error: "Message is empty." };
  }

  // Build a promise that resolves when the user hits Stop.
  const abortPromise = new Promise<{ ok: false; error: string }>((resolve) => {
    activeAbortResolve = (error = "Stopped.") => resolve({ ok: false, error });
  });

  const EVENT_TYPES: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result",  "repair:start",  "task:done", "stream:token", "stream:reset",
    "pipeline:summary",
    "dewey:brief", "miranda:checkpoint",
  ];
  const unsubs = EVENT_TYPES.map((type) =>
    runtime!.on(type, (e: OrcaEvent) => {
      win?.webContents.send("orca-event", e);
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
        case "task:done":
          console.log(`[Orca] ■ task:done`);
          break;
        case "pipeline:summary":
          console.log(`[Orca]   pipeline:summary  role=${e.role}  verdict=${e.verdict}  confidence=${Math.round(e.confidence * 100)}%  issues=${e.issueCount}  duration=${e.durationMs}ms`);
          break;
      }
    }),
  );

  try {
    const result = await Promise.race([
      benson.handleUserMessage(normalizedText).then((reply) => ({ ok: true as const, reply })),
      abortPromise,
    ]);
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    activeAbortResolve = null;   // clean up if task finished naturally
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
