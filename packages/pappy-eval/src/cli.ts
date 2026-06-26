#!/usr/bin/env node
import type { JudgeFn } from "./types.js";
import { allFixtures } from "./fixtures/index.js";
import { judgeRun } from "./judge/judgeRun.js";
import { rawRealPappyJudge } from "./judge/rawRealPappyJudge.js";
import { pappyPlusHardeningJudge } from "./judge/pappyPlusHardeningJudge.js";
import { runEval, printReport } from "./runner/runEval.js";

const JUDGES: Record<string, { judge: JudgeFn; description: string }> = {
  reference: {
    judge: judgeRun,
    description: "reference (eval harness's own deterministic stand-in judge)",
  },
  "raw-real-pappy": {
    judge: rawRealPappyJudge,
    description: "raw-real-pappy (calls packages/pappy-core's evaluateWithPappy as-is, no anti-cheat logic added)",
  },
  "pappy-plus-hardening": {
    judge: pappyPlusHardeningJudge,
    description: "pappy-plus-hardening (deterministic anti-cheat checks, then real Pappy, then merged)",
  },
};

function main(): void {
  const judgeArg = process.argv.find((a) => a.startsWith("--judge="))?.split("=")[1] ?? "reference";
  const selected = JUDGES[judgeArg];

  if (!selected) {
    console.error(`Unknown judge "${judgeArg}". Available: ${Object.keys(JUDGES).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`judge: ${selected.description}\n`);

  const result = runEval(allFixtures, selected.judge);
  printReport(result);

  if (result.metrics.failed > 0) {
    process.exitCode = 1;
  }
}

main();
