#!/usr/bin/env node
/**
 * pappy-trace.ts — step-by-step Pappy evaluation tracer
 *
 * Shows every checkpoint the evaluator hits and marks pass/fail at each one,
 * like a WiFi signal-strength indicator for the QC pipeline.
 *
 * Usage (three modes):
 *
 *   # Built-in demo scenarios
 *   node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts
 *   node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts pass
 *   node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts fail
 *   node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts warn
 *   node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts claim
 *
 *   # Pipe in arbitrary JSON input
 *   echo '{"task":"Create auth.ts","outputText":"Done.","constraints":{"requireFiles":["auth.ts"]}}' \
 *     | node --experimental-strip-types packages/pappy-core/src/pappy-trace.ts -
 */

import type { PappyInput, PappyResult, Issue, ReceiptEntry, AcceptanceCriterion, Claim } from "./types.js";
import { runSafetyChecks }       from "./checks/safety.js";
import { runToolResultChecks }   from "./checks/toolResults.js";
import { runCompletenessChecks } from "./checks/completeness.js";
import { runStructureChecks }    from "./checks/structure.js";
import { runClaimProofChecks }   from "./checks/claimProof.js";
import { evaluateWithPappy }     from "./pappy.js";

// ── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[97m",
  bgRed:   "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow:"\x1b[43m",
};

// ── Formatting helpers ────────────────────────────────────────────────────────

function ok(msg: string)   { return `${C.green}✓${C.reset}  ${msg}`; }
function fail(msg: string) { return `${C.red}✗${C.reset}  ${msg}`; }
function warn(msg: string) { return `${C.yellow}⚠${C.reset}  ${msg}`; }
function dim(msg: string)  { return `${C.dim}${msg}${C.reset}`; }
function bold(msg: string) { return `${C.bold}${msg}${C.reset}`; }

function severityColor(sev: string): string {
  switch (sev) {
    case "CRITICAL": return C.bgRed + C.white;
    case "HIGH":     return C.red;
    case "MEDIUM":   return C.yellow;
    case "LOW":      return C.dim;
    default:         return C.reset;
  }
}

function hr(char = "─", width = 72) {
  return C.dim + char.repeat(width) + C.reset;
}

function section(title: string) {
  const padded = `─── ${title} `;
  const rest   = 72 - padded.length;
  console.log(`\n${C.cyan}${padded}${"─".repeat(Math.max(0, rest))}${C.reset}`);
}

function printIssue(issue: Issue, indent = "   ") {
  const sc = severityColor(issue.severity);
  console.log(`${indent}${sc}[${issue.severity}]${C.reset} ${C.bold}${issue.code}${C.reset}`);
  console.log(`${indent}  ${issue.description}`);
  if (issue.evidence) {
    console.log(`${indent}  ${dim("evidence: " + issue.evidence.slice(0, 120))}`);
  }
  if (issue.fix_hint) {
    console.log(`${indent}  ${C.cyan}hint: ${issue.fix_hint.slice(0, 100)}${C.reset}`);
  }
  if (issue.issueId) {
    console.log(`${indent}  ${dim("id: " + issue.issueId)}`);
  }
}

// ── Main tracer ───────────────────────────────────────────────────────────────

export function traceEvaluation(input: PappyInput): PappyResult {
  // ── Header ────────────────────────────────────────────────────────────────
  console.log(hr("═"));
  console.log(`${C.bold}${C.magenta}PAPPY TRACE${C.reset}  ${dim(new Date().toISOString())}`);
  console.log(hr("═"));

  // ── Input summary ─────────────────────────────────────────────────────────
  section("INPUT");
  console.log(`   task         : ${bold(input.task.slice(0, 80))}${input.task.length > 80 ? "…" : ""}`);
  console.log(`   outputText   : ${input.outputText ? `${input.outputText.length} chars` : dim("(none)")}`);
  console.log(`   filesChanged : ${input.filesChanged?.length ?? 0} file(s)`);
  console.log(`   toolEvents   : ${input.toolEvents?.length ?? 0} event(s)`);
  if (input.goals?.length)                       console.log(`   goals        : ${input.goals.join(", ")}`);
  if (input.constraints?.requireFiles?.length)   console.log(`   requireFiles : ${input.constraints.requireFiles.join(", ")}`);
  if (input.constraints?.requireSections?.length)console.log(`   requireSections: ${input.constraints.requireSections.join(", ")}`);
  if (input.constraints?.forbidDeletes)          console.log(`   forbidDeletes: ${C.red}true${C.reset}`);

  // ── Stage 1: Acceptance criteria ─────────────────────────────────────────
  section("STAGE 1 — Acceptance Criteria");
  const fullResult = evaluateWithPappy(input);
  if (fullResult.acceptance_criteria.length === 0) {
    console.log(`   ${dim("(no criteria derived)")}`);
  } else {
    for (const ac of fullResult.acceptance_criteria) {
      const symbol = ac.required ? `${C.yellow}●${C.reset}` : `${C.dim}○${C.reset}`;
      console.log(`   ${symbol} ${C.bold}${ac.id}${C.reset}  ${ac.text}`);
    }
  }

  // ── Stage 2: Claim extraction & proof ─────────────────────────────────────
  section("STAGE 2 — Claim Extraction & Proof");
  const { issues: claimIssues, ledger: claimLedger, claims } = runClaimProofChecks(input);
  if (claims.length === 0) {
    console.log(`   ${dim("(no verifiable claims detected in output)")}`);
  } else {
    for (const claim of claims) {
      const ledgerEntry = claimLedger.find((e) => e.ref === claim.id);
      const status = ledgerEntry?.status;
      const statusStr =
        status === "PROVED"  ? `${C.green}PROVED${C.reset}` :
        status === "PARTIAL" ? `${C.yellow}PARTIAL${C.reset}` :
                               `${C.red}MISSING${C.reset}`;
      const icon = status === "PROVED" ? ok("") : fail("");
      console.log(`   ${icon}${C.bold}${claim.id}${C.reset}  ${C.dim}"${claim.text.slice(0, 70)}"${C.reset}`);
      if (ledgerEntry) {
        console.log(`       └─ ${statusStr}  ${dim(ledgerEntry.required_receipt.details.slice(0, 80))}`);
        if (ledgerEntry.evidence.length > 0) {
          console.log(`          ${dim("evidence: " + (ledgerEntry.evidence[0] ?? "").slice(0, 80))}`);
        }
      }
    }
  }
  if (claimIssues.length > 0) {
    console.log(`\n   ${C.red}Issues from claim-proof:${C.reset}`);
    for (const issue of claimIssues) printIssue(issue as Issue);
  }

  // ── Stage 3: Safety ───────────────────────────────────────────────────────
  section("STAGE 3 — Safety Checks");
  const safetyIssues = runSafetyChecks(input);
  if (safetyIssues.length === 0) {
    console.log(`   ${ok("No dangerous patterns or constraint violations")}`);
  } else {
    for (const issue of safetyIssues) printIssue(issue as Issue);
  }

  // ── Stage 4: Tool results ─────────────────────────────────────────────────
  section("STAGE 4 — Tool Result Checks");
  const toolIssues = runToolResultChecks(input);
  const toolFailures = toolIssues.filter((i) => i.code === "TOOL_FAILURE");
  const toolMissing  = toolIssues.filter((i) => i.code === "TOOL_MISSING");
  const toolInstr    = toolIssues.filter((i) => i.code === "TOOL_INSTRUMENTATION_MISSING");

  if (input.toolEvents?.length) {
    for (const ev of input.toolEvents) {
      const icon = ev.ok ? ok("") : fail("");
      console.log(`   ${icon}${C.bold}${ev.tool}${C.reset}  ${dim(ev.summary.slice(0, 80))}`);
    }
  } else {
    console.log(`   ${dim("(no tool events recorded)")}`);
  }

  if (toolFailures.length > 0) {
    console.log(`\n   ${C.red}Failed tools:${C.reset}`);
    for (const issue of toolFailures) printIssue(issue as Issue);
  }
  if (toolMissing.length > 0) {
    console.log(`\n   ${C.yellow}Expected tools not called:${C.reset}`);
    for (const issue of toolMissing) printIssue(issue as Issue);
  }
  if (toolInstr.length > 0) {
    console.log(`\n   ${warn("Instrumentation gaps:")}`);
    for (const issue of toolInstr) printIssue(issue as Issue);
  }
  if (toolIssues.length === 0) {
    console.log(`   ${ok("Tool checks passed")}`);
  }

  // ── Stage 5: Completeness ─────────────────────────────────────────────────
  section("STAGE 5 — Completeness Checks");
  const complIssues = runCompletenessChecks(input);
  if (complIssues.length === 0) {
    console.log(`   ${ok("Completeness checks passed")}`);
  } else {
    for (const issue of complIssues) printIssue(issue as Issue);
  }

  // ── Stage 6: Structure ────────────────────────────────────────────────────
  section("STAGE 6 — Structure Checks");
  const structIssues = runStructureChecks(input);
  if (structIssues.length === 0) {
    console.log(`   ${ok("Structure checks passed")}`);
  } else {
    for (const issue of structIssues) printIssue(issue as Issue);
  }

  // ── Receipt ledger ────────────────────────────────────────────────────────
  section("RECEIPT LEDGER");
  const allLedger = fullResult.receipt_ledger;
  if (allLedger.length === 0) {
    console.log(`   ${dim("(empty ledger)")}`);
  } else {
    const refWidth = Math.max(...allLedger.map((e) => e.ref.length));
    for (const entry of allLedger) {
      const statusPad = entry.ref.padEnd(refWidth);
      const statusStr =
        entry.status === "PROVED"  ? `${C.green}PROVED ${C.reset}` :
        entry.status === "PARTIAL" ? `${C.yellow}PARTIAL${C.reset}` :
                                     `${C.red}MISSING${C.reset}`;
      const icon = entry.status === "PROVED" ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`   ${icon} ${C.bold}${statusPad}${C.reset}  ${statusStr}  ${dim(entry.required_receipt.details.slice(0, 60))}`);
      if (entry.evidence.length > 0) {
        for (const ev of entry.evidence) {
          console.log(`       ${dim("└─ " + ev.slice(0, 80))}`);
        }
      }
    }
  }

  // ── Issues summary ────────────────────────────────────────────────────────
  section("ALL ISSUES");
  const allIssues = fullResult.issues;
  if (allIssues.length === 0) {
    console.log(`   ${ok("No issues found")}`);
  } else {
    const bySeverity: Record<string, Issue[]> = {};
    for (const i of allIssues) {
      (bySeverity[i.severity] ??= []).push(i);
    }
    for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const group = bySeverity[sev] ?? [];
      if (group.length > 0) {
        console.log(`\n   ${severityColor(sev)}${sev} (${group.length})${C.reset}`);
        for (const issue of group) printIssue(issue, "      ");
      }
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${hr("═")}`);
  const verdictColor =
    fullResult.verdict === "PASS" ? C.bgGreen + C.bold :
    fullResult.verdict === "WARN" ? C.bgYellow + C.bold :
                                    C.bgRed + C.bold;
  const verdictPad = ` ${fullResult.verdict} `;
  const confBar    = buildConfBar(fullResult.confidence);
  console.log(`  ${verdictColor}${verdictPad}${C.reset}  conf ${confBar} ${(fullResult.confidence * 100).toFixed(0)}%`);
  console.log(`  ${dim(fullResult.summary)}`);

  // ── Repair task ───────────────────────────────────────────────────────────
  if (fullResult.repair_task) {
    console.log();
    section("REPAIR TASK");
    console.log(`   ${C.bold}${fullResult.repair_task.title}${C.reset}`);
    for (const step of fullResult.repair_task.steps) {
      if (step === "") {
        console.log();
      } else if (step.startsWith("##")) {
        console.log(`   ${C.cyan}${step}${C.reset}`);
      } else if (step.startsWith("  [")) {
        const sev = step.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/)?.[1] ?? "";
        console.log(`   ${severityColor(sev)}${step.slice(0, 2)}${C.reset}${step.slice(2)}`);
      } else {
        console.log(`   ${step}`);
      }
    }
    if (fullResult.repair_task.required_proofs.length > 0) {
      console.log(`\n   ${C.bold}Required proofs:${C.reset}`);
      for (const proof of fullResult.repair_task.required_proofs) {
        console.log(`   ${C.dim}• ${proof}${C.reset}`);
      }
    }
  }

  console.log(`\n${hr("═")}\n`);
  return fullResult;
}

function buildConfBar(conf: number): string {
  const filled = Math.round(conf * 10);
  const bar    = "█".repeat(filled) + "░".repeat(10 - filled);
  const color  = conf >= 0.8 ? C.green : conf >= 0.5 ? C.yellow : C.red;
  return `${color}${bar}${C.reset}`;
}

// ── Demo scenarios ─────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, PappyInput> = {
  pass: {
    task: "Explain how binary search works.",
    outputText: "Binary search divides the sorted array in half on each step, giving O(log n) time complexity.",
    toolEvents: [{ tool: "read_file", ok: true, summary: "Read context docs" }],
  },

  fail: {
    task: "Create auth.ts with login and registration functions.",
    outputText: "I created `auth.ts` with the login function.",
    filesChanged: [],
    toolEvents: [],
    constraints: {
      requireFiles: ["auth.ts"],
      requireSections: ["Usage"],
    },
  },

  warn: {
    task: "Write a summary of the README.",
    outputText: "The README describes the Orca project and its architecture.",
  },

  claim: {
    task: "Update config.ts and run the tests.",
    outputText: "I updated `config.ts` with the new timeout values and ran the test suite successfully.",
    filesChanged: [
      { path: "config.ts", changeType: "M", diff: "export const TIMEOUT = 5000;" },
    ],
    toolEvents: [
      { tool: "run_command", ok: true, summary: "pnpm test — 42 passed" },
    ],
  },

  danger: {
    task: "Clean old build artifacts.",
    outputText: "Run rm -rf ./dist to clear the build directory.",
    filesChanged: [{ path: "old-module.ts", changeType: "D" }],
    constraints: { forbidDeletes: true },
  },
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.trim() ?? "fail"; // default demo scenario

  let input: PappyInput;

  if (arg === "-") {
    // Read JSON from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PappyInput;
    } catch {
      console.error("Error: stdin must be valid JSON matching PappyInput shape.");
      process.exit(1);
    }
  } else if (arg in SCENARIOS) {
    input = SCENARIOS[arg]!;
  } else {
    console.error(`Unknown scenario "${arg}". Available: ${Object.keys(SCENARIOS).join(", ")}, - (stdin JSON)`);
    process.exit(1);
  }

  traceEvaluation(input);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
