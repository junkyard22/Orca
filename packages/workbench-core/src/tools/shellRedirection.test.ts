/**
 * Redirections as each shell reads them (1.7.0, after live rehearsal A6, where
 * `npm test 2>&1` was recorded as creating a file named "&1").
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRedirections, redirectionsRequireApproval, runCommandShellDialect, type ShellDialect } from "./shellRedirection.js";
import { detectFileChanges, runCommandTool } from "./runCommandTool.js";
import { createSandboxPolicy, evaluateCommandPolicy } from "./sandbox.js";

const kinds = (command: string, dialect: ShellDialect) =>
  parseRedirections(command, dialect).map((e) => (e.kind === "file" ? `file:${e.fd}${e.append ? "+" : ""}:${e.target}` : e.kind === "device" ? `device:${e.fd}:${e.target}` : e.kind === "descriptor" ? `dup:${e.fd}>&${e.to}` : `unresolved`));

describe("descriptor duplication is not a file (the A6 defect)", () => {
  for (const dialect of ["cmd", "posix", "powershell"] as const) {
    it(`${dialect}: npm test 2>&1 duplicates stderr onto stdout and writes no file`, () => {
      expect(kinds("npm test 2>&1", dialect)).toEqual(["dup:2>&1"]);
      expect(detectFileChanges("npm test 2>&1", process.cwd(), dialect)).toEqual([]);
      expect(redirectionsRequireApproval("npm test 2>&1", dialect)).toBe(false);
    });
    it(`${dialect}: 1>&2 writes no file`, () => {
      expect(kinds("node x.js 1>&2", dialect)).toEqual(["dup:1>&2"]);
    });
  }
});

describe("real file redirections stay visible", () => {
  const cases: Array<[ShellDialect, string, string[]]> = [
    ["cmd", "node gen.js > out.txt", ["file:1:out.txt"]],
    ["cmd", "node gen.js 2> errors.log", ["file:2:errors.log"]],
    ["cmd", "node gen.js >> out.txt", ["file:1+:out.txt"]],
    ["cmd", "node gen.js 2>> errors.log", ["file:2+:errors.log"]],
    ["cmd", "node gen.js > out.txt 2>&1", ["file:1:out.txt", "dup:2>&1"]],
    ["cmd", "node gen.js >\"my out.txt\"", ["file:1:my out.txt"]],
    ["posix", "node gen.js > out.txt", ["file:1:out.txt"]],
    ["posix", "node gen.js 2> errors.log", ["file:2:errors.log"]],
    ["posix", "node gen.js >> out.txt", ["file:1+:out.txt"]],
    ["posix", "node gen.js &> combined.log", ["file:both:combined.log"]],
    ["posix", "node gen.js &>> combined.log", ["file:both+:combined.log"]],
    ["posix", "node gen.js >& combined.log", ["file:both:combined.log"]],
    ["posix", "node gen.js > out.txt 2>&1", ["file:1:out.txt", "dup:2>&1"]],
    ["posix", "node gen.js >| forced.txt", ["file:1:forced.txt"]],
    ["posix", "node gen.js > 'my out.txt'", ["file:1:my out.txt"]],
    ["powershell", "node gen.js > out.txt", ["file:1:out.txt"]],
    ["powershell", "node gen.js 2>> errors.log", ["file:2+:errors.log"]],
    ["powershell", "node gen.js *> all.log", ["file:all:all.log"]],
  ];
  for (const [dialect, command, expected] of cases) {
    it(`${dialect}: ${command}`, () => {
      expect(kinds(command, dialect)).toEqual(expected);
      expect(redirectionsRequireApproval(command, dialect)).toBe(true);
    });
  }
});

describe("devices, quoting and escaping", () => {
  it("cmd: 2>nul and >NUL are the null device, not files", () => {
    expect(kinds("npm test 2>nul", "cmd")).toEqual(["device:2:nul"]);
    expect(kinds("npm test >NUL 2>&1", "cmd")).toEqual(["device:1:NUL", "dup:2>&1"]);
    expect(detectFileChanges("npm test >NUL 2>&1", process.cwd(), "cmd")).toEqual([]);
  });
  it("posix: /dev/null; powershell: $null", () => {
    expect(kinds("npm test 2>/dev/null", "posix")).toEqual(["device:2:/dev/null"]);
    expect(kinds("npm test 2>$null", "powershell")).toEqual(["device:2:$null"]);
  });
  it("a discarded error stream needs no approval; stdout to a device still does (unchanged rule)", () => {
    expect(redirectionsRequireApproval("npm test 2>nul", "cmd")).toBe(false);
    expect(redirectionsRequireApproval("npm test >nul", "cmd")).toBe(true);
  });
  it("quoted text containing 2>&1 or > is an argument, not a redirection", () => {
    expect(kinds(`node -e "console.log('npm test 2>&1 > x.txt')"`, "cmd")).toEqual([]);
    expect(kinds(`echo 'a > b' "c 2>&1"`, "posix")).toEqual([]);
    expect(kinds(`echo 'a > b'`, "powershell")).toEqual([]);
  });
  it("escaped redirection characters are literal", () => {
    expect(kinds("echo a ^> b", "cmd")).toEqual([]);
    expect(kinds("echo a \\> b", "posix")).toEqual([]);
    expect(kinds("echo a `> b", "powershell")).toEqual([]);
  });
  it("a here-document body is data, not commands", () => {
    expect(kinds("cat <<EOF\na > b\n2>&1 c\nEOF\necho done > done.txt", "posix")).toEqual(["file:1:done.txt"]);
  });
});

describe("shell dialects differ", () => {
  it("cmd treats & as a command separator: `npm test &> out.log` runs npm test, then redirects an empty command into out.log", () => {
    expect(kinds("npm test &> out.log", "cmd")).toEqual(["file:1:out.log"]);
  });
  it("cmd has no `>&file`; posix (bash) does", () => {
    expect(kinds("node gen.js >& out.log", "posix")).toEqual(["file:both:out.log"]);
    expect(kinds("node gen.js >& out.log", "cmd")).toEqual(["unresolved"]);
  });
  it("run_command uses cmd.exe on Windows and /bin/sh elsewhere", () => {
    expect(runCommandShellDialect("win32")).toBe("cmd");
    expect(runCommandShellDialect("linux")).toBe("posix");
    expect(runCommandShellDialect("darwin")).toBe("posix");
  });
  it("Git Bash / sh inline scripts are read with POSIX rules, cmd /c with cmd rules, PowerShell -Command with PowerShell rules", () => {
    expect(kinds(`"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test 2>&1 > log.txt"`, "cmd")).toEqual(["dup:2>&1", "file:1:log.txt"]);
    expect(kinds(`sh -c 'npm test 2>&1'`, "posix")).toEqual(["dup:2>&1"]);
    expect(kinds(`cmd /c "npm test > out.txt 2>nul"`, "posix")).toEqual(["file:1:out.txt", "device:2:nul"]);
    expect(kinds(`powershell -NoProfile -Command "npm test *> all.log"`, "cmd")).toEqual(["file:all:all.log"]);
  });
  it("a command with both a descriptor redirect and a real file redirect keeps the file and drops only the phantom", () => {
    expect(detectFileChanges("npm test 2>&1 > results.txt", process.cwd(), "cmd")).toEqual([{ path: "results.txt", changeType: "A" }]);
  });
});

describe("unknown or malformed syntax is never treated as safe, and no filename is invented", () => {
  const unresolved: Array<[ShellDialect, string]> = [
    ["posix", "npm test > $LOG"],
    ["posix", "npm test > ~/out.txt"],
    ["posix", "npm test > out_*.txt"],
    ["posix", "npm test > >(tee x)"],
    ["posix", "npm test >"],
    ["cmd", "npm test > %TEMP%\\out.txt"],
    ["cmd", "npm test 2>&x"],
    ["powershell", "npm test > $env:LOG"],
    ["powershell", "npm test | Out-File results.txt"],
    ["powershell", "powershell -EncodedCommand ZQBjAGgAbwA="],
  ];
  for (const [dialect, command] of unresolved) {
    it(`${dialect}: ${command}`, () => {
      expect(parseRedirections(command, dialect).some((e) => e.kind === "unresolved")).toBe(true);
      expect(redirectionsRequireApproval(command, dialect)).toBe(true);
      expect(detectFileChanges(command, process.cwd(), dialect)).toEqual([]);
    });
  }
  it("an unterminated quote is reported as unparseable, not as safe", () => {
    expect(kinds(`node -e "x > y`, "cmd")).toEqual(["unresolved"]);
    expect(redirectionsRequireApproval(`node -e "x > y`, "cmd")).toBe(true);
  });
});

describe("command policy (approval): never weaker than before", () => {
  const policy = createSandboxPolicy();
  for (const dialect of ["cmd", "posix"] as const) {
    it(`${dialect}: 2>&1 adds no approval; a file redirect, a run-time target or a nested-shell write needs one`, () => {
      expect(evaluateCommandPolicy("npm test 2>&1", policy, dialect).reason).not.toMatch(/redirection/);
      expect(evaluateCommandPolicy("npm test > out.txt", policy, dialect).requiresApproval).toBe(true);
      expect(evaluateCommandPolicy("npm test > ../outside.txt", policy, dialect).requiresApproval).toBe(true);
      expect(evaluateCommandPolicy(`bash -c "npm test > out.txt"`, policy, dialect).requiresApproval).toBe(true);
    });
  }
  it("posix: `&>file` and `>& file`, which the earlier pattern missed, now need approval", () => {
    expect(evaluateCommandPolicy("npm test &>out.log", policy, "posix").requiresApproval).toBe(true);
    expect(evaluateCommandPolicy("npm test >& out.log", policy, "posix").requiresApproval).toBe(true);
  });
  it("dangerous commands are still blocked regardless of redirections", () => {
    expect(evaluateCommandPolicy("rm -rf / 2>&1", policy, "posix").allowed).toBe(false);
  });
});

describe("run_command on this machine's shell", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "orca-redirect-"));
  const run = (command: string, workspaceRoot: string) => runCommandTool.execute(
    { command, timeout: 15_000 },
    { workspaceRoot, runId: "r", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true },
  );

  it("`node … 2>&1` reports no file change and creates no '&1' file", async () => {
    const root = dir();
    const result = await run(`node -e "console.error('to stderr'); console.log('to stdout')" 2>&1`, root);
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/to stderr/);
    expect(result.output).not.toMatch(/Files changed/);
    expect(existsSync(join(root, "&1"))).toBe(false);
  });

  it("a real stdout redirect, a stderr redirect and an append are reported and exist on disk", async () => {
    const root = dir();
    const out = await run(`node -e "console.log('hello')" > out.txt`, root);
    expect(out.output).toMatch(/<!-- Files changed: \[\{"path":"out\.txt","changeType":"A"\}\] -->/);
    expect(readFileSync(join(root, "out.txt"), "utf8")).toMatch(/hello/);
    const err = await run(`node -e "console.error('oops')" 2> errors.log`, root);
    expect(err.output).toMatch(/"path":"errors\.log"/);
    expect(readFileSync(join(root, "errors.log"), "utf8")).toMatch(/oops/);
    const app = await run(`node -e "console.log('again')" >> out.txt`, root);
    expect(app.output).toMatch(/"path":"out\.txt","changeType":"M"/);
    expect(readFileSync(join(root, "out.txt"), "utf8")).toMatch(/hello[\s\S]*again/);
  });

  it("both at once: the file is reported, the descriptor duplicate is not", async () => {
    const root = dir();
    const result = await run(`node -e "console.error('e'); console.log('o')" > both.txt 2>&1`, root);
    expect(result.output).toMatch(/<!-- Files changed: \[\{"path":"both\.txt","changeType":"A"\}\] -->/);
    expect(readFileSync(join(root, "both.txt"), "utf8")).toMatch(/e[\s\S]*o|o[\s\S]*e/);
  });
});
