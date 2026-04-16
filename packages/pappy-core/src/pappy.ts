/**
 * Pappy — "Receipt Checker" QC Gate
 *
 * Identity: the old man at the exit door asking for your receipt.
 * Not creative. Not helpful. Checks receipts.
 *
 * PASS  → all required receipts exist, no HIGH issues
 * WARN  → receipts present but partial gaps or instrumentation missing
 * FAIL  → any required receipt missing, HIGH/CRITICAL issue, or unsafe behavior
 */

import type {
  PappyInput,
  PappyResult,
  Issue,
  Verdict,
  AcceptanceCriterion,
  Claim,
  ReceiptEntry,
} from "./types.js";
import { runSafetyChecks }       from "./checks/safety.js";
import { runToolResultChecks }   from "./checks/toolResults.js";
import { runCompletenessChecks, runSatisfactionChecks } from "./checks/completeness.js";
import { runStructureChecks }    from "./checks/structure.js";
import { runClaimProofChecks } from "./checks/claimProof.js";
import { runBrainChecks }      from "./checks/brain.js";
import { buildRepairTask, repairTaskToString } from "./repair.js";

// ---------------------------------------------------------------------------
// Stable issue ID — FNV-1a 32-bit, no external dependencies.
// Same defect always hashes to the same ID so Doctor/Maestro can track
// which specific issues were fixed across repair passes.
// ---------------------------------------------------------------------------

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stampIssueIds(issues: Omit<Issue, "issueId">[]): Issue[] {
  return issues.map((issue) => ({
    ...issue,
    issueId: `${issue.code}:${fnv1a32(issue.evidence ?? issue.description)}`,
  }));
}

// ---------------------------------------------------------------------------
// Acceptance criteria — derived from task + goals + constraints
// ---------------------------------------------------------------------------

function deriveAcceptanceCriteria(input: PappyInput): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  let n = 0;

  // From goals (if provided)
  for (const goal of input.goals ?? []) {
    criteria.push({ id: `AC${++n}`, text: goal, required: true });
  }

  // From required files constraint
  for (const file of input.constraints?.requireFiles ?? []) {
    criteria.push({
      id: `AC${++n}`,
      text: `File "${file}" must be created or modified.`,
      required: true,
    });
  }

  // From required sections constraint
  for (const section of input.constraints?.requireSections ?? []) {
    criteria.push({
      id: `AC${++n}`,
      text: `Output must contain a section titled "${section}".`,
      required: true,
    });
  }

  // If no explicit criteria derivable, at minimum the task must produce output
  if (criteria.length === 0) {
    criteria.push({
      id: "AC1",
      text: "Task must produce non-empty output, file changes, or tool results.",
      required: true,
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// Receipt ledger — one entry per acceptance criterion
// ---------------------------------------------------------------------------

/**
 * Verify an acceptance criterion against specific evidence in the output.
 *
 * ## Acceptance Criteria
 *
 * When you receive done_criteria, treat each item as a binding contract:
 *
 * - "Output contains a TypeScript implementation" → your response MUST contain a ``` code block with a class or function definition
 * - "Output includes unit tests" → your response MUST contain describe(), it(), and expect() calls
 * - "Supports configurable X" → the specific parameter (burstCapacity, refillRate, etc.) MUST appear in your code
 * - "Tracks usage per Y" or "includes cleanup" → clientId, Map, cleanup, or stale MUST appear in your code
 *
 * Do not consider your task complete until every criterion is satisfied. If you finish writing and realize a criterion is missing, add it before submitting your final answer.
 *
 * Your output is evaluated by an automated QC system (Pappy) that checks for specific evidence of each criterion. A response that does not contain the required evidence will be rejected and sent back for repair. Save everyone the repair pass — get it right the first time.
 */
function verifyAcceptanceCriterion(ac: AcceptanceCriterion, input: PappyInput): { proved: boolean; evidence: string[] } {
  const outputText = input.outputText ?? "";
  const hasOutput  = outputText.trim().length > 0;
  const hasFiles   = (input.filesChanged?.length ?? 0) > 0;
  const hasTools   = (input.toolEvents?.length ?? 0) > 0;
  const touched    = new Set((input.filesChanged ?? []).map((f) => f.path));
  const lowerOutput = outputText.toLowerCase();
  const lowerCriterion = ac.text.toLowerCase();
  
  // Build combined search text from output and diffs
  const diffText = (input.filesChanged ?? []).map((f) => f.diff ?? "").join("\n");
  const searchText = `${lowerOutput} ${diffText.toLowerCase()}`;
  
  // Helper to check if a pattern matches
  const matchesPattern = (pattern: RegExp): boolean => pattern.test(searchText);
  const containsTerm = (term: string): boolean => matchesPattern(new RegExp(`\\b${term}\\w*\\b`, 'i'));
  const criterionMatchesPattern = (pattern: RegExp): boolean => pattern.test(lowerCriterion);
  const criterionContainsTerm = (term: string): boolean => criterionMatchesPattern(new RegExp(`\\b${term}\\w*\\b`, 'i'));
  
  // Required file criterion
  const fileMatch = ac.text.match(/[Ff]ile ["`']?([^"`'\s]+)["`']? must be/);
  if (fileMatch) {
    const path = fileMatch[1] ?? "";
    const proved = touched.has(path);
    return {
      proved,
      evidence: proved ? [`filesChanged: ${path}`] : [],
    };
  }

  if (/^Output must contain a section titled/i.test(ac.text)) {
    return {
      proved: hasOutput,
      evidence: hasOutput ? ["outputText is non-empty"] : [],
    };
  }
  
  // Check for code block / implementation requirement
  if (criterionContainsTerm("code") || criterionContainsTerm("implementation") || criterionContainsTerm("function") || criterionContainsTerm("class") || criterionContainsTerm("TypeScript")) {
    const hasCodeBlock = /```/.test(outputText);
    const hasCodeKeywords = /\b(function |class |const |let |var |export |import |type |interface |enum |def |async )/.test(outputText);
    const hasCode = hasCodeBlock || hasCodeKeywords || hasFiles;
    
    if (hasCode) {
      return {
        proved: true,
        evidence: hasCodeBlock ? ["code block (```) found"] : hasCodeKeywords ? ["code keywords found"] : ["file changes with code"],
      };
    }
    return { proved: false, evidence: [] };
  }
  
  // Check for unit test requirement
  const mentionsTestingFramework =
    criterionContainsTerm("vitest") || criterionContainsTerm("jest") || criterionContainsTerm("mocha") || criterionContainsTerm("spec");
  const explicitlyRequestsTests =
    /\b(unit|integration|e2e|end-to-end)\s+tests?\b/i.test(ac.text) ||
    /\b(test file|spec file|test suite|coverage)\b/i.test(ac.text) ||
    /\b(add|create|write|include|implement|generate)\b[\w\s]{0,20}\btests?\b/i.test(ac.text) ||
    /\btests?\s+(for|covering|cover|coverage|suite)\b/i.test(ac.text);

  if (mentionsTestingFramework || explicitlyRequestsTests) {
    const hasTestFramework = containsTerm("vitest") || containsTerm("jest") || containsTerm("mocha");
    const hasTestFunctions = containsTerm("describe") || containsTerm("it") || containsTerm("expect") || searchText.includes("test(");
    const hasTestFile = (input.filesChanged ?? []).some(f => f.path.includes(".test.") || f.path.includes(".spec."));
    
    if (hasTestFramework || hasTestFunctions || hasTestFile) {
      return {
        proved: true,
        evidence: [
          ...(hasTestFramework ? ["test framework mentioned"] : []),
          ...(hasTestFunctions ? ["test functions (describe/it/expect) found"] : []),
          ...(hasTestFile ? ["test file in filesChanged"] : []),
        ],
      };
    }
    return { proved: false, evidence: [] };
  }
  
  // Check for configurable parameter requirement
  const configMatch = ac.text.match(/configurab\w*\s+(\w+)/i);
  if (configMatch) {
    const paramName = configMatch[1]?.toLowerCase();
    if (paramName && (containsTerm(paramName) || containsTerm("parameter") || containsTerm("option") || containsTerm("config"))) {
      return {
        proved: true,
        evidence: [`configurable parameter "${paramName}" or related term found`],
      };
    }
    return { proved: false, evidence: [] };
  }
  
  // Check for tracking/cleanup requirement
  if (criterionContainsTerm("track") || criterionContainsTerm("per") || criterionContainsTerm("client") || criterionContainsTerm("cleanup") || criterionContainsTerm("stale")) {
    const hasTracking = containsTerm("clientid") || containsTerm("client") || containsTerm("map") || containsTerm("track");
    const hasCleanup = containsTerm("cleanup") || containsTerm("stale") || containsTerm("delete") || containsTerm("remove");
    
    if (hasTracking || hasCleanup) {
      return {
        proved: true,
        evidence: [
          ...(hasTracking ? ["tracking mechanism (clientId/Map) found"] : []),
          ...(hasCleanup ? ["cleanup/stale handling found"] : []),
        ],
      };
    }
    return { proved: false, evidence: [] };
  }
  
  // Limitation / negative-outcome criteria
  // If the AC text describes a failure, inability, or limitation state (e.g.
  // "Output explains inability to access filesystem", "Response explains why
  // the task cannot be completed"), it should only be proved if the output
  // actually contains those failure-indicating terms.
  // Without this guard, ANY non-empty output silently proves such criteria,
  // even when the agent succeeded at the task and never said "cannot" at all.
  const LIMITATION_TERMS = /\b(inability|unable|cannot|can't|can not|could not|couldn't|fail(ed|ure)?|no.access|not.possible|not.support|unavailable|error|exception|limitation|constraint|denied|reject(ed)?|prohibit|cannot.be|not.be.able|out.of.scope)\b/i;
  if (LIMITATION_TERMS.test(ac.text)) {
    const outputMentionsLimitation = LIMITATION_TERMS.test(lowerOutput);
    return {
      proved: outputMentionsLimitation,
      evidence: outputMentionsLimitation
        ? ["output contains limitation/inability language matching criterion"]
        : [],
    };
  }

  // Default fallback: actual output text or file changes must exist.
  // Tool activity alone (hasTools) is NOT sufficient proof of semantic success —
  // the user expects a response, not just evidence that tools were invoked.
  // This prevents runs that silently fired tools but produced no final answer
  // from being marked as having proved their acceptance criteria.
  const someProofExists = hasOutput || hasFiles;
  return {
    proved: someProofExists,
    evidence: [
      ...(hasOutput ? ["outputText is non-empty"] : []),
      ...(hasFiles  ? [`filesChanged: ${input.filesChanged!.length} file(s)`] : []),
    ],
  };
}

function buildCriteriaLedger(
  input: PappyInput,
  criteria: AcceptanceCriterion[],
): ReceiptEntry[] {
  const entries: ReceiptEntry[] = [];

  for (const ac of criteria) {
    const { proved, evidence } = verifyAcceptanceCriterion(ac, input);
    
    entries.push({
      ref: ac.id,
      required_receipt: {
        type: "criterion_specific",
        details: ac.text.slice(0, 80) + (ac.text.length > 80 ? "..." : ""),
      },
      status: proved ? "PROVED" : "MISSING",
      evidence,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Verdict + confidence
// ---------------------------------------------------------------------------

const HARD_FAIL_CODES = new Set([
  "AGENT_LOOP_DETECTED",
  "SAFETY_VIOLATION",
  "BRAIN_OUTPUT_MALFORMED",
  "BRAIN_INVALID_ROLE",
  "BRAIN_HALLUCINATED_FIELD",
  "BRAIN_NARRATIVE_BLEED",
  // TOOL_INSTRUMENTATION_MISSING is intentionally excluded: it is a heuristic
  // with known false positives (e.g. "test file" triggering the "test" keyword).
  // It fires as MEDIUM and triggers a WARN verdict, not a hard repair pass.
]);

function deriveVerdict(issues: Issue[]): Verdict {
  if (issues.some((issue) => HARD_FAIL_CODES.has(issue.code))) {
    return "FAIL";
  }
  if (issues.some((i) => i.severity === "CRITICAL" || i.severity === "HIGH")) {
    return "FAIL";
  }
  if (issues.some((i) => i.severity === "MEDIUM")) {
    return "WARN";
  }
  return "PASS";
}

function deriveConfidence(input: PappyInput, issues: Issue[]): number {
  let score = 1.0;

  const hasOutput = (input.outputText?.trim().length ?? 0) > 0;
  const hasFiles  = (input.filesChanged?.length ?? 0) > 0;
  const hasTools  = (input.toolEvents?.length ?? 0) > 0;
  if (!hasOutput && !hasFiles && !hasTools) score -= 0.3;

  const deductions: Record<string, number> = {
    CRITICAL: 0.4,
    HIGH:     0.2,
    MEDIUM:   0.1,
    LOW:      0.05,
  };

  for (const issue of issues) {
    score -= deductions[issue.severity] ?? 0;
  }

  return parseFloat(Math.max(0, Math.min(1, score)).toFixed(2));
}

function buildSummary(verdict: Verdict, issues: Issue[], hasTrace: boolean): string {
  if (verdict === "PASS") {
    return "All required receipts are present. Task output is verified.";
  }

  const highCount = issues.filter(
    (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
  ).length;
  const medCount = issues.filter((i) => i.severity === "MEDIUM").length;

  const parts: string[] = [];
  if (highCount > 0) parts.push(`${highCount} HIGH issue${highCount > 1 ? "s" : ""} require repair`);
  if (medCount  > 0) parts.push(`${medCount} MEDIUM issue${medCount > 1 ? "s" : ""} need attention`);
  if (!hasTrace)     parts.push("no run trace provided — claims cannot be verified");

  return `${verdict}: ${parts.join("; ")}.`;
}

function buildInternalSummary(verdict: Verdict, issues: Issue[]): string {
  if (issues.length === 0) return `verdict=${verdict} no_issues`;

  const counts = issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {});

  const tally = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]}x${s}`)
    .join(" ");

  return `verdict=${verdict} ${tally}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function evaluateWithPappy(input: PappyInput): PappyResult {
  // Step 1: derive acceptance criteria
  const acceptance_criteria = deriveAcceptanceCriteria(input);

  // Step 2: run claim-proof checks — claims are extracted here as a by-product
  // (avoids iterating CLAIM_PATTERNS twice)
  const { issues: claimIssues, ledger: claimLedger, claims } = runClaimProofChecks(input);

  // Step 3: run all remaining checks
  const rawIssues: Omit<Issue, "issueId">[] = [
    ...claimIssues,
    ...runBrainChecks(input),
    ...runSafetyChecks(input),
    ...runToolResultChecks(input),
    ...runCompletenessChecks(input),
    ...runStructureChecks(input),
    ...runSatisfactionChecks(input),
  ];

  // Step 4: build receipt ledger (criteria + claim entries merged).
  // Must happen BEFORE stampIssueIds so CORE_GOAL_MISSING can inspect the ledger.
  const criteriaLedger = buildCriteriaLedger(input, acceptance_criteria);
  const receipt_ledger: ReceiptEntry[] = [...criteriaLedger, ...claimLedger];

  // ── CORE_GOAL_MISSING: all specific-goal criteria unproved ───────────────
  // When the task has explicit goals (i.e. more than just the generic fallback AC)
  // and every single one is MISSING, raise HIGH so a FAIL is guaranteed.
  // This catches runs where tool activity is present but the agent never
  // synthesised findings into a user-facing answer.
  const isGenericFallbackOnly = acceptance_criteria.length === 1 &&
    /produce non-?empty output/i.test(acceptance_criteria[0]!.text);

  if (!isGenericFallbackOnly) {
    const allMissing = criteriaLedger.every(e => e.status === 'MISSING');
    if (allMissing) {
      rawIssues.push({
        severity: 'HIGH',
        code: 'CORE_GOAL_MISSING',
        category: 'Completeness',
        description: `None of the ${criteriaLedger.length} acceptance criteria were proved — the core task goal was not achieved.`,
        expected_receipt: 'At least one acceptance criterion must be proved in the receipt ledger.',
        evidence: criteriaLedger.map(e => `${e.ref}: MISSING`).join('; '),
        fix_hint: 'Re-run the task and ensure the output directly addresses all acceptance criteria.',
        message: 'Core task goal unachieved — no acceptance criteria proved.',
        suggestedFix: 'Ensure the agent produces a final answer that satisfies every acceptance criterion.',
      });
    }
  }

  const issues = stampIssueIds(rawIssues);

  // Step 5: verdict
  const verdict  = deriveVerdict(issues);
  const confidence = deriveConfidence(input, issues);
  const hasTrace = (input.toolEvents?.length ?? 0) > 0 || (input.filesChanged?.length ?? 0) > 0;
  const summary  = buildSummary(verdict, issues, hasTrace);
  const internalSummary = buildInternalSummary(verdict, issues);

  // Step 6: repair task (only when not PASS)
  const repair_task   = verdict !== "PASS" ? buildRepairTask(input.task, issues) : null;
  const repairTaskStr = repair_task ? repairTaskToString(repair_task) : undefined;

  return {
    verdict,
    confidence,
    summary,
    acceptance_criteria,
    claims,
    receipt_ledger,
    issues,
    repair_task,
    internalSummary,
    repairTask: repairTaskStr,  // backward compat
  };
}

