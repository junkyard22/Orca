/**
 * End-to-end Find & Fix verification — the 2026-10-08 Live AI failure path.
 *
 * Chains the real pieces main.ts uses for a direct route: routing policy →
 * acceptance criteria → worker output text (command summary or agent text) →
 * buildPappyInput with runtime workspace evidence → the Pappy port. Brain is
 * absent (the 09:44 run's Brain call failed), which is the case that used to
 * reroute the task to command verification.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPappyInput,
  captureWorkspaceSnapshot,
  createPappyPort,
  diffWorkspaceSnapshots,
  type OrcaTaskSpec,
} from "@clawde/orca-core";
import { normalizeDesktopRoutingForExecution } from "./routingPolicy";
import { buildCommandVerificationSummary, isCommandVerificationCriteria } from "./commandVerificationSummary";

const FIXTURES = join(__dirname, "..", "..", "..", "packages", "pappy-core", "src", "checks", "__fixtures__", "find-fix");
const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const FIND_FIX =
  "Users reported a bug in this meeting-room booking app (see ISSUE.md). Investigate the repository, identify the root cause, " +
  "and implement the smallest correct fix in the source code. Then run the project's test suite and verify that the reported " +
  "problem is actually resolved. Do not change unrelated behavior or modify the existing tests.";
const spec: OrcaTaskSpec = { originalUserMessage: FIND_FIX, intent: FIND_FIX, goals: [FIND_FIX] } as OrcaTaskSpec;

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-findfix-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "room-booking", type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "ISSUE.md"), fx("ISSUE.md"));
  writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt"));
  writeFileSync(join(root, "test", "bookings.test.js"), fx("bookings.test.base.txt"));
  return root;
}

const npmTest = (fixture: string) => {
  const output = fx(fixture);
  const ok = !output.startsWith("[Exit code");
  return { tool: "run_command", ok, summary: ok ? "run_command: ok" : "run_command: failed", raw: { command: "npm test", _outputForProof: output } };
};
const writeEvent = (path: string, content: string) =>
  ({ tool: "write_file", ok: true, summary: "write_file: ok", raw: { path, content, _contentForDiff: content } });

async function verify(root: string, act: () => { toolEvents: ReturnType<typeof npmTest>[] | unknown[]; agentText: string }) {
  const routing = normalizeDesktopRoutingForExecution(spec, null, null).decision;
  const doneCriteria = routing.routing === "direct" ? routing.done_criteria ?? [] : [];
  const baseline = await captureWorkspaceSnapshot(root);
  const { toolEvents, agentText } = act();
  const outputText = isCommandVerificationCriteria(doneCriteria)
    ? buildCommandVerificationSummary({ doneCriteria, toolEvents: toolEvents as never, agentOutputText: agentText })
    : agentText;
  const evidence = diffWorkspaceSnapshots(baseline, await captureWorkspaceSnapshot(root));
  const input = buildPappyInput(spec, { outputText, summary: "debugger", toolEvents: toolEvents as never, doneCriteria, metadata: { stoppedBecause: "done" } } as never, evidence);
  return { routing, input, qc: createPappyPort().evaluate(input) };
}

describe("Find & Fix: routing → criteria → Pappy (Brain unavailable)", () => {
  it("routes to a code-capable worker with the user's objective as the criterion", async () => {
    const { routing, input } = await verify(workspace(), () => ({ toolEvents: [], agentText: "" }));
    expect(routing).toMatchObject({ routing: "direct", role: "debugger" });
    expect(input.goals).toEqual([FIND_FIX]);
  });

  it("A: a real fix with a passing full suite is VERIFIED", async () => {
    const root = workspace();
    const { qc } = await verify(root, () => {
      writeFileSync(join(root, "src", "bookings.js"), fx("bookings.fixed.txt"));
      return {
        toolEvents: [writeEvent("src/bookings.js", fx("bookings.fixed.txt")), npmTest("fixed_npmtest.out")],
        agentText: "Root cause: overlaps() used <= so touching meetings conflicted. Changed to < in src/bookings.js. npm test: 8 passed, 0 failed.",
      };
    });
    expect(qc.verdict).toBe("PASS");
  });

  it("H: an unchanged rewrite with a failing suite is NOT verified (FAIL, not WARN)", async () => {
    const root = workspace();
    const { qc } = await verify(root, () => {
      writeFileSync(join(root, "src", "bookings.js"), fx("bookings.base.txt"));
      return { toolEvents: [writeEvent("src/bookings.js", fx("bookings.base.txt")), npmTest("base_npmtest.out")], agentText: "Fixed the overlap logic in src/bookings.js." };
    });
    expect(qc.verdict).toBe("FAIL");
  });

  it("E: deleting the failing test is NOT verified", async () => {
    const root = workspace();
    const { qc } = await verify(root, () => {
      writeFileSync(join(root, "test", "bookings.test.js"), fx("bookings.test.tamper.txt"));
      return { toolEvents: [npmTest("tamper_npmtest.out")], agentText: "Fixed. npm test: 7 passed, 0 failed." };
    });
    expect(qc.verdict).toBe("FAIL");
    expect(qc.issues.map((i) => i.code)).toContain("TEST_EDIT_PROHIBITED");
  });
});
