import { contextBridge, ipcRenderer } from "electron";

export type OrcaEventData = Record<string, unknown>;
export type BensonReply  = { kind: "CLARIFY" | "RESULT"; text: string; options?: string[] };
export type SendResult   = { ok: boolean; reply?: BensonReply; error?: string };
export type InitStatus   = { ok: boolean; error?: string | null };
export type OrcaSettings = {
  apiKey:          string;
  budgetUsd:       number;
  maxRepairPasses: number;
  siteUrl:         string;
  appName:         string;
  verbose:         boolean;
};
export type SaveResult   = { ok: boolean; error?: string };

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

  getSettings: (): Promise<OrcaSettings> =>
    ipcRenderer.invoke("settings:get"),

  saveSettings: (s: OrcaSettings): Promise<SaveResult> =>
    ipcRenderer.invoke("settings:save", s),

  minimize: (): void => ipcRenderer.send("win:minimize"),
  close:    (): void => ipcRenderer.send("win:close"),

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

  // ── Model discovery ──────────────────────────────────────────────────────
  // Fetch available models from a provider using its current (possibly unsaved)
  // connection details. Returns { ok, models?, error? }.
  fetchModels: (p: { type: string; baseUrl: string; apiKey: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke("models:fetch", p),
});
