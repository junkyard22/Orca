/**
 * Task contracts, assignment 2 — desktop wiring of Brain's routing call.
 *
 * These source assertions preserve the original routing-prompt checks.
 * contractRouting.test.ts imports the adapter with Electron startup mocked.
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

  it("keeps proposal parsing out of the worker loop; routing behavior is covered by contractRouting", () => {
    // Assignment 3 consumes the fixed contract in Maestro. Workers still do
    // not parse proposals or grant themselves authority from a contract.
    expect(readFileSync(join(__dirname, "agents", "ReactAgentAdapter.ts"), "utf8")).not.toMatch(/taskContract|contractProposal/);
  });
});
