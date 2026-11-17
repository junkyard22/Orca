import { describe, expect, it } from "vitest";
import { explicitUserProhibitions } from "./userProhibitions.js";
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
    "Do not modify any files other than README.md. Correct the typo there.",
    "Don't modify any files except src/a.ts",
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
    expect(contract.prohibits).toEqual(["filesystem-write"]);
    expect(contract.authority.available).toEqual([]);
    expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "user_prohibition" });
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
