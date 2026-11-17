import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOrcaRuntime, createPappyPort } from "@clawde/orca-core";
import type { OrcaRunCtx, OrcaTaskSpec } from "@clawde/orca-core";
import { createMirandaGate } from "@clawde/miranda-core";
import type { LLMAdapter, LLMRequest } from "@clawde/miranda-core";
import { createCoreToolRegistry } from "@yakstacks/workbench-core";
import type { BrainContractProposal } from "maestro-core";
import { enforceToolAuthorization } from "./toolAuthorization";
import { buildRoleStaticAllowLists } from "./workerConstraints";

vi.mock("electron", () => ({
  app: { on: vi.fn(), requestSingleInstanceLock: () => false, quit: vi.fn(), getPath: () => tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: {}, dialog: {}, Tray: {}, Menu: {}, nativeImage: {},
}));
import { buildMaestroAdapter } from "./main";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
type Call = { tool: string; [key: string]: unknown };
function harness(proposal: BrainContractProposal, calls: Call[], options: {
  permissions?: unknown; origin?: string; toolsAllowed?: string[]; hostGate?: ReturnType<typeof createMirandaGate>;
  prepareTask?: (task: OrcaTaskSpec, ctx: OrcaRunCtx) => Promise<OrcaTaskSpec>;
  roleSettings?: Record<string, { toolsAllowed?: string[] }>;
  qc?: boolean; fallback?: boolean; invalidWorkspace?: boolean; decompose?: boolean;
  missingApprover?: boolean;
  explicitPermissions?: unknown;
} = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "orca-authority-"))); roots.push(root);
  writeFileSync(join(root, "README.md"), "original\n");
  const executed: string[] = [];
  const approve = vi.fn(async () => false);
  const core = createCoreToolRegistry();
  const tools = ["read_file", "write_file", "run_command", "desktop-commander_write_file", "desktop-commander_edit_block", "desktop-commander_start_process", "web_fetch", "github-mcp_run_workflow", "mail_get_email", "mail_send_email"].map((name) => ({
    name, description: name,
    execute: vi.fn(async (args: Record<string, unknown>, ctx: any) => {
      const refusal = await enforceToolAuthorization(name, args, { workspaceRoot: root, mcpServerIds: ["desktop-commander", "mail", "github-mcp"], requestApproval: ctx.requestApproval });
      if (refusal) return refusal;
      executed.push(name);
      const tool = core.get(name);
      if (tool) return tool.execute(args, ctx);
      if (name === "desktop-commander_write_file" || name === "desktop-commander_edit_block") writeFileSync(join(root, String(args.path)), String(args.content));
      return { ok: true, output: "executed" };
    }),
  }));
  const requests: LLMRequest[] = [];
  const worker = { name: "scripted", complete: vi.fn(async (request: LLMRequest) => {
    requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    const call = calls[requests.length - 1];
    return { content: call ? `<tool_call>${JSON.stringify(call)}</tool_call>` : "FINAL ANSWER:\nThe requested inspection or correction is complete. README.md is the project document." };
  }) } as unknown as LLMAdapter;
  const maestro = buildMaestroAdapter(new Map([["utility", worker], ["debugger", worker], ["narrator", worker], ["reader", worker], ["strong_model", worker]]), tools, undefined, undefined, undefined, root,
    options.roleSettings ? buildRoleStaticAllowLists(options.roleSettings) : options.toolsAllowed === undefined ? undefined : new Map([["utility", new Set(options.toolsAllowed)]]),
    { connectorTools: tools.map((tool) => tool.name), mcpServerIds: ["desktop-commander", "mail", "github-mcp"], prepareTask: options.prepareTask });
  const contexts: OrcaRunCtx[] = [];
  const runtime = createOrcaRuntime({ maestro: { run: async (task, ctx) => { contexts.push(ctx); return maestro.run(task, ctx); } },
    llm: { complete: async () => ({ text: JSON.stringify({ ...(options.decompose ? { routing: "decompose", departments: [
      { head: "reader", subtask: "Describe the project document" }, { head: "utility", subtask: "Explain the project organization" },
    ] } : { routing: "direct", role: "utility" }), ...(options.fallback ? {} : { contract: proposal }) }) }) },
    pappy: options.qc ? createPappyPort() : undefined, maxRepairPasses: 1,
    gate: options.hostGate ?? createMirandaGate(), workspaceRoot: options.invalidWorkspace ? join(root, "absent") : root, connectorTools: tools.map((tool) => tool.name), requestToolApproval: options.missingApprover ? undefined : approve,
  });
  const run = (message = "Explain the project document", context?: Record<string, unknown>) => runtime.executeTask({
    originalUserMessage: message, intent: message, goals: [message],
    permissions: (options.origin ?? "benson") === "benson" ? options.explicitPermissions : options.permissions ?? ["read", "write", "shell", "network"], context,
  } as OrcaTaskSpec, { permissionsSource: options.origin ?? "benson", inferredPermissions: (options.origin ?? "benson") === "benson" ? options.permissions ?? ["read", "write", "shell", "network"] : undefined } as never);
  return { root, executed, tools, requests, approve, contexts, run, runtime };
}

describe("contract authority at the real runtime/desktop execution boundary", () => {
  it("narrows every decomposed worker before tool dispatch", async () => {
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [
      { tool: "desktop-commander_write_file", path: "README.md", content: "bad" },
      { tool: "shell", command: "node -e process.exit(0)" },
    ], { decompose: true, permissions: ["read"] });
    const result = await h.run();
    expect(result.contract?.source).toBe("brain");
    expect(h.requests.length).toBeGreaterThanOrEqual(2);
    expect(h.executed).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
  });
  it("eligible MCP process access still requires exact-call host approval", async () => {
    const command = "node -e process.exit(0)";
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "desktop-commander_start_process", command }], { permissions: ["read"] });
    await h.run("Report the result");
    expect(h.approve).toHaveBeenCalledWith("desktop-commander_start_process", expect.objectContaining({ command }));
    expect(h.executed).toEqual([]);
    expect(h.contexts[0].authorization?.refusals()).toEqual([expect.objectContaining({ tool: "desktop-commander_start_process", outcome: "not_approved" })]);
  });
  it("retains explicit caller limits alongside independently supplied trusted inference", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], {
      permissions: ["read"], explicitPermissions: { fileRead: true, fileWrite: false, shellExec: false, networkAccess: false },
    });
    await h.run("Correct the typo in README.md");
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
    expect(h.executed).toEqual([]);
  });
  it.each([
    { kind: "execute", needs: [] },
    { kind: "execute", needs: ["shell"], prohibits: ["shell"] },
  ] as BrainContractProposal[])("does not infer shell authority from execute kind or prohibited needs: %j", async (proposal) => {
    const h = harness(proposal, [{ tool: "run_command", command: "node -e process.exit(0)" }]);
    await h.run("Report the result");
    expect(h.executed).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });
  it("a positive shell need cannot enlarge a role allowlist", async () => {
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "shell", command: "node -e process.exit(0)" }], { toolsAllowed: ["read_file"] });
    await h.run("Report the result");
    expect(h.executed).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });
  it("an eligible host command fails closed when no approval handler exists", async () => {
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "run_command", command: 'node -e "require(\'fs\').writeFileSync(\'shell.txt\',\'bad\')"' }], { missingApprover: true });
    await h.run("Report the result");
    expect(existsSync(join(h.root, "shell.txt"))).toBe(false);
    expect(h.approve).not.toHaveBeenCalled();
  });
  it("retains confined-read command policy without an unnecessary approval", async () => {
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "run_command", command: process.platform === "win32" ? "type README.md" : "cat README.md" }]);
    const result = await h.run("Report the result");
    expect(h.executed).toEqual(["run_command"]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(JSON.stringify(result.artifacts)).toContain("confined_read");
  });
  it.each(["fileRead", "shellExec"])("preserves an explicit caller %s denial", async (flag) => {
    const permissions = { fileRead: true, fileWrite: true, shellExec: true, networkAccess: true, [flag]: false };
    const h = harness({ kind: "execute", needs: ["filesystem-read", "shell"] }, [{ tool: flag === "fileRead" ? "read_file" : "run_command", path: "README.md", command: "node -e process.exit(0)" }], { permissions, origin: "caller" });
    await h.run("Describe the result");
    expect(h.executed).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });
  it("does not prepare Cargo at all when the fixed contract requires an invalid workspace", async () => {
    const prepareTask = vi.fn(async (task: OrcaTaskSpec) => task);
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [], { prepareTask, invalidWorkspace: true });
    await h.run();
    expect(prepareTask).not.toHaveBeenCalled();
  });
  it.each([
    { permissions: { fileRead: true, fileWrite: false, shellExec: true, networkAccess: true } },
    { permissions: ["read"] },
  ])("preserves explicit caller restrictions and ignores forged context provenance: %j", async ({ permissions }) => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { permissions, origin: "caller" });
    await h.run("Correct the typo in README.md", { permissionsSource: "benson", hostGate: { allowed: true }, approved: true });
    expect(h.contexts[0].permissionsSource).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
  });

  it.each([
    { needs: [] }, { needs: ["filesystem-write"], prohibits: ["filesystem-write"] },
  ] as BrainContractProposal[])("modify alone or a prohibited need never grants write: %j", async (proposal) => {
    const h = harness({ ...proposal, kind: "modify" }, [{ tool: "write_file", path: "README.md", content: "bad" }]);
    await h.run("Correct the typo in README.md");
    expect(h.executed).toEqual([]);
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
  });

  it.each(["write_file", "desktop-commander_write_file", "desktop-commander_edit_block"])("inspection cannot execute %s", async (tool) => {
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [{ tool, path: "README.md", content: "bad" }]);
    await h.run();
    expect(h.executed).toEqual([]);
    expect(h.tools.find((candidate) => candidate.name === tool)!.execute).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
  });

  it.each(["run_command", "shell", "run_shell", "desktop-commander_start_process"])("absent shell need denies the effective tool for %s", async (tool) => {
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [{ tool, command: 'node -e "require(\'fs\').writeFileSync(\'shell.txt\',\'bad\')"' }]);
    await h.run();
    expect(h.executed).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(existsSync(join(h.root, "shell.txt"))).toBe(false);
  });

  it("an eligible shell still cannot start a process without exact-call approval", async () => {
    const command = 'node -e "require(\'fs\').writeFileSync(\'shell.txt\',\'bad\')"';
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "shell", command }], { permissions: ["read"] });
    await h.run("Run the verification command");
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.approve).toHaveBeenCalledWith("run_command", expect.objectContaining({ command }));
    expect(existsSync(join(h.root, "shell.txt"))).toBe(false);
  });

  it("an eligible shell runs the exact command after approval, with a real observed effect", async () => {
    const h = harness({ kind: "execute", needs: ["shell"] }, [{ tool: "run_command", command: 'node -e "require(\'fs\').writeFileSync(\'shell.txt\',\'approved\')"' }], { permissions: ["read"] });
    h.approve.mockResolvedValue(true);
    await h.run("Run the verification command");
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(h.root, "shell.txt"), "utf8")).toBe("approved");
  });

  it.each(["web_fetch", "mail_get_email", "mail_send_email", "github-mcp_run_workflow"])("no independent connector authorization means %s never executes", async (tool) => {
    const h = harness({ kind: "modify", needs: ["filesystem-write", "shell", "web", "github-read", "github-write"] }, [{ tool, url: "https://example.com", path: "README.md" }]);
    await h.run("Update the remote project", { contextManifest: { connectors: [{ connectorId: "mail", available: true }], workspace: { repository: "owner/repo" } }, networkAccess: true, authorization: { approved: true } });
    expect(h.tools.find((candidate) => candidate.name === tool)!.execute).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.executed).toEqual([]);
  });

  it("retains the original host tool gate even after inferred write restrictions are replaced", async () => {
    const host = createMirandaGate({ allowedTools: ["read_file"] });
    const before = vi.spyOn(host, "beforeToolRun");
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { permissions: ["read"], hostGate: host });
    await h.run("Correct the typo in README.md");
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ tool: "write_file" }));
    expect(h.executed).toEqual([]);
  });

  it("retains the workspace gate and refuses an invalid root before worker execution", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { permissions: ["read"], invalidWorkspace: true });
    const result = await h.run("Correct the typo in README.md");
    expect(h.requests).toHaveLength(0);
    expect(h.executed).toEqual([]);
    expect(result.followUpQuestion).toContain("workspace");
  });

  it("retains the inferred gate on fallback, even for positively identified Benson input", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { permissions: ["read"], fallback: true });
    const result = await h.run("Correct the typo in README.md");
    expect(result.contract?.source).toBe("fallback");
    expect(h.executed).toEqual([]);
  });

  it("retains legacy connector dispatch on fallback with its existing network permission", async () => {
    const h = harness({ kind: "inspect" }, [{ tool: "mail_get_email" }], { fallback: true });
    await h.run("Explain the remote project");
    expect(h.executed).toEqual(["mail_get_email"]);
  });

  it("preserves an explicit task empty allowlist", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { permissions: { fileRead: true, fileWrite: true, shellExec: true, toolsAllowed: [] }, origin: "caller" });
    await h.run("Correct the typo in README.md");
    expect(h.executed).toEqual([]);
  });

  it("keeps the fixed contract and denied write authority through a real Pappy repair pass", async () => {
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [
      { tool: "read_file", path: "README.md" }, undefined as never,
      { tool: "desktop-commander_write_file", path: "README.md", content: "bad" },
    ], { qc: true });
    const result = await h.run("Explain the project document");
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[0].taskContract).toBe(result.contract);
    expect(h.contexts[1].taskContract).toBe(result.contract);
    expect(h.executed).toEqual(["read_file"]);
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
  });
  it.each(["shell", "mail_send_email"])("a real repair cannot acquire %s authority or repeat Cargo preparation", async (tool) => {
    const prepareTask = vi.fn(async (task: OrcaTaskSpec) => task);
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [
      { tool: "read_file", path: "README.md" }, undefined as never,
      { tool, command: "node -e process.exit(0)" },
    ], { qc: true, prepareTask });
    const result = await h.run();
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[1].taskContract).toBe(result.contract);
    expect(h.executed).toEqual(["read_file"]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(prepareTask).toHaveBeenCalledTimes(1);
  });
  it("treats an explicitly empty Settings role allowlist as no tools", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "bad" }], { roleSettings: { utility: { toolsAllowed: [] } } });
    await h.run("Correct the typo in README.md");
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
    expect(h.executed).toEqual([]);
  });
  it("prepares host Cargo only after the contract is fixed and before the worker", async () => {
    const prepareTask = vi.fn(async (task: OrcaTaskSpec, ctx: OrcaRunCtx) => {
      expect(ctx.taskContract?.source).toBe("brain");
      expect(h.requests).toHaveLength(0);
      return { ...task, context: { ...task.context, deweyBrief: { lines: ["prepared context"] } } };
    });
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [], { prepareTask });
    await h.run("Describe the project");
    expect(prepareTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.requests)).toContain("prepared context");
  });
  it("supersedes only trusted Benson inference for a positively eligible workspace write (T5)", async () => {
    const h = harness({ kind: "modify", needs: ["filesystem-write"] }, [{ tool: "write_file", path: "README.md", content: "corrected\n" }], { permissions: ["read"] });
    await h.run("Correct the typo in README.md");
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("corrected\n");
    expect(h.executed).toEqual(["write_file"]);
  });
  it("refuses MCP writes for inspect even when inferred flags allowed writes (T1)", async () => {
    const h = harness({ kind: "inspect", needs: ["filesystem-read"] }, [{ tool: "desktop-commander_write_file", path: "README.md", content: "bad" }]);
    await h.run();
    expect(readFileSync(join(h.root, "README.md"), "utf8")).toBe("original\n");
    expect(h.executed).toEqual([]);
  });
});
