/**
 * Shell execution authority (stage 2.1).
 *
 * run_command starts a host shell. Its working directory is the workspace,
 * but nothing confines the process to it: there is no OS sandbox. So a command
 * runs unattended only when it is a plain invocation of a single-purpose
 * reader whose every operand resolves inside the workspace (links followed);
 * everything else needs the user's approval, asked for in words that say the
 * command has the user's access to the whole computer.
 *
 * Real shell, real files — all under temporary directories created here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandTool } from "./runCommandTool.js";
import { createSandboxPolicy, evaluateCommandPolicy } from "./sandbox.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const tmp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `orca-${name}-`))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const ws = tmp("shell-ws");
  const outside = tmp("shell-outside");
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "a.txt"), "inside-content\n");
  writeFileSync(join(ws, "notes.txt"), "notes\n");
  writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
  symlinkSync(outside, join(ws, "link"));
  symlinkSync(join(outside, "secret.txt"), join(ws, "alias.txt"));
  return { ws, outside };
}
const policy = createSandboxPolicy();
const unattended = (command: string, ws: string, cwd = ws) => {
  const result = evaluateCommandPolicy(command, policy, "posix", { workspaceRoot: ws, cwd });
  return result.allowed && !result.requiresApproval;
};

describe("which commands may run without asking", () => {
  it("allows plain single-purpose reads whose operands are inside the workspace", () => {
    const { ws } = fixture();
    for (const command of ["ls", "ls -la", "ls -la src", "cat src/a.txt", "cat notes.txt src/a.txt", "head -n 5 notes.txt", "tail -c 20 src/a.txt", "wc -l notes.txt", "stat notes.txt", "pwd", "whoami", "echo hello world", "node --version"]) {
      expect(unattended(command, ws), command).toBe(true);
    }
    expect(unattended("cat a.txt", ws, join(ws, "src"))).toBe(true);
    expect(evaluateCommandPolicy("cat src/a.txt", policy, "posix", { workspaceRoot: ws, cwd: ws })).toMatchObject({ unattended: "confined_read" });
  });

  it("asks before a read that reaches outside the workspace", () => {
    const { ws, outside } = fixture();
    for (const command of [
      `cat ${join(outside, "secret.txt")}`,
      "cat ../secret.txt",
      "cat src/../../secret.txt",
      "cat link/secret.txt",   // through a linked directory
      "cat alias.txt",          // a linked file
      "ls link",
      "ls -la /",
      "head -n 1 /etc/hostname",
    ]) {
      expect(unattended(command, ws), command).toBe(false);
    }
    expect(unattended("cat ../notes.txt", ws, join(ws, "src"))).toBe(true); // still inside
  });

  it("asks whenever the shell would interpret anything in the command", () => {
    const { ws } = fixture();
    for (const command of [
      "ls -la\ntouch pwned",
      "ls -la & touch pwned",
      "echo $(touch pwned)",
      "echo `touch pwned`",
      "echo $HOME",
      "cat ~/notes.txt",
      "cat *.txt",
      "cat src/{a,b}.txt",
      "ls; touch pwned",
      "ls && touch pwned",
      "ls | tee pwned",
      "ls > pwned",
      "ls 2>/dev/null",
      "cat 'notes.txt'",
      "cat notes.txt # trailing",
      "FOO=1 ls",
      "ls\ttouch",
    ]) {
      expect(unattended(command, ws), JSON.stringify(command)).toBe(false);
    }
  });

  it("asks for tools that can execute, write or follow configuration, and for unlisted options", () => {
    const { ws } = fixture();
    for (const command of [
      "git status", "git log --oneline", "git diff",       // run hooks / config-defined programs from the repository
      "find . -name a.txt", "find . -delete",
      "grep -R secret .", "rg secret", "less notes.txt", "diff -r src link",
      "npm ls", "pnpm list", "du -L .", "tree -l",
      "ls -R", "ls -L link", "ls --recursive", "cat -- notes.txt", "head --lines=5 notes.txt",
      "npm test", "node script.js", "python3 -V extra",
    ]) {
      expect(unattended(command, ws), command).toBe(false);
    }
  });

  it("cannot vouch for operands when it is not told the workspace", () => {
    expect(evaluateCommandPolicy("cat notes.txt", policy, "posix").requiresApproval).toBe(true);
    expect(evaluateCommandPolicy("pwd", policy, "posix").requiresApproval).toBe(false);
  });

  it("says what approval really grants", () => {
    const { ws } = fixture();
    const result = evaluateCommandPolicy("npm test", policy, "posix", { workspaceRoot: ws, cwd: ws });
    expect(result.requiresApproval).toBe(true);
    expect(result.hostAccessWarning).toMatch(/not sandboxed/i);
    expect(result.hostAccessWarning).toMatch(/whole computer|outside the workspace/i);
  });

  it("keeps a host-configured allowance, and labels it as the host's policy", () => {
    const { ws } = fixture();
    const hostPolicy = createSandboxPolicy({ extraAllowedCommands: ["npm test"] });
    expect(evaluateCommandPolicy("npm test", hostPolicy, "posix", { workspaceRoot: ws, cwd: ws })).toMatchObject({ requiresApproval: false, unattended: "host_policy" });
    expect(evaluateCommandPolicy("rm -rf /", hostPolicy, "posix", { workspaceRoot: ws, cwd: ws }).allowed).toBe(false);
  });
});

describe.runIf(posix)("run_command on a real shell", () => {
  const run = (command: string, ws: string, requestApproval?: (tool: string, args: Record<string, unknown>, reason: string) => Promise<boolean>) =>
    runCommandTool.execute({ command, timeout: 15_000 }, { workspaceRoot: ws, runId: "r", ...(requestApproval ? { requestApproval } : {}) }) as Promise<{ ok: boolean; output: string; error?: string; executionAuthority?: Record<string, unknown> }>;

  it("runs a confined read unattended and records its authority", async () => {
    const { ws } = fixture();
    const ask = vi.fn(async () => true);
    const result = await run("cat src/a.txt", ws, ask);
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("inside-content") });
    expect(ask).not.toHaveBeenCalled();
    expect(result.executionAuthority).toMatchObject({ filesystemScope: "host", confinement: "none", approval: "confined_read" });
  });

  it("does not read outside the workspace unattended — directly, by traversal or through links", async () => {
    const { ws, outside } = fixture();
    for (const command of [`cat ${join(outside, "secret.txt")}`, "cat ../" + outside.split("/").pop() + "/secret.txt", "cat link/secret.txt", "cat alias.txt"]) {
      const result = await run(command, ws); // no approval handler: nobody can be asked
      expect(result.ok, command).toBe(false);
      expect(result.output, command).not.toContain("outside-secret");
      expect(result.error, command).toMatch(/requires approval/i);
    }
  });

  it("does not run an injected second command behind an allowed first one", async () => {
    const { ws } = fixture();
    for (const command of ["ls -la\ntouch pwned", "ls -la & touch pwned", "echo $(touch pwned)", "echo `touch pwned`"]) {
      const result = await run(command, ws);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      expect(existsSync(join(ws, "pwned")), JSON.stringify(command)).toBe(false);
    }
  });

  it("asks with an accurate description, runs on approval, and records that it was unconfined", async () => {
    const { ws, outside } = fixture();
    const reasons: string[] = [];
    const ask = vi.fn(async (_tool: string, _args: Record<string, unknown>, reason: string) => { reasons.push(reason); return true; });
    const result = await run(`cat ${join(outside, "secret.txt")}`, ws, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(reasons[0]).toMatch(/not sandboxed/i);
    // Approved by the user, it runs — and can indeed read outside the workspace: that is what was approved.
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("outside-secret") });
    expect(result.executionAuthority).toMatchObject({ filesystemScope: "host", confinement: "none", approval: "user_approved" });
  });

  it("does not run when approval is denied", async () => {
    const { ws } = fixture();
    const result = await run("touch denied.txt", ws, async () => false);
    expect(result.ok).toBe(false);
    expect(existsSync(join(ws, "denied.txt"))).toBe(false);
    expect(result.executionAuthority).toBeUndefined();
  });
});
