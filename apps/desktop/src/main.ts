import "dotenv/config";
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

import { OllamaAdapter, OpenAICompatAdapter, createDefaultConfig } from "@clawde/miranda-core";
import type { LLMAdapter } from "@clawde/miranda-core";
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
import { createMaestroCore } from "maestro-core";
import { loadSettings, saveSettings } from "./settings";
import type { OrcaSettings, ProviderEntry } from "./settings";

// ── Maestro adapter ────────────────────────────────────────────────────────

function buildMaestroAdapter(): MaestroPort {
  const maestro = createMaestroCore();
  return {
    async run(task: OrcaTaskSpec, ctx: OrcaRunCtx): Promise<OrcaMaestroResult> {
      const orch = maestro.orchestrate(task.originalUserMessage);
      const isRepair = task.intent === "repair";
      const lines: string[] = [
        isRepair
          ? "You are fixing defects found in a previous attempt. Address every listed issue."
          : "You are an expert assistant. Complete the task precisely and thoroughly.",
        "",
        `## Intent\n${task.intent}`,
        `## Request\n${task.originalUserMessage}`,
        `## Goals\n${task.goals.map((g) => `- ${g}`).join("\n")}`,
      ];
      if (task.constraints && Object.keys(task.constraints).length > 0)
        lines.push(`## Constraints\n${JSON.stringify(task.constraints, null, 2)}`);
      if (task.context && Object.keys(task.context).length > 0)
        lines.push(`## Context\n${JSON.stringify(task.context, null, 2)}`);

      const { text } = await ctx.llm.complete(lines.join("\n\n"), { maxTokens: 4096 });
      return {
        outputText: text,
        summary: `run_id=${orch.run_id} type=${String(orch.classification.type)}`,
      };
    },
  };
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
    const modelSpec = { id: model, label: model };
    const stg = (maxTokens: number) => ({
      models: [modelSpec],
      maxRetriesPerModel: 2,
      maxTotalAttempts: 3,
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

ipcMain.handle("settings:get", () => loadSettings());

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
    "qc:result",  "repair:start",  "task:done",
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
