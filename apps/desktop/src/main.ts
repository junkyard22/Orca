import "dotenv/config";
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

import { OllamaAdapter, OpenAICompatAdapter } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
import {
  createOrcaRuntime,
  createDirectLLMService,
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
} from "@clawde/orca-core";
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

// ── Maestro adapter ────────────────────────────────────────────────────────
// Brain decomposes every task into a routing decision (direct or decompose).
// Direct: one specialist role handles it in a single LLM call.
// Decompose: multiple department heads run in parallel, Brain synthesises.

function buildMaestroAdapter(
  /** Per-role LLM services. Falls back to ctx.llm (brain) when a role has no dedicated entry. */
  roleAdapters: Partial<Record<string, OrcaLLMService>>,
): MaestroPort {
  const maestro = createMaestroCore();

  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      const orch  = maestro.orchestrate(task.originalUserMessage);
      const taskId = ctx.runId;
      const brainLLM = roleAdapters['brain'] ?? ctx.llm;

      // ── Step 1: Brain decomposes the task ────────────────────────────────
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

      win?.webContents.send('orca-event', { type: 'decision', taskId, decision });

      // ── Step 2a: Direct routing — one specialist, one call ───────────────
      if (decision.routing === 'direct') {
        const role = decision.role;
        win?.webContents.send('orca-event', { type: 'role:selected', taskId, role, isFallback: false });

        const systemPrompt = getRolePrompt(role as RoleName);
        const taskPrompt   = buildTaskPrompt(task, role);
        const llmForRole   = roleAdapters[role] ?? ctx.llm;

        const { text } = await llmForRole.complete(
          `${systemPrompt}\n\n---\n\n${taskPrompt}`,
          {
            maxTokens: 4096,
            onToken: ctx.emit
              ? (chunk) => ctx.emit!({ type: 'stream:token', taskId, chunk })
              : undefined,
          },
        );

        const inputTokensEst  = Math.ceil((systemPrompt.length + taskPrompt.length) / 4);
        const outputTokensEst = Math.ceil(text.length / 4);
        win?.webContents.send('orca-event', { type: 'run:stats', taskId, inputTokensEst, outputTokensEst });

        return {
          outputText: text,
          doneCriteria: decision.done_criteria,
          summary: `run_id=${orch.run_id} routing=direct role=${role} risk=${orch.risk.riskScore.toFixed(2)}`,
        };
      }

      // ── Step 2b: Decompose — parallel department calls ───────────────────
      const { departments, synthesis_hint } = decision;

      const deptResults = await Promise.all(
        departments.map(async (dept, i) => {
          const subagentId = `${taskId}_sa${i}`;
          ctx.emit?.({ type: 'subagent:spawned', taskId, subagentId, role: dept.head, task: dept.subtask });

          try {
            const headSystem = getRolePrompt(dept.head as RoleName);
            const headLLM    = roleAdapters[dept.head] ?? ctx.llm;
            const prompt = [
              headSystem,
              '\n\n---\n\n',
              dept.context ? `## Context\n${dept.context}\n\n` : '',
              `## Subtask\n${dept.subtask}`,
              `\n\n## Original request\n${task.originalUserMessage}`,
            ].join('');

            const { text: output } = await headLLM.complete(prompt, { maxTokens: 8192 });
            ctx.emit?.({ type: 'subagent:done', taskId, subagentId, role: dept.head, ok: true });
            return { head: dept.head, subtask: dept.subtask, output, subagentId, ok: true as const };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            ctx.emit?.({ type: 'subagent:failed', taskId, subagentId, role: dept.head, error });
            return { head: dept.head, subtask: dept.subtask, output: '', subagentId, ok: false as const, error };
          }
        }),
      );

      // ── Step 3: Synthesise ───────────────────────────────────────────────
      // If only one department ran (shouldn't normally happen but be safe)
      // skip synthesis overhead.
      if (deptResults.length === 1) {
        return {
          outputText:   deptResults[0]!.output,
          doneCriteria: decision.done_criteria,
          summary:      `run_id=${orch.run_id} routing=decompose depts=1`,
          subagentRuns: deptResults.map((d) => ({
            subagentId:  d.subagentId,
            role:        d.head,
            task:        d.subtask,
            status:      d.ok ? 'done' : 'failed',
            outputText:  d.output,
            error:       'error' in d ? d.error : undefined,
          })),
        };
      }

      // Brain synthesises all department outputs, streaming to the UI.
      const synthPrompt = buildSynthesisPrompt(
        task.originalUserMessage,
        deptResults.map((d) => ({ head: d.head, subtask: d.subtask, output: d.output })),
        synthesis_hint,
      );

      const { text: synthOutput } = await brainLLM.complete(
        `${getRolePrompt('brain')}\n\n---\n\n${synthPrompt}`,
        {
          maxTokens: 4096,
          onToken: ctx.emit
            ? (chunk) => ctx.emit!({ type: 'stream:token', taskId, chunk })
            : undefined,
        },
      );

      return {
        outputText:   synthOutput,          doneCriteria: decision.done_criteria,        summary:      `run_id=${orch.run_id} routing=decompose depts=${departments.length}`,
        subagentRuns: deptResults.map((d) => ({
          subagentId:  d.subagentId,
          role:        d.head,
          task:        d.subtask,
          status:      d.ok ? 'done' : 'failed',
          outputText:  d.output,
          error:       'error' in d ? d.error : undefined,
        })),
      };
    },
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

    const maestro = buildMaestroAdapter(roleAdapters);
    // Pappy QC and Miranda gates are intentionally disabled for now.
    // Re-enable once Maestro is verified working correctly.
    runtime = createOrcaRuntime({ maestro, llm, maxRepairPasses: 0 });
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
