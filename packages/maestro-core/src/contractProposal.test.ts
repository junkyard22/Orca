/**
 * Brain's contract proposal: a pure JSON shape, validated where Brain's
 * decision is parsed. The proposal describes and restricts; nothing in it can
 * grant authority, and no unexpected property is tolerated.
 */
import { describe, it, expect } from "vitest";
import { validateContractProposal } from "./contractProposal";
import * as api from "./index";

const valid = {
  kind: "modify",
  change_kind: "bugfix",
  needs: ["filesystem-read", "filesystem-write", "shell"],
  prohibits: ["web"],
  expects: [
    { id: "e1", type: "file_change", change: "modify", path: "src/parse.js" },
    { id: "e2", type: "command", purpose: "test", mustPass: true },
    { id: "e3", type: "inspection", paths: ["src/parse.js"] },
    { id: "e4", type: "answer", text: "States the root cause" },
    { id: "e5", type: "no_file_change" },
  ],
};

describe("validateContractProposal", () => {
  it("accepts a well-formed proposal and returns only the known fields", () => {
    expect(validateContractProposal(valid)).toEqual(valid);
    expect(validateContractProposal({ kind: "conversation" })).toEqual({ kind: "conversation" });
  });

  it.each([
    ["authority", { authority: { available: ["filesystem-write"] } }],
    ["permissions", { permissions: { fileWrite: true } }],
    ["approved", { approved: true }],
    ["allow", { allow: ["shell"] }],
    ["workspaceRoot", { workspaceRoot: "/" }],
    ["workspace", { workspace: "ok" }],
    ["ceiling", { ceiling: ["filesystem-write"] }],
    ["source", { source: "intake" }],
    ["confidence", { confidence: 0.9 }],
  ])("rejects a proposal carrying %s", (_name, extra) => {
    expect(() => validateContractProposal({ kind: "inspect", ...extra })).toThrow(/unknown key/);
  });

  it.each([
    ["not an object", "modify"],
    ["an array", [{ kind: "modify" }]],
    ["null", null],
    ["a class instance", new (class Proposal { kind = "modify"; })()],
    ["missing kind", {}],
    ["unknown kind", { kind: "admin" }],
    ["unknown change_kind", { kind: "modify", change_kind: "rewrite-everything" }],
    ["unknown capability in needs", { kind: "modify", needs: ["filesystem-write", "root"] }],
    ["unknown capability in prohibits", { kind: "inspect", prohibits: ["everything"] }],
    ["needs that is not an array", { kind: "modify", needs: "filesystem-write" }],
    ["an empty capability", { kind: "modify", needs: [""] }],
    ["expects that is not an array", { kind: "modify", expects: {} }],
    ["more than six outcomes", { kind: "modify", expects: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, type: "no_file_change" })) }],
    ["an unknown outcome type", { kind: "modify", expects: [{ id: "e", type: "grant_access" }] }],
    ["an outcome with an extra key", { kind: "modify", expects: [{ id: "e", type: "no_file_change", approved: true }] }],
    ["an outcome without an id", { kind: "modify", expects: [{ type: "no_file_change" }] }],
    ["a file_change with an unknown change", { kind: "modify", expects: [{ id: "e", type: "file_change", change: "chmod" }] }],
    ["a command whose mustPass is not boolean", { kind: "execute", expects: [{ id: "e", type: "command", purpose: "test", mustPass: "yes" }] }],
    ["an inspection whose paths are not strings", { kind: "inspect", expects: [{ id: "e", type: "inspection", paths: [1] }] }],
  ])("rejects %s", (_name, raw) => {
    expect(() => validateContractProposal(raw)).toThrow(/Invalid contract proposal/);
  });

  it("rejects symbol keys and prototype-smuggled properties", () => {
    expect(() => validateContractProposal({ kind: "inspect", [Symbol("authority")]: true })).toThrow(/unknown key/);
    expect(() => validateContractProposal(Object.create({ kind: "modify", authority: true }))).toThrow(/Invalid contract proposal/);
    expect(() => validateContractProposal(JSON.parse('{"kind":"inspect","__proto__":{"authority":true}}'))).toThrow(/unknown key/);
  });

  it("is exported from the package entry point with its types' runtime companions", () => {
    expect(api.validateContractProposal).toBe(validateContractProposal);
  });
});
