import { contextBridge, ipcRenderer } from "electron";
import type { LocalAuthView, SaveLocalAuthInput, SaveLocalAuthResult } from "./auth";
import type { OrcaPipelineTrace } from "@clawde/orca-core";
import type { ContextManifest, ContextManifestAction } from "@clawde/dewey-core";

type CargoClientAction = Exclude<
  ContextManifestAction,
  { type: "set_workspace" } | { type: "sync_connectors" } | { type: "clear" }
>;

export type OrcaEventData = Record<string, unknown>;
export type BensonReply  = { kind: "CLARIFY" | "RESULT"; text: string; options?: string[] };
export type SendResult   = { ok: boolean; reply?: BensonReply; error?: string; pipelineSummary?: Record<string, unknown>; cargoManifest?: ContextManifest };
export type InitStatus   = { ok: boolean; error?: string | null };
export type SaveResult   = { ok: boolean; error?: string };
export type AppAuthStatus = LocalAuthView & { locked: boolean };
export type UnlockResult =
  | { ok: true; auth: AppAuthStatus }
  | { ok: false; error: string };

export type ProviderEntry = {
  id:      string;
  name:    string;
  type:    string;
  baseUrl: string;
  apiKey:  string;
};

export type RoleEntry = {
  providerId:      string;
  model:           string;
  fallbacks?:      Array<{ providerId: string; model: string }>;
  enableThinking?: boolean;
  maxTokens?:      number;
  temperature?:    number;
};

export type McpServerConfig = {
  id:              string;
  name:            string;
  transport:       "stdio";
  command:         string;
  args?:           string[];
  env?:            Record<string, string>;
  namespaceTools?: boolean;
  enabled?:        boolean;
};

export type OrcaSettings = {
  providers:       ProviderEntry[];
  roles:           Partial<Record<string, RoleEntry>>;
  budgetUsd:       number;
  maxRepairPasses: number;
  verbose:         boolean;
  workspaceRoot:   string;
  mcpServers?:     McpServerConfig[];
  showPipeline?:   boolean;
  autoResolveCargo?: boolean;
  narratorProgressMode?: "standard" | "model";
};

export type SessionSummary = {
  id:          string;
  createdAt:   string;
  intent:      string;
  role?:       string;
  status:      "SUCCESS" | "FAIL";
  outputText?: string;
  costUsd?:    number;
};

export type CargoSnapshot = {
  manifest: ContextManifest;
  connectors: Array<{ id: string; label: string; available: boolean }>;
  previousRuns: Array<{ id: string; label: string; createdAt: string }>;
  status: { ready: boolean; availableToolCount: number };
};

contextBridge.exposeInMainWorld("orca", {
  sendMessage: (text: string): Promise<SendResult> =>
    ipcRenderer.invoke("send-message", text),

  onOrcaEvent: (cb: (e: OrcaEventData) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, e: OrcaEventData) => cb(e);
    ipcRenderer.on("orca-event", handler);
    return () => ipcRenderer.removeListener("orca-event", handler);
  },

  onInitStatus: (cb: (s: InitStatus) => void): void => {
    ipcRenderer.on("init-status", (_, s: InitStatus) => cb(s));
  },

  getSettings: (): Promise<OrcaSettings | null> =>
    ipcRenderer.invoke("settings:get"),

  saveSettings: (s: OrcaSettings): Promise<SaveResult> =>
    ipcRenderer.invoke("settings:save", s),

  getCargo: (): Promise<CargoSnapshot | null> =>
    ipcRenderer.invoke("cargo:get"),

  updateCargo: (action: CargoClientAction): Promise<{ ok: boolean; manifest?: ContextManifest; error?: string }> =>
    ipcRenderer.invoke("cargo:update", action),

  pickCargoResources: (kind: "file" | "folder"): Promise<Array<{ path: string; label: string; kind: "file" | "folder" }>> =>
    ipcRenderer.invoke("cargo:pick", kind),

  getAuthStatus: (): Promise<AppAuthStatus> =>
    ipcRenderer.invoke("auth:status"),

  onAuthStatus: (cb: (s: AppAuthStatus) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, s: AppAuthStatus) => cb(s);
    ipcRenderer.on("auth-status", handler);
    return () => ipcRenderer.removeListener("auth-status", handler);
  },

  unlock: (password: string): Promise<UnlockResult> =>
    ipcRenderer.invoke("auth:unlock", password),

  lock: (): Promise<AppAuthStatus> =>
    ipcRenderer.invoke("auth:lock"),

  saveAuthConfig: (input: SaveLocalAuthInput): Promise<SaveLocalAuthResult> =>
    ipcRenderer.invoke("auth:save", input),

  minimize: (): void => ipcRenderer.send("win:minimize"),
  maximize: (): void => ipcRenderer.send("win:maximize"),
  close:    (): void => ipcRenderer.send("win:close"),

  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized);
    ipcRenderer.on("win:maximize-change", handler);
    return () => ipcRenderer.removeListener("win:maximize-change", handler);
  },

  // ── Tool approval ────────────────────────────────────────────────────────
  // Called by the renderer to subscribe to tool-call approval requests.
  // The callback fires whenever an agent loop wants to execute a tool.
  onToolRequest: (
    cb: (id: string, tool: string, args: Record<string, unknown>) => void,
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { id: string; tool: string; args: Record<string, unknown> },
    ) => cb(data.id, data.tool, data.args);
    ipcRenderer.on("tool:request", handler);
    return () => ipcRenderer.removeListener("tool:request", handler);
  },

  // Send the user's approve/deny decision back to main.
  approveToolCall: (id: string, approved: boolean): void =>
    ipcRenderer.send("tool:approve", { id, approved }),

  // ── Workspace selection ──────────────────────────────────────────────────
  // Opens a native folder picker and returns the chosen path (empty string if
  // the user cancels). Used by the Settings panel workspace section.
  selectWorkspace: (): Promise<string> =>
    ipcRenderer.invoke("workspace:select"),

  // ── Model discovery ──────────────────────────────────────────────────────
  // Fetch available models from a provider using its current (possibly unsaved)
  // connection details. Returns { ok, models?, error? }.
  fetchModels: (p: { type: string; baseUrl: string; apiKey: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke("models:fetch", p),

  // ── Session history ──────────────────────────────────────────────────────
  // Returns up to 30 recent runs for the sidebar session list.
  listSessions: (): Promise<SessionSummary[]> =>
    ipcRenderer.invoke("sessions:list"),

  // Load a single run by ID for display in the chat view.
  loadSession: (id: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke("session:load", id),

  // Load the structured per-run pipeline trace written by the desktop runtime.
  loadSessionTrace: (id: string): Promise<OrcaPipelineTrace | null> =>
    ipcRenderer.invoke("session:trace", id),

  // Delete a run and all its related data from SQLite.
  deleteSession: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("session:delete", id),

  // Abort the currently running task (if any).
  abortTask: (): void => ipcRenderer.send("task:abort"),

  // ── Streaming output ─────────────────────────────────────────────────────
  // Dedicated channels for streaming answer output to the renderer.
  // Only fires during the agent answer/generation stage — Miranda preflight,
  // Pappy QC, and repair passes run silently via complete() and never emit.

  onStreamStart: (cb: (data: { runId: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { runId: string }) => cb(data);
    ipcRenderer.on("orca:stream-start", handler);
    return () => ipcRenderer.removeListener("orca:stream-start", handler);
  },

  onStreamChunk: (cb: (data: { chunk: string; runId: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { chunk: string; runId: string }) => cb(data);
    ipcRenderer.on("orca:stream-chunk", handler);
    return () => ipcRenderer.removeListener("orca:stream-chunk", handler);
  },

  onStreamEnd: (cb: (data: { runId: string }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { runId: string }) => cb(data);
    ipcRenderer.on("orca:stream-end", handler);
    return () => ipcRenderer.removeListener("orca:stream-end", handler);
  },
});
