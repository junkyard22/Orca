import "dotenv/config";
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

import { OpenRouterAdapter, createDefaultConfig } from "@clawde/miranda-core";
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

function initOrca(): string | null {
  const apiKey = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!apiKey)
    return "OPENROUTER_API_KEY is not set.\nCreate a .env file next to the app with your OpenRouter key.";

  try {
    const llm = createMirandaLLMService(
      new OpenRouterAdapter({
        apiKey,
        siteUrl: process.env["OPENROUTER_SITE_URL"] ?? "http://localhost",
        appName: process.env["OPENROUTER_APP_NAME"] ?? "orca-desktop",
      }),
      createDefaultConfig(),
    );
    const pappy   = createPappyPort();
    const maestro = buildMaestroAdapter();
    runtime = createOrcaRuntime({ maestro, pappy, llm });
    benson  = createBenson({ executeTask: runtime.executeTask.bind(runtime) });
    return null; // success
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width:          660,
    height:         820,
    minWidth:       480,
    minHeight:      500,
    frame:          false,
    transparent:    false,
    backgroundColor: "#0f0f0f",
    roundedCorners: true,
    hasShadow:      true,
    show:           false,
    center:         true,
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
    const err = initOrca();
    win!.webContents.send("init-status", { ok: err === null, error: err });
  });

  win.on("closed", () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:close",    () => win?.close());

ipcMain.handle("send-message", async (_ev, text: string) => {
  if (!benson || !runtime)
    return { ok: false, error: "Orca is not initialized — check your OPENROUTER_API_KEY." };

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
