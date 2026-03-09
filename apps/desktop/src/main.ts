import "dotenv/config";
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "node:path";

import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
  createPappyPort,
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
} from "maestro-core";
import type {
  RoleName,
  DecomposeDecision,
} from "maestro-core";
import { loadSettings, saveSettings } from "./settings";
import type { OrcaSettings, ProviderEntry, RoleEntry } from "./settings";
import { RoleAgentAdapter } from "./agents/RoleAgentAdapter";

// ── Brain routing helper ───────────────────────────────────────────────────

async function brainRoute(
  task: OrcaTaskSpec,
  ctx: OrcaRunCtx,
  roleAdapters: Partial<Record<RoleName, OrcaLLMService>>,
): Promise<{ role: RoleName; doneCriteria: string[] }> {
  const maestro = createMaestroCore();
  const brainLLM = roleAdapters['brain'] ?? ctx.llm;

  // Small, fast JSON call to decide routing & department assignment.
  let decision: DecomposeDecision;
  try {
    const { text: decisionJson } = await brainLLM.complete(
      `${BRAIN_DECOMPOSE_SYSTEM}\n\n---\n\n${buildTaskPrompt(task)}`,
      { maxTokens: 512, temperature: 0 },
    );
    decision = parseBrainDecision(decisionJson);
  } catch {
    // If Brain's JSON is malformed, fall back to direct brain.
    decision = { routing: 'direct', role: 'brain' };
  }

  // For now, we only handle direct routing in the new architecture
  // Decompose routing would need to be handled differently in the future
  const role = decision.routing === 'direct' ? decision.role : 'brain';
  const doneCriteria = decision.done_criteria || [];
  
  return { role: role as RoleName, doneCriteria };
}

// ── Agent loop helpers (tool call parsing + multi-turn execution) ──────────

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseToolCalls(text: string): Array<{ tool: string; input: Record<string, unknown> }> {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  // Strict: closed <tool_call>...</tool_call>
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

// ── Maestro adapter ────────────────────────────────────────────────────────
// Three-tier architecture:
// Tier 1: LLMAdapter (raw model calls) - already exists
// Tier 2: ReactAgentAdapter (ReAct loop implementation) 
// Tier 3: RoleAgentAdapter (role-aware wrapper)

function buildMaestroAdapter(
  /** Per-role LLM adapters. Falls back to ctx.llm (brain) when a role has no dedicated entry. */
  configuredAdapters: Map<RoleName, LLMAdapter>,
): MaestroPort {
  const maestroCore = createMaestroCore();

  // Build one RoleAgentAdapter per configured role
  const roleAgents = new Map<RoleName, RoleAgentAdapter>();
  for (const [role, llmAdapter] of configuredAdapters) {
    roleAgents.set(role, new RoleAgentAdapter(role, llmAdapter));
  }

  // Helper function to get available tools
  function getAvailableTools(): any[] {
    // This should return the actual tools available in the system
    // For now, returning an empty array as a placeholder
    // In a real implementation, this would access the tool registry
    return [];
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
        roleAdapters[role] = createDirectLLMService(adapter, 'model', { maxTokens: 8192, temperature: 0.7 });
      }
      
      const routing = await brainRoute(task, ctx, roleAdapters);
      
      // 3. Get the agent for the selected role
      const agent = roleAgents.get(routing.role) ?? roleAgents.get('brain')!;
      
      // 4. Hand off to the agent — it runs autonomously until done
      const result = await agent.run(
        {
          intent: task.intent,
          goals: task.goals,
          doneCriteria: routing.doneCriteria,
          conversationHistory: task.context?.conversationHistory as any[],
        },
        getAvailableTools(),
        ctx
      );
      
      // 5. Map AgentResult → OrcaMaestroResult
      return {
        outputText: result.outputText,
        summary: `${routing.role} agent — ${result.iterationCount} iterations — stopped: ${result.stoppedBecause}`,
        toolEvents: result.toolsUsed,
        filesChanged: result.filesChanged,
        doneCriteria: routing.doneCriteria
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
    task.originalUserMessage,
    "",
    "### Goals",
    ...task.goals.map((g: string) => `- ${g}`),
  ];

  if (task.constraints != null && Object.keys(task.constraints).length > 0) {
    lines.push("", "### Constraints", JSON.stringify(task.constraints, null, 2));
  }

  if (task.context != null && Object.keys(task.context).length > 0) {
    const { hasImages: _hi, errorOutput: _eo, fileCount: _fc, deepPlan: _dp, filePath: _fp, conversationHistory: _ch, ...userCtx } = task.context as Record<string, unknown>;

    const history = task.context["conversationHistory"] as Array<{ user: string; assistant: string }> | undefined;
    if (history?.length) {
      const transcript = history
        .map((t) => `USER: ${t.user}\nASSISTANT: ${t.assistant}`)
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

function buildAdapterForProvider(provider: ProviderEntry, model: string): LLMAdapter {
  if (provider.type === 'ollama') {
    return new OllamaAdapter({
      baseUrl:      provider.baseUrl || 'http://localhost:11434',
      defaultModel: model,
    });
  }
  // openrouter, deepseek, siliconflow, openai, anthropic, zai, custom
  return new OpenAICompatAdapter({
    baseUrl:      provider.baseUrl,
    apiKey:       provider.apiKey || undefined,
    defaultModel: model,
  });
}

function initOrca(s: OrcaSettings): string | null {
  runtime = null;
  benson  = null;

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

    // Brain is the fallback LLM used by ctx.llm for any role without a
    // dedicated entry in roleAdapters.
    const llm = createDirectLLMService(
      buildAdapterForProvider(provider, model),
      model,
      { maxTokens: 8192, temperature: 0.7 },
    );

    // Build a per-role LLM service for every role that has a configured
    // provider + model in settings.  Roles that share the same provider/model
    // as brain will reuse the same adapter instance.
    const roleAdapters: Partial<Record<string, OrcaLLMService>> = {};
    const ALL_ROLES = [
      'brain', 'coder_strong', 'coder_cheap', 'utility',
      'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader', 'vision',
    ] as const;
    for (const roleName of ALL_ROLES) {
      const roleEntry = s.roles?.[roleName];
      if (!roleEntry?.providerId || !roleEntry?.model) continue;
      const roleProv = s.providers?.find((p) => p.id === roleEntry.providerId);
      if (!roleProv) continue;
      if (roleProv.type !== 'ollama' && !roleProv.apiKey) continue;
      roleAdapters[roleName] = createDirectLLMService(
        buildAdapterForProvider(roleProv, roleEntry.model),
        roleEntry.model,
        { maxTokens: 8192, temperature: 0.7 },
      );
    }

    // Convert roleAdapters to Map<RoleName, LLMAdapter> for buildMaestroAdapter
    const adapterMap = new Map<RoleName, LLMAdapter>();
    for (const [role, service] of Object.entries(roleAdapters)) {
      // Extract the underlying LLMAdapter from the OrcaLLMService wrapper
      // This is a bit hacky but works with the current structure
      const roleName = role as RoleName;
      // We need to get the original adapter - for now we'll use brain's adapter as fallback
      if (roleName === 'brain') {
        adapterMap.set(roleName, buildAdapterForProvider(provider, model));
      }
    }
    // Add other configured roles
    const ALL_ROLES_LIST = [
      'brain', 'coder_strong', 'coder_cheap', 'utility',
      'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader', 'vision',
    ] as RoleName[];
    for (const roleName of ALL_ROLES_LIST) {
      if (!adapterMap.has(roleName) && s.roles?.[roleName]?.providerId && s.roles?.[roleName]?.model) {
        const roleProv = s.providers?.find((p) => p.id === s.roles![roleName]!.providerId);
        if (roleProv) {
          adapterMap.set(roleName, buildAdapterForProvider(roleProv, s.roles![roleName]!.model!));
        }
      }
    }
    
    const maestro = buildMaestroAdapter(adapterMap);
    const pappy   = createPappyPort();

    const toolRegistry = createCoreToolRegistry();
    const workspaceRoot = s.workspaceRoot || process.cwd();
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

    // Create SQLite store for persistence
    const store = new SqliteStore(
      join(app.getPath('userData'), 'orca-runs.db')
    );

    runtime = createOrcaRuntime({ maestro, pappy, llm, maxRepairPasses: 2, tools: toolService, store });
    benson  = createBenson({ executeTask: runtime.executeTask.bind(runtime) });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;

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
  });

  win.on("closed", () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:close",    () => win?.close());

// ── Tool approval: renderer approves/denies each tool call before it runs ──
// When the desktop app runs tools (agent-loop mode), each call sends a
// "tool:request" event to the renderer and blocks until the user responds.
const pendingApprovals = new Map<string, (approved: boolean) => void>();

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

ipcMain.handle("settings:get", () => loadSettings());

// ── Workspace folder picker ────────────────────────────────────────────────

ipcMain.handle("workspace:select", async () => {
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
  try {
    const models = await fetchModelsFromProvider(p);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("settings:save", async (_ev, s: OrcaSettings) => {
  try {
    saveSettings(s);
    const err = initOrca(s);
    win?.webContents.send("init-status", { ok: err === null, error: err });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("send-message", async (_ev, text: string) => {
  if (!benson || !runtime)
    return { ok: false, error: "Orca is not initialized — open ⚙ Settings to set your API key." };

  const EVENT_TYPES: OrcaEventType[] = [
    "task:start", "maestro:start", "maestro:done",
    "qc:result",  "repair:start",  "task:done", "stream:token", "stream:reset",
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
      }
    }),
  );

  try {
    const reply = await benson.handleUserMessage(text);
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    unsubs.forEach((u) => u());
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
