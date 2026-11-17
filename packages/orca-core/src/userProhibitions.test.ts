import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitUserProhibitions, userRestrictions } from "./userProhibitions.js";
import { createUserRestrictionGate } from "./userRestrictionGate.js";
import { buildFallbackContract, buildTaskContract } from "./taskContract.js";
import type { OrcaTaskSpec } from "./types.js";

const task = (message: string) => ({ originalUserMessage: message, intent: message, goals: [message] }) as OrcaTaskSpec;

describe("explicitUserProhibitions", () => {
  it.each([
    "Explain how to correct the bug, but do not modify any files.",
    "Do not modify any files. How do I add a new route?",
    "Don't change anything, just explain the error",
    "don’t edit the code",
    "Review src/a.ts without making any changes.",
    "Please don't make any changes to the files",
    "Make no changes; describe the fix",
    "Leave the files untouched and tell me what is wrong",
    "You must not write files",
    "Never touch the repo",
    "do not modify anything at all",
  ])("withholds filesystem-write: %s", (request) => {
    expect(explicitUserProhibitions(request)).toContain("filesystem-write");
  });

  it.each([
    "Don't execute commands. Explain why the tests fail.",
    "Do not run anything; read the logs instead",
    "Explain the failure without running any commands.",
    "don't use the terminal",
    "Never execute scripts here",
    "Read the code. No commands.",
  ])("withholds shell: %s", (request) => {
    expect(explicitUserProhibitions(request)).toContain("shell");
  });

  it.each([
    "Correct the typo in README.md",
    "Fix the typo in README.md, but don't modify the tests.",
    "Fix the parser but don't update code comments",
    "Don't make any changes to the public API; fix the bug",
    "Don't forget to update the files",
    "Don't hesitate to modify any files you need",
    "Run the tests but don't run commands that delete data",
    "Fix the bug and don't run the tests",
    "",
  ])("leaves ordinary or object-specific requests alone: %s", (request) => {
    expect(explicitUserProhibitions(request)).toEqual([]);
  });

  it("a blanket no-write also withholds shell: an approved command could change files", () => {
    expect(explicitUserProhibitions("Explain how to correct the bug, but do not modify any files.").sort()).toEqual(["filesystem-write", "shell"]);
  });

  it.each([
    ["Modify README.md, but do not change any other files.", ["README.md"]],
    ["Only edit README.md.", ["README.md"]],
    ["Edit only `docs/guide.md`; nothing more", ["docs/guide.md"]],
    ["Fix the typo. Don't touch any files except README.md.", ["README.md"]],
    ["Do not modify any files other than README.md and src/a.ts.", ["README.md", "src/a.ts"]],
    ["Leave all other files unchanged and correct README.md", ["README.md"]],
    ["Update src/a.ts but don't change anything else. See src/b.ts for context.", ["src/a.ts"]],
  ])("a scoped prohibition limits writes to the named files: %s", (request, scope) => {
    const result = userRestrictions(request);
    expect(result.writeScope).toEqual(scope);
    expect(result.prohibits).toEqual(["shell"]);
  });

  it("a scope that names no file permits no writes at all", () => {
    expect(userRestrictions("Fix the bug but do not change any other files.")).toEqual({ prohibits: ["shell", "filesystem-write"] });
  });

  it("ignores non-string input and never returns a grant", () => {
    expect(explicitUserProhibitions(undefined)).toEqual([]);
    expect(explicitUserProhibitions({ needs: ["filesystem-write"] })).toEqual([]);
    const result = explicitUserProhibitions("Don't modify any files and don't run any commands.");
    expect(result.sort()).toEqual(["filesystem-write", "shell"]);
  });
});

describe("task contract merges trusted prohibitions", () => {
  const ceiling = ["filesystem-read", "filesystem-write", "shell"] as const;
  it("withholds a capability Brain both needs and omits from prohibits", () => {
    const contract = buildTaskContract({
      task: task("Explain how to correct the bug, but do not modify any files."),
      proposal: { kind: "modify", needs: ["filesystem-write"], prohibits: [] },
      ceiling: [...ceiling], workspace: "ok",
    });
    expect([...contract.prohibits].sort()).toEqual(["filesystem-write", "shell"]);
    expect(contract.authority.available).toEqual([]);
    expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "user_prohibition" });
    expect(contract.authority.withheld).toContainEqual({ capability: "shell", reason: "user_prohibition" });
    expect(Object.isFrozen(contract.prohibits)).toBe(true);
  });
  it("keeps Brain's own prohibitions and cannot remove them", () => {
    const contract = buildTaskContract({
      task: task("Don't execute commands. Explain why the tests fail."),
      proposal: { kind: "execute", needs: ["shell", "filesystem-read"], prohibits: ["filesystem-write"] },
      ceiling: [...ceiling], workspace: "ok",
    });
    expect([...contract.prohibits].sort()).toEqual(["filesystem-write", "shell"]);
    expect(contract.authority.available).toEqual(["filesystem-read"]);
  });
  it("applies to the fallback contract", () => {
    const contract = buildFallbackContract(task("Fix the bug in the parser, but do not modify any files."), "ok", [...ceiling]);
    expect(contract.prohibits).toContain("filesystem-write");
    expect(contract.authority.available).not.toContain("filesystem-write");
  });
  it("does not change an ordinary authorized modify contract", () => {
    const contract = buildTaskContract({
      task: task("Correct the typo in README.md"), proposal: { kind: "modify", needs: ["filesystem-write"] },
      ceiling: [...ceiling], workspace: "ok",
    });
    expect(contract.prohibits).toEqual([]);
    expect(contract.authority.available).toEqual(["filesystem-write"]);
  });
});

describe("createUserRestrictionGate", () => {
  const root = mkdtempSync(join(tmpdir(), "orca-restriction-"));
  writeFileSync(join(root, "README.md"), "x");
  writeFileSync(join(root, "other.txt"), "x");
  const run = (gate: ReturnType<typeof createUserRestrictionGate>, tool: string, args: Record<string, unknown>) =>
    gate!.beforeToolRun({ tool, args, workspaceRoot: root }).allowed;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is absent when the request restricts nothing", () => {
    expect(createUserRestrictionGate(userRestrictions("Correct the typo in README.md"))).toBeUndefined();
  });

  it("scoped: only the named file, by any spelling, and nothing that cannot be checked", () => {
    const gate = createUserRestrictionGate(userRestrictions("Modify README.md, but do not change any other files."), ["mail_send_email"]);
    for (const path of ["README.md", "./README.md", join(root, "README.md"), "sub/../README.md"]) expect(run(gate, "write_file", { path })).toBe(true);
    for (const path of ["other.txt", "sub/../other.txt", join(root, "other.txt"), "new.txt", "README.md/../other.txt"]) expect(run(gate, "write_file", { path })).toBe(false);
    expect(run(gate, "desktop-commander_edit_block", { file_path: "other.txt" })).toBe(false);
    expect(run(gate, "move_file", { source: "other.txt", destination: "README.md" })).toBe(false);
    expect(run(gate, "write_file", {})).toBe(false);
    expect(run(gate, "mail_send_email", { to: "a" })).toBe(false);
    expect(run(gate, "run_command", { command: "type README.md" })).toBe(false);
    expect(run(gate, "read_file", { path: "other.txt" })).toBe(true);
  });

  it("no-write: refuses writes and every shell/process tool, allows reads", () => {
    const gate = createUserRestrictionGate(userRestrictions("Explain the bug but do not modify any files."));
    for (const tool of ["write_file", "desktop-commander_write_file", "run_command", "desktop-commander_start_process", "interact_with_process"]) {
      expect(run(gate, tool, { path: "README.md", command: "x" })).toBe(false);
    }
    expect(run(gate, "read_file", { path: "README.md" })).toBe(true);
    expect(gate!.beforeLLMCall({} as never).allowed).toBe(true);
  });

  it("no-execute alone leaves writes to the other gates", () => {
    const gate = createUserRestrictionGate(userRestrictions("Don't execute commands. Fix README.md."));
    expect(run(gate, "run_command", { command: "x" })).toBe(false);
    expect(run(gate, "write_file", { path: "other.txt" })).toBe(true);
  });
});
