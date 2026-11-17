/**
 * Task contracts, assignment 2 — desktop wiring of Brain's routing call.
 *
 * main.ts cannot be imported in a unit test (it starts Electron), so these
 * are assertions about its source, in the style of the other main.ts checks.
 * They confirm the wiring is present; the behaviour itself is tested where it
 * lives: `routingPromptContext` and the parser in maestro-core, the contract
 * in orca-core's runtime tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(__dirname, "main.ts"), "utf8");
const brainRoute = main.slice(main.indexOf("async function brainRoute("), main.indexOf("// ── Maestro adapter"));

describe("brainRoute", () => {
  it("builds its prompt from the routing context, not the full task context (T14)", () => {
    expect(brainRoute).toMatch(/buildTaskPrompt\(\{ \.\.\.task, context: routingPromptContext\(task\.context\) \}\)/);
    expect(brainRoute.match(/buildTaskPrompt\(/g)).toHaveLength(1);
  });

  it("gives the decision room for a contract and returns Brain's own proposal only", () => {
    expect(brainRoute).toMatch(/maxTokens: 768/);
    expect(brainRoute).toMatch(/const contractProposal = route\.fallback \? undefined : decision\?\.contract;/);
  });
});

describe("the Maestro result", () => {
  it("carries the proposal and the role's tool names out to the runtime, on both paths", () => {
    expect(main.match(/contractProposal: (?:params|routing)\.contractProposal \} : \{\}\)/g)).toHaveLength(2);
    expect(main.match(/roleToolNames: /g)).toHaveLength(2);
  });

  it("workers still receive Dewey's brief", () => {
    expect(main).toMatch(/\.\.\.deweyBriefLines\(task\)\.map/);
  });

  it("nothing in the desktop reads the task contract yet (no enforcement in this assignment)", () => {
    expect(main).not.toMatch(/taskContract/);
    expect(readFileSync(join(__dirname, "agents", "ReactAgentAdapter.ts"), "utf8")).not.toMatch(/taskContract|contractProposal/);
  });
});
