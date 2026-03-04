import "dotenv/config";
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

import { OllamaAdapter, OpenAICompatAdapter, createDefaultConfig } from "@clawde/miranda-core";
import type { LLMAdapter, ModelSpec } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createMirandaLLMService,
  createPappyPort,
} from "@clawde/orca-core";
import type {
  OrcaRuntime,
  OrcaEvent,
  OrcaEventType,
  MaestroPort,
  OrcaMaestroResult,
  OrcaRunCtx,
  OrcaTaskSpec,
} from "@clawde/orca-core";
import { createBenson } from "@clawde/benson-core";
import {
  createMaestroCore,
  selectRole,
  getRolePrompt,
} from "maestro-core";
import type {
  RoleName,
  OptionalRoleName,
  TaskContext as RoleSelectorContext,
} from "maestro-core";
import { loadSettings, saveSettings } from "./settings";
import type { OrcaSettings, ProviderEntry, RoleEntry } from "./settings";

// ── Maestro adapter ────────────────────────────────────────────────────────
// Uses shared maestro-core orchestration with RoleSelector integration.
// Mirrors the implementation in apps/runner/src/adapters/maestroAdapter.ts.

const ALL_OPTIONAL_ROLES = new Set<OptionalRoleName>([
  "planner_deep",
  "debugger",
  "reader",
  "vision",
]);

function buildMaestroAdapter(): MaestroPort {
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

      // Notify the renderer which role will handle this request.
      win?.webContents.send("orca-event", { type: "role:selected", taskId: ctx.runId, role, isFallback });

      // 4. Load system prompt for the selected role.
      const systemPrompt = getRolePrompt(role as RoleName);

      // 5. Build the full task prompt.
      const taskPrompt = buildTaskPrompt(task, role, isFallback);

      // 6. Delegate to ctx.llm — the Miranda PLAN→ANSWER→CRITIQUE→REWRITE
      //    pipeline. This is the ONLY model surface Maestro touches.
      //    Pass onToken so streaming tokens are forwarded to the renderer
      //    via the stream:token event, letting the UI show live output.
      const { text } = await ctx.llm.complete(
        `${systemPrompt}\n\n---\n\n${taskPrompt}`,
        {
          maxTokens: 4096,
          onToken: ctx.emit
            ? (chunk: string) =>
                ctx.emit!({ type: "stream:token", taskId: ctx.runId, chunk })
            : undefined,
          onStreamReset: ctx.emit
            ? () =>
                ctx.emit!({ type: "stream:reset", taskId: ctx.runId })
            : undefined,
        },
      );

      // Emit rough token estimate for the cost/stats pill in the renderer.
      const inputTokensEst  = Math.ceil((systemPrompt.length + taskPrompt.length) / 4);
      const outputTokensEst = Math.ceil(text.length / 4);
      win?.webContents.send("orca-event", { type: "run:stats", taskId: ctx.runId, inputTokensEst, outputTokensEst });

      return {
        outputText: text,
        summary: [
          `run_id=${orch.run_id}`,
          `role=${role}${isFallback ? "(fallback)" : ""}`,
          `type=${String(orch.classification.type)}`,
          `risk=${orch.risk.riskScore.toFixed(2)}`,
        ].join(" "),
      };
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

/**
 * Build the task prompt with role context.
 */
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
    const { hasImages: _hi, errorOutput: _eo, fileCount: _fc, deepPlan: _dp, filePath: _fp, conversationHistory: _ch, ...userCtx } = task.context as Record<string, unknown>;

    // Format conversation history as a readable transcript so Miranda's
    // PLAN stage can reason about prior turns instead of parsing raw JSON.
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

    // Build model ladder: primary + any fallback models configured for the brain role.
    // Miranda tries each model in order — if the primary fails (network / quota),
    // it escalates through the fallbacks automatically.
    function buildModelLadder(entry: RoleEntry): ModelSpec[] {
      const primaryProv = s.providers?.find((p) => p.id === entry.providerId);
      const primary: ModelSpec = {
        id: entry.model,
        label: primaryProv ? `${entry.model} (${primaryProv.name})` : entry.model,
      };
      const fallbacks = (entry.fallbacks ?? []).flatMap((f) => {
        const prov = s.providers?.find((p) => p.id === f.providerId);
        if (!prov || !f.model) return [];
        return [{ id: f.model, label: `${f.model} (${prov.name}) [fallback]` } as ModelSpec];
      });
      return [primary, ...fallbacks];
    }

    const modelLadder = buildModelLadder(brainRole);
    const stg = (maxTokens: number) => ({
      models: modelLadder,
      maxRetriesPerModel: 2,
      maxTotalAttempts: Math.max(3, modelLadder.length * 2),
      baseTemperature: 0.4,
      maxTokens,
      timeoutMs: 120_000,
    });
    const llm = createMirandaLLMService(
      buildAdapterForProvider(provider, model),
      createDefaultConfig({
        budgetUsd: s.budgetUsd,
        verbose:   s.verbose,
        stages: {
          plan:     stg(2048),
          answer:   stg(8192),
          critique: stg(2048),
          rewrite:  stg(8192),
        },
      }),
    );
    const pappy   = createPappyPort();
    const maestro = buildMaestroAdapter();
    runtime = createOrcaRuntime({ maestro, pappy, llm, maxRepairPasses: s.maxRepairPasses });
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
    runtime!.on(type, (e: OrcaEvent) => win?.webContents.send("orca-event", e)),
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
