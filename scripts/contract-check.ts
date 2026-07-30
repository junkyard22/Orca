#!/usr/bin/env tsx
/**
 * contract-check.ts — Development-time architecture compliance gate.
 *
 * Scans git worktree changes and prints CLEAR / REVIEW REQUIRED / BLOCKED.
 *
 * Modes:
 *   Default (local): warning-only. All statuses exit 0. Agents must obey printed status.
 *   Strict (CI/release): exits 1 on BLOCKED. Pass --strict to enable.
 *
 * Usage:
 *   pnpm contract:check               # local, warning-only
 *   pnpm contract:check:strict        # strict, BLOCKED fails
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

type Status = "CLEAR" | "REVIEW REQUIRED" | "BLOCKED";

interface Finding {
  ruleNum: number;
  ruleName: string;
  severity: "BLOCKED" | "REVIEW REQUIRED";
  file: string;
  detail: string;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitExec(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function refExists(ref: string): boolean {
  return gitExec(`git rev-parse --verify --quiet ${ref}`).trim() !== "";
}

/**
 * The branch point to diff against, or null when none can be resolved.
 *
 * Without this the check only ever saw uncommitted work, which made it a no-op
 * in CI: `actions/checkout` produces a clean tree, so `git diff HEAD` was always
 * empty and every run reported CLEAR regardless of what the PR changed.
 */
function resolveBaseRef(): string | null {
  const explicit = process.env["CONTRACT_CHECK_BASE"];
  if (explicit) return refExists(explicit) ? explicit : null;

  // Set by GitHub Actions on pull_request events, e.g. "main".
  const prBase = process.env["GITHUB_BASE_REF"];
  if (prBase) {
    for (const candidate of [`origin/${prBase}`, prBase]) {
      if (refExists(candidate)) return candidate;
    }
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (refExists(candidate)) return candidate;
  }
  return null;
}

function changedFiles(base: string | null): string[] {
  const sources = [
    // Everything this branch changed relative to the merge base.  Three-dot so a
    // busy base branch does not drag unrelated files in.
    base ? gitExec(`git diff --name-only ${base}...HEAD`) : "",
    // Uncommitted work, so the check still catches things pre-commit locally.
    gitExec("git diff --name-only HEAD"),
    gitExec("git diff --name-only --cached"),          // handles pre-first-commit repos
    gitExec("git ls-files --others --exclude-standard"),
  ];
  return [
    ...new Set(
      sources
        .join("\n")
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))  // normalise separators
        .filter(Boolean),
    ),
  ];
}

/**
 * Whether a path is source code these rules can meaningfully grep.
 *
 * Rules 2 and 3 look for call patterns, so pointing them at Markdown produces
 * false positives: ROADMAP.md documents `ctx.tools.execute()` in prose and was
 * being flagged as an ungated tool call.
 */
function isAnalyzableSource(file: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) return false;
  return !(
    file.endsWith(".d.ts") ||
    file.includes(".test.") ||
    file.includes(".spec.") ||
    file.includes("/dist/")
  );
}

function readFileContent(relPath: string): string | null {
  const abs = path.join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// ─── Rule implementations ─────────────────────────────────────────────────────

// Rule 1 — Deprecated Miranda pipeline touched → BLOCKED
//
// The PLAN→ANSWER→CRITIQUE→REWRITE pipeline is frozen. Changes to these files
// must not add new live behavior.
//
// Path-based and unconditional, on purpose.  An earlier draft made this read the
// changed lines so that edits confined to the live LLM contracts inside
// pipeline/types.ts downgraded to REVIEW REQUIRED.  That treated the symptom:
// those contracts had no business inside the freeze, and softening the rule
// would have made every future adapter-contract change quietly acceptable.  They
// live in miranda-core/src/llm/types.ts now, so the rule can stay strict and
// still say something true.
function checkRule1(file: string): Finding | null {
  const isDeprecated =
    file.includes("miranda-core/src/pipeline/") ||
    file.includes("miranda-core/src/contracts/");
  if (!isDeprecated) return null;
  return {
    ruleNum: 1,
    ruleName: "Deprecated Miranda pipeline touched",
    severity: "BLOCKED",
    file,
    detail:
      "The deprecated PLAN→ANSWER→CRITIQUE→REWRITE pipeline is frozen. " +
      "Changes to these files must not add new live behavior.",
  };
}

// Rule 2 — Live LLM call without beforeLLMCall in same file → BLOCKED
//
// Detects direct LLM invocations (ctx.llm.stream / llm.stream / llm.complete etc.)
// that are not paired with a beforeLLMCall gate call in the same file.
const LLM_CALL_RE =
  /\bctx\.llm\.\w+\s*\(|\bllm\.(?:stream|complete|call|invoke)\s*\(|\.llm\.(?:stream|complete|call|invoke)\s*\(/;

function checkRule2(file: string, content: string): Finding | null {
  // Source only — greppping prose for call patterns yields false positives.
  if (!isAnalyzableSource(file)) return null;
  // Skip type definitions and the gate file itself.
  if (file.includes("mirandaGate") || file.endsWith("types.ts")) {
    return null;
  }
  if (!LLM_CALL_RE.test(content)) return null;
  if (content.includes("beforeLLMCall")) return null;
  return {
    ruleNum: 2,
    ruleName: "Live LLM call without beforeLLMCall gate",
    severity: "BLOCKED",
    file,
    detail:
      "File makes an LLM call but does not invoke beforeLLMCall in the same file. " +
      "Every live LLM call must pass through the Miranda gate.",
  };
}

// Rule 3 — Tool execution without beforeToolRun in same file → BLOCKED
//
// Detects tools.execute() / ctx.tools.execute() invocations not paired with
// a beforeToolRun gate call in the same file.
const TOOL_EXEC_RE = /(?:tools|ctx\.tools|toolService)\.execute\s*\(/;

function checkRule3(file: string, content: string): Finding | null {
  if (!isAnalyzableSource(file)) return null;
  if (file.includes("mirandaGate") || file.endsWith("types.ts")) {
    return null;
  }
  if (!TOOL_EXEC_RE.test(content)) return null;
  if (content.includes("beforeToolRun")) return null;
  return {
    ruleNum: 3,
    ruleName: "Tool execution without beforeToolRun gate",
    severity: "BLOCKED",
    file,
    detail:
      "File calls tools.execute() but does not invoke beforeToolRun in the same file. " +
      "Every side-effecting tool call must pass through the Miranda gate.",
  };
}

// Rule 4 — Pappy QC / repair behavior touched → REVIEW REQUIRED
//
// Changes to Pappy verdict logic, repair signalling, or QC checks require
// explicit review to confirm no component overrides or short-circuits a FAIL.
function checkRule4(file: string): Finding | null {
  const isPappy =
    file.includes("pappy-core/src/pappy.ts") ||
    file.includes("pappy-core/src/repair.ts") ||
    file.includes("pappy-core/src/checks/") ||
    (file.includes("pappy-core/") && /verdict|repair|qc/i.test(file));
  if (!isPappy) return null;
  return {
    ruleNum: 4,
    ruleName: "Pappy QC / repair behavior touched",
    severity: "REVIEW REQUIRED",
    file,
    detail:
      "Changes to Pappy verdict logic or repair behavior require review. " +
      "Confirm no other component overrides, suppresses, or short-circuits a Pappy FAIL. " +
      "Confirm Miranda's afterQC is not being used to alter QC outcomes.",
  };
}

// Rule 5 — Benson user-facing output boundary touched → REVIEW REQUIRED
//
// The presenter, intent parser, and top-level handler are the final translation
// layer between internal state and user-visible output. Changes here can leak
// internal diagnostics (gate verdicts, stage labels, trace IDs).
function checkRule5(file: string): Finding | null {
  const isBenson =
    file.includes("benson-core/src/benson.ts") ||
    file.includes("benson-core/src/presenter.ts") ||
    file.includes("benson-core/src/intent.ts") ||
    file === "apps/runner/src/index.ts";
  if (!isBenson) return null;
  return {
    ruleNum: 5,
    ruleName: "Benson user-facing output boundary touched",
    severity: "REVIEW REQUIRED",
    file,
    detail:
      "Changes to the Benson output layer affect what users see. " +
      "Verify no internal diagnostics (stage labels, gate verdicts, trace IDs, repair-loop counters) " +
      "leak into final output.",
  };
}

// Rule 6 — Universal/system contract docs touched → REVIEW REQUIRED
//
// These documents define the authority boundaries all components are built on.
// Changes must be reviewed against the full contract before landing.
const CONTRACT_DOCS = new Set([
  "docs/ORCA_UNIVERSAL_TRUTHS.md",
  "docs/ORCA_SYSTEM_CONTRACT.md",
  "docs/ORCA_CONTRACT_CHECK.md",
]);

function checkRule6(file: string): Finding | null {
  if (!CONTRACT_DOCS.has(file)) return null;
  return {
    ruleNum: 6,
    ruleName: "Universal/system contract docs touched",
    severity: "REVIEW REQUIRED",
    file,
    detail:
      "Changes to ORCA contract documents must be reviewed. " +
      "These docs define architectural authority boundaries that all components depend on. " +
      "Any change requires a corresponding update to affected component contracts.",
  };
}

// Rule 7 — gate_blocked outside internal diagnostic/runtime/test context → REVIEW REQUIRED
//
// gate_blocked is an internal status code. It must not appear in user-facing
// output paths. Known safe contexts: test files, the agent loop, maestro adapter,
// type definitions, diagnostic files, and documentation.
const GATE_BLOCKED_SAFE_PATHS = [
  ".test.ts",
  ".spec.ts",
  ".integration.test.",
  "agent-loop-core/",
  "maestroAdapter",
  "orca-core/src/types",
  "agent-loop-core/src/types",
  "diagnostic",
  "/audit/",
  "loop.ts",
  ".md",
];

function checkRule7(file: string, content: string): Finding | null {
  if (!content.includes("gate_blocked")) return null;
  const isSafe = GATE_BLOCKED_SAFE_PATHS.some((p) => file.includes(p));
  if (isSafe) return null;
  return {
    ruleNum: 7,
    ruleName: "gate_blocked outside diagnostic/runtime/test context",
    severity: "REVIEW REQUIRED",
    file,
    detail:
      "The gate_blocked status code appears in a file outside the known internal runtime or test contexts. " +
      "Verify this does not allow the internal gate status to surface in user-facing output.",
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(strict: boolean): void {
  const baseRef = resolveBaseRef();
  const allChanged = changedFiles(baseRef);

  // Never flag the contract-check script itself — it will almost always be in
  // the diff when first added or updated.
  const toScan = allChanged.filter(
    (f) =>
      !f.includes("scripts/contract-check.ts") &&
      !f.includes("scripts/contract-check.js"),
  );

  const findings: Finding[] = [];

  for (const file of toScan) {
    // Path-only rules
    for (const check of [checkRule1, checkRule4, checkRule5, checkRule6]) {
      const finding = check(file);
      if (finding) findings.push(finding);
    }

    // Content rules — read file once
    const content = readFileContent(file);
    if (content !== null) {
      for (const check of [checkRule2, checkRule3, checkRule7]) {
        const finding = check(file, content);
        if (finding) findings.push(finding);
      }
    }
  }

  // Worst finding determines overall status
  const status: Status = findings.some((f) => f.severity === "BLOCKED")
    ? "BLOCKED"
    : findings.some((f) => f.severity === "REVIEW REQUIRED")
      ? "REVIEW REQUIRED"
      : "CLEAR";

  // ─── Print report ──────────────────────────────────────────────────────────

  const LINE = "─".repeat(62);
  const DLINE = "═".repeat(62);

  console.log(DLINE);
  console.log("  ORCA CONTRACT CHECK");
  console.log(DLINE);
  console.log();

  const statusLabel =
    status === "BLOCKED"
      ? "BLOCKED  ✖"
      : status === "REVIEW REQUIRED"
        ? "REVIEW REQUIRED  ⚠"
        : "CLEAR  ✔";
  console.log(`  Status: ${statusLabel}`);
  console.log();

  // Findings
  if (findings.length === 0) {
    console.log("  No findings. All changed files pass architecture rules.");
  } else {
    console.log(`  Findings (${findings.length}):`);
    console.log();
    for (const f of findings) {
      console.log(`  [${f.severity}] Rule ${f.ruleNum} — ${f.ruleName}`);
      console.log(`    File:   ${f.file}`);
      console.log(`    Detail: ${f.detail}`);
      console.log();
    }
  }

  // File list.  Naming the base makes it obvious when nothing is being compared —
  // an unresolved base plus a clean worktree means the check saw no files at all.
  console.log(
    baseRef
      ? `  Comparing against: ${baseRef} (plus uncommitted changes)`
      : "  Comparing against: uncommitted changes only (no base ref resolved)",
  );
  if (toScan.length === 0) {
    console.log("  Changed files scanned: none (clean worktree or no new files)");
  } else {
    console.log(`  Changed files scanned (${toScan.length}):`);
    for (const f of toScan) {
      console.log(`    ${f}`);
    }
  }
  console.log();

  // Required next action
  console.log(LINE);
  if (status === "BLOCKED") {
    console.log("  REQUIRED ACTION: BLOCKED");
    console.log("  Stop. Fix the issue(s) above or request explicit user override.");
    console.log("  Do not proceed with the coding task until resolved.");
    if (strict) {
      console.log();
      console.log("  Strict mode: BLOCKED findings fail this check.");
    }
  } else if (status === "REVIEW REQUIRED") {
    console.log("  REQUIRED ACTION: REVIEW REQUIRED");
    console.log("  Ask the user before continuing.");
    console.log("  Summarise the findings above and wait for explicit approval.");
  } else {
    console.log("  REQUIRED ACTION: CLEAR");
    console.log("  No architecture issues found. Continue automatically.");
  }

  // Required reading for non-CLEAR results
  if (status !== "CLEAR") {
    console.log();
    console.log("  Required reading before continuing:");
    console.log("    docs/ORCA_UNIVERSAL_TRUTHS.md");
    console.log("    docs/ORCA_SYSTEM_CONTRACT.md");
    console.log("    docs/ORCA_CONTRACT_CHECK.md");
  }

  console.log(DLINE);
  console.log();

  // Default mode: warning-only, always exit 0.
  // Strict mode: exit 1 on BLOCKED so CI/release gates can enforce the check.
  // REVIEW REQUIRED exits 0 in both modes — it requires human judgment, not automation.
  if (strict && status === "BLOCKED") {
    process.exit(1);
  }
  process.exit(0);
}

run(process.argv.includes("--strict"));
