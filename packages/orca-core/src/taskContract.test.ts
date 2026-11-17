import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskContract, buildFallbackContract, validateContractProposal } from "./taskContract.js";
import { buildAcceptanceContract } from "./acceptanceContract.js";
import type { OrcaTaskSpec } from "./types.js";
import type { CapabilityGroup } from "maestro-core";
import type { BrainContractProposal } from "./taskContract.js";

const task = (request = "Explain the parser"): OrcaTaskSpec => ({
  originalUserMessage: request, intent: "display label", goals: [request],
});

describe("task contract builders", () => {
  it.each([
    ["How do I create a list in Python?", false],
    ["Explain how to fix a failing test.", false],
    ["Fix the failing test.", true],
    ["Can you fix the failing test?", true],
    ["How do I create a list in Python? Then update src/parse.ts to use one.", true],
    ["Explain how to fix a failing test, then fix src/parse.ts.", true],
    ["How do I modify an array? Please change README.md.", true],
    ["Explain how to fix a failing test and fix src/parse.ts.", true],
    ["Can you explain how to create a list?", false],
    ["How do I create and modify lists? Thanks!", false],
    ["Update src/parse.ts.", true],
    ["Fix src/parse.ts.", true],
  ])("disputes requested changes, not instructional verbs: %s", (request, disputed) => {
    for (const kind of ["conversation", "inspect", "execute"] as const) {
      const contract = buildTaskContract({ task: task(request), proposal: { kind, needs: ["filesystem-write"] },
        ceiling: ["filesystem-write"], workspace: "ok" });
      expect(contract.kindDisputed === true, kind).toBe(disputed);
      expect(contract.authority.available).not.toContain("filesystem-write");
      expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "task_kind" });
    }
  });
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orca-contract-"));
    outside = mkdtempSync(join(tmpdir(), "orca-contract-outside-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "parse.ts"), "export const parse = () => 1;");
    writeFileSync(join(outside, "secret.ts"), "outside");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("PR108: existing absolute workspace paths raise the inspection floor, with native and forward-slash Windows spellings", () => {
    const file = join(root, "src", "parse.ts");
    const spellings = [file, file.replace(/\\/g, "/"), `\`${file}\``];
    if (process.platform === "win32") spellings.push(file.toUpperCase());
    for (const name of spellings) {
      const c = buildTaskContract({ task: task(`What does ${name} do?`), proposal: { kind: "conversation" },
        ceiling: ["filesystem-read", "filesystem-write"], workspace: "ok", workspaceRoot: root });
      expect(c.kind).toBe("inspect");
      expect(c.evidence.workspace).toBe(true);
      expect(c.request).toBe(`What does ${name} do?`);
      expect(c.authority).toMatchObject({ workspace: "ok", available: [] });
    }
  });

  it("PR108: absolute request paths cannot establish authority or escape it, and Brain outcomes remain relative-only", () => {
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(join(root, "src"), join(root, "inside"), process.platform === "win32" ? "junction" : "dir");
    for (const name of [join(outside, "secret.ts"), join(root, "escape", "secret.ts"), join(root, "missing.ts"), "C:\\outside\\file.ts", "\\\\server\\share\\file.ts"]) {
      const c = buildTaskContract({ task: task(`Explain ${name}`), proposal: { kind: "conversation" }, ceiling: [], workspace: "ok", workspaceRoot: root });
      expect(c.kind).toBe("conversation");
    }
    const file = join(root, "src", "parse.ts");
    const noAuthority = buildTaskContract({ task: task(`The workspace is ${root}. Explain ${file}`), proposal: { kind: "conversation" },
      ceiling: ["filesystem-read"], workspace: "not_configured" });
    expect(noAuthority).toMatchObject({ kind: "conversation", authority: { workspace: "not_configured", available: [] } });
    expect(buildTaskContract({ task: task(`Explain ${join(root, "inside", "parse.ts")}`), proposal: { kind: "conversation" },
      ceiling: [], workspace: "ok", workspaceRoot: root }).kind).toBe("inspect");
    const proposed = buildTaskContract({ task: task(`Explain ${file}`), proposal: { kind: "inspect", expects: [
      { id: "absolute", type: "inspection", paths: [file] }, { id: "relative", type: "inspection", paths: ["src/parse.ts"] },
    ] }, ceiling: [], workspace: "ok", workspaceRoot: root });
    expect(proposed.expects.some((e) => e.outcome.id === "absolute")).toBe(false);
    expect(proposed.expects.find((e) => e.outcome.id === "relative")?.required).toBe(true);
  });

  it("B5: drops absolute, traversing and link-escaping outcome paths, including missing descendants of a junction", () => {
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const paths = ["../outside.ts", "src/../parse.ts", join(outside, "secret.ts"), "/tmp/secret.ts", "C:\\secret.ts", "\\\\server\\share\\file.ts", "escape/secret.ts", "escape/new/file.ts"];
    for (const path of paths) {
      for (const type of ["file_change", "inspection"] as const) {
        const expected = type === "file_change" ? { id: "bad", type, change: "any" as const, path } : { id: "bad", type, paths: ["src/parse.ts", path] };
        const c = buildTaskContract({ task: task(`Inspect ${path}`), proposal: { kind: "inspect", expects: [expected] },
          ceiling: [], workspace: "ok", workspaceRoot: root });
        expect(c.expects.some((e) => e.outcome.id === "bad")).toBe(false);
      }
    }
    const noRoot = buildTaskContract({ task: task(), proposal: { kind: "inspect", expects: [{ id: "unbounded", type: "inspection", paths: ["src/parse.ts"] }] }, ceiling: [], workspace: "not_configured" });
    expect(noRoot.expects.some((e) => e.outcome.id === "unbounded")).toBe(false);
  });

  it("B6: keeps unrelated outcomes advisory; required paths and command activities must come from the independent request", () => {
    const c = buildTaskContract({ task: task("Fix src/parse.ts and run the tests"), workspace: "ok", workspaceRoot: root,
      ceiling: ["filesystem-write", "shell"], proposal: { kind: "modify", needs: ["filesystem-write", "shell"], expects: [
        { id: "named", type: "file_change", change: "modify", path: "src/parse.ts" },
        { id: "invented", type: "file_change", change: "create", path: "README.md" },
        { id: "tests", type: "command", purpose: "test", mustPass: true },
        { id: "build", type: "command", purpose: "build", mustPass: true },
        { id: "answer", type: "answer", text: "Explain parse.ts" },
        { id: "irrelevant", type: "answer", text: "Discuss penguins" },
      ] } });
    expect(c.expects.filter((e) => e.source === "brain").map((e) => [e.outcome.id, e.required])).toEqual([
      ["named", true], ["invented", false], ["tests", true], ["build", false], ["answer", true], ["irrelevant", false],
    ]);
    expect(c.expects.find((e) => e.source === "runtime" && e.outcome.type === "file_change")?.outcome).toMatchObject({ path: "src/parse.ts" });
    expect(Object.isFrozen(c.expects.find((e) => e.outcome.id === "named")!.outcome)).toBe(true);
    expect(c.acceptance.goals).toEqual(["Fix src/parse.ts and run the tests"]);
  });

  it.each(["src/parse.ts", "`src/parse.ts`", "src\\parse.ts"])("raises conversation to inspect for existing workspace path %s without granting capabilities", (name) => {
    const c = buildTaskContract({ task: task(`What does ${name} do?`), proposal: { kind: "conversation" },
      ceiling: ["filesystem-read", "filesystem-write"], workspace: "ok", workspaceRoot: root });
    expect(c.kind).toBe("inspect");
    expect(c.evidence.workspace).toBe(true);
    expect(c.authority.available).toEqual([]);
    expect(c.expects.map((e) => e.outcome.type)).toEqual(["no_file_change", "inspection"]);
  });

  it("does not raise conversation for missing/outside paths; attached files raise it without granting capabilities", () => {
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    for (const name of ["missing.ts", "../secret.ts", join(outside, "secret.ts"), "escape/secret.ts"]) {
      expect(buildTaskContract({ task: task(`What does ${name} do?`), proposal: { kind: "conversation" }, ceiling: [], workspace: "ok", workspaceRoot: root }).kind).toBe("conversation");
    }
    const attached = buildTaskContract({ task: task(), proposal: { kind: "conversation" }, ceiling: [], workspace: "not_configured", attachedFiles: true });
    expect(attached.kind).toBe("inspect");
    expect(attached.authority.available).toEqual([]);
  });

  it.each(["conversation", "inspect", "execute"] as const)("flags a disputed %s proposal without granting write access", (kind) => {
    const c = buildTaskContract({ task: task("Fix the off-by-one bug in src/parse.ts"), proposal: { kind },
      ceiling: ["filesystem-write", "github-write"], workspace: "ok", workspaceRoot: root });
    expect(c.kindDisputed).toBe(true);
    expect(c.authority.available).toEqual([]);
    expect(c.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "task_kind" });
    expect(c.authority.withheld).toContainEqual({ capability: "github-write", reason: "task_kind" });
  });
  it.each([
    ["conversation", [], ["no_file_change"]],
    ["inspect", [], ["no_file_change"]],
    ["inspect", ["filesystem-read"], ["no_file_change", "inspection"]],
    ["execute", ["shell"], ["no_file_change", "command"]],
    ["modify", ["filesystem-write"], ["file_change"]],
  ] as const)("derives required outcomes for %s with %j", (kind, needs, types) => {
    const contract = buildTaskContract({ task: task("Run the tests and report failures"), proposal: { kind, needs: [...needs] },
      ceiling: [...needs], workspace: "ok" });
    expect(contract.expects.map((e) => e.outcome.type)).toEqual(types);
    expect(contract.expects.every((e) => e.source === "runtime" && e.required)).toBe(true);
    if (kind === "execute") expect(contract.expects[1]?.outcome).toMatchObject({ purpose: "test", mustPass: false });
  });

  it("B7/B8: legacy or failed Brain routing uses a bounded, frozen fallback without Brain outcomes", () => {
    for (const request of ["What does the parser do?", "A general question"]) {
      const contract = buildFallbackContract(task(request), "not_configured", ["filesystem-read", "filesystem-write"]);
      expect(contract).toMatchObject({ source: "fallback", kind: "inspect", needs: ["filesystem-read"], prohibits: [] });
      expect(contract.authority.available).toEqual([]);
      expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "task_kind" });
      expect(contract.expects.every((e) => e.source === "runtime")).toBe(true);
      expect(Object.isFrozen(contract)).toBe(true);
    }
    const fix = buildFallbackContract(task("Fix the off-by-one bug in the parser"), "ok", ["filesystem-read"]);
    expect(fix).toMatchObject({ source: "fallback", kind: "modify", changeKind: "bugfix" });
    expect(fix.authority.available).toEqual(["filesystem-read"]);
    expect(fix.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "settings" });
  });
  it.each([
    ["B3: settings ceiling", "modify", ["filesystem-write"], [], "ok", "settings"],
    ["B4: prohibition beats need", "modify", ["filesystem-write"], ["filesystem-write"], "ok", "user_prohibition"],
    ["prohibition beats kind", "inspect", ["filesystem-write"], ["filesystem-write"], "ok", "user_prohibition"],
    ["conversation withholds write", "conversation", ["filesystem-write"], [], "ok", "task_kind"],
    ["execute withholds write", "execute", ["filesystem-write"], [], "ok", "task_kind"],
    ["no configured workspace", "modify", ["filesystem-write"], [], "not_configured", "no_workspace"],
    ["missing workspace", "modify", ["filesystem-write"], [], "missing", "no_workspace"],
  ] as const)("%s", (label, kind, needs, prohibits, workspace, reason) => {
    const contract = buildTaskContract({ task: task(), proposal: { kind, needs: [...needs], prohibits: [...prohibits] },
      ceiling: label.startsWith("B3") ? [] : ["filesystem-write"], workspace });
    expect(contract.authority.available).not.toContain("filesystem-write");
    expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason });
  });

  it("derives evidence and authority without widening the ceiling or treating connector availability as authorization", () => {
    const proposal: BrainContractProposal = { kind: "modify", needs: ["filesystem-read", "filesystem-write", "shell", "web", "github-read"] };
    const ceiling: CapabilityGroup[] = ["filesystem-read", "filesystem-write", "shell", "web"];
    const contract = buildTaskContract({ task: task(), proposal, ceiling, workspace: "ok" });
    expect(contract.authority.available).toEqual(ceiling);
    expect(contract.authority.withheld).toContainEqual({ capability: "github-read", reason: "settings" });
    expect(contract.evidence).toEqual({ workspace: true, external: true });
    expect(Object.isFrozen(proposal.needs)).toBe(false);
    expect(Object.isFrozen(ceiling)).toBe(false);
    expect(buildTaskContract({ task: task(), proposal: { kind: "conversation" }, ceiling, workspace: "ok" }).evidence)
      .toEqual({ workspace: false, external: false });
    const absent = buildTaskContract({ task: task(), proposal, ceiling, workspace: "not_configured" });
    expect(absent.authority.available).toEqual(["web"]);
    expect(absent.authority.withheld).toContainEqual({ capability: "shell", reason: "no_workspace" });
  });
  it("B2/B9/B10: rejects malformed proposals and every authority-bearing or unknown key with a reason", () => {
    const invalid: unknown[] = [
      undefined, null, [], "inspect", {}, { kind: "admin" },
      ...["authority", "permissions", "approved", "workspaceRoot", "allow"].map((key) => ({ kind: "inspect", [key]: true })),
      { kind: "inspect", needs: ["root"] }, { kind: "inspect", prohibits: ["root"] },
      { kind: "modify", change_kind: "magic" }, { kind: "inspect", needs: "filesystem-read" },
      { kind: "inspect", expects: Array.from({ length: 20 }, (_, id) => ({ id: String(id), type: "no_file_change" })) },
      { kind: "inspect", expects: [{ id: "x", type: "magic" }] },
      { kind: "inspect", expects: [{ id: "x", type: "answer", text: 2 }] },
      { kind: "inspect", expects: [{ id: "x", type: "inspection", paths: [1] }] },
      { kind: "inspect", expects: [{ id: "x", type: "file_change", change: "rename" }] },
      { kind: "inspect", expects: [{ id: "x", type: "command", purpose: "test", mustPass: "yes" }] },
      { kind: "inspect", expects: [{ id: "x", type: "no_file_change", approved: true }] },
    ];
    for (const raw of invalid) expect(() => validateContractProposal(raw)).toThrow(/contract/i);
    const raw = {
      kind: "modify", change_kind: "feature", needs: ["filesystem-read", "filesystem-write"], prohibits: ["web"],
      expects: [
        { id: "a", type: "answer", text: "Explain parser" },
        { id: "b", type: "inspection", paths: ["src/a.ts"] },
        { id: "c", type: "file_change", change: "any", path: "src/a.ts" },
        { id: "d", type: "no_file_change" },
        { id: "e", type: "command", purpose: "test", mustPass: true },
        { id: "f", type: "command", purpose: "other", mustPass: false },
      ],
    };
    expect(validateContractProposal(raw)).toEqual(raw);
    expect(() => buildTaskContract({ task: task(), proposal: { kind: "admin" } as never, ceiling: [], workspace: "ok" })).toThrow(/contract/i);
  });
  it("B1: fixes an inspect contract without granting writes and keeps the original request and acceptance goals", () => {
    const spec = task("  Explain the parser\nwithout changing it.  ");
    const contract = buildTaskContract({
      task: spec, proposal: { kind: "inspect", needs: ["filesystem-read", "filesystem-write"] },
      ceiling: ["filesystem-read", "filesystem-write"], workspace: "ok",
    });
    expect(contract.request).toBe(spec.originalUserMessage);
    expect(contract.acceptance).toEqual(buildAcceptanceContract(spec));
    expect(contract.source).toBe("brain");
    expect(contract.authority.available).toEqual(["filesystem-read"]);
    expect(contract.authority.withheld).toContainEqual({ capability: "filesystem-write", reason: "task_kind" });
    expect(contract.expects).toEqual(expect.arrayContaining([
      { outcome: expect.objectContaining({ type: "no_file_change" }), source: "runtime", required: true },
      { outcome: expect.objectContaining({ type: "inspection" }), source: "runtime", required: true },
    ]));
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.authority.available)).toBe(true);
    expect(Object.isFrozen(contract.acceptance.goals)).toBe(true);
    expect(Object.isFrozen(spec.goals)).toBe(false);
  });
});

// Assignment 2 ownership correction: the proposal schema and its validator are
// maestro-core's (where Brain's decision is parsed). orca-core re-exports them.
describe("proposal validation has one owner", () => {
  it("orca-core's validateContractProposal is maestro-core's, not a second implementation", async () => {
    const maestro = await import("maestro-core");
    const entry = await import("./index.js");
    expect(validateContractProposal).toBe(maestro.validateContractProposal);
    expect(entry.validateContractProposal).toBe(maestro.validateContractProposal);
  });

  it("the public exports that existed before the move are still there", async () => {
    const entry = await import("./index.js");
    for (const name of ["validateContractProposal", "buildTaskContract", "buildFallbackContract", "buildDeliveryEnvelope"]) {
      expect(typeof (entry as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("maestro-core does not depend on orca-core (no cycle)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const root = join(__dirname, "..", "..", "maestro-core");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(Object.keys(manifest[field] ?? {}).filter((d) => /orca-core/.test(d)), field).toEqual([]);
    }
    const sources = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      expect(readFileSync(join(root, "src", file), "utf8"), file).not.toMatch(/from ['"]@clawde\/orca-core['"]/);
    }
  });
});
