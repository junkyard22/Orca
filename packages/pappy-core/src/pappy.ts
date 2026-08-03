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
  TrainingEligibility,
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
import { runIntegrityChecks }  from "./checks/integrity.js";
import { buildRepairTask, repairTaskToString } from "./repair.js";

type OrcaProfileEvent = Record<string, unknown>;
type OrcaProfileEmitter = (event: OrcaProfileEvent) => void;

function emitOrcaProfileEvent(event: OrcaProfileEvent): void {
  const emitter = (globalThis as typeof globalThis & {
    __orcaProfileEmit?: OrcaProfileEmitter;
  }).__orcaProfileEmit;
  emitter?.(event);
}

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

const GENERIC_OUTPUT_CRITERION =
  "Task must produce non-empty output, file changes, or tool results.";

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
      text: GENERIC_OUTPUT_CRITERION,
      required: true,
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// Receipt ledger — one entry per acceptance criterion
// ---------------------------------------------------------------------------

const REPORTING_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "with", "from", "into", "which", "whether",
  "output", "response", "answer", "result", "read", "repository", "root",
  "contains", "contain", "includes", "include", "identifies", "identify",
  "describes", "describe", "states", "state", "distinguishes", "distinguish",
  "explains", "explain", "provides", "provide", "shows", "show", "reports",
  "report", "respond", "summarize", "summarise", "ends", "must", "should",
  "exactly", "how", "many", "are", "is", "be", "of", "to", "in", "for",
  "top", "level", "supporting",
]);

function reportingTermRoot(term: string): string {
  if (term.length > 5 && /ing$/.test(term)) return term.slice(0, -3);
  if (term.length > 4 && /ed$/.test(term)) return term.slice(0, -2);
  if (term.length > 4 && /es$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && /s$/.test(term)) return term.slice(0, -1);
  return term;
}

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
  const presentFiles = (input.filesChanged ?? []).filter((file) => file.changeType !== "D");
  const touched    = new Set(presentFiles.map((f) => f.path));
  const lowerOutput = outputText.toLowerCase();
  const lowerCriterion = ac.text.toLowerCase();
  
  // Build combined search text from output and diffs
  const diffText = presentFiles.map((f) => f.diff ?? "").join("\n");
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

  const sectionMatch = ac.text.match(/^Output must contain a section titled "([^"]+)"\.$/i);
  if (sectionMatch) {
    const title = sectionMatch[1] ?? "";
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasSectionHeading = new RegExp(
      `^(?:#{1,6}\\s+)?${escapedTitle}\\s*:?\\s*$`,
      "im",
    ).test(outputText);
    return {
      proved: hasSectionHeading,
      evidence: hasSectionHeading ? [`section heading: ${title}`] : [],
    };
  }
  
  // Check for code / implementation requirements. Mere prose mentioning code
  // keywords (or an otherwise empty fenced block) is not a receipt.
  if (criterionContainsTerm("code") || criterionContainsTerm("implementation") || criterionContainsTerm("function") || criterionContainsTerm("class") || criterionContainsTerm("TypeScript")) {
    const codeDeclarationPattern = /\b(?:function\s+[A-Za-z_$][\w$]*\s*\(|class\s+[A-Za-z_$][\w$]*(?:\s+\w+)*\s*\{|(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=;\n]+)?\s*=|(?:interface|type|enum)\s+[A-Za-z_$][\w$]*|def\s+[A-Za-z_]\w*\s*\()/;
    const hasCodeInOutput = codeDeclarationPattern.test(outputText);
    const hasCodeInDiff = codeDeclarationPattern.test(diffText);
    const hasCode = hasCodeInOutput || hasCodeInDiff;
    
    if (hasCode) {
      return {
        proved: true,
        evidence: hasCodeInOutput
          ? ["code declaration found in output"]
          : ["code declaration found in non-deleted file diff"],
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
    const requestedFrameworks = ["vitest", "jest", "mocha"]
      .filter((framework) => criterionContainsTerm(framework));
    const hasTestFramework = requestedFrameworks.length === 0 || requestedFrameworks.some(
      (framework) => new RegExp(
        `(?:from\\s+["']${framework}|require\\(\\s*["']${framework}|\\b${framework}\\s*\\.)`,
        "i",
      ).test(`${outputText}\n${diffText}`),
    );
    const hasTestFunctions = /\b(?:describe|it|test|expect)\s*\(/i.test(searchText);
    const hasTestFile = presentFiles.some(
      (file) => file.path.includes(".test.") || file.path.includes(".spec."),
    );
    const hasTestArtifact = hasTestFunctions || hasTestFile;
    
    if (hasTestFramework && hasTestArtifact) {
      return {
        proved: true,
        evidence: [
          ...(requestedFrameworks.length > 0 ? ["requested test framework used in code"] : []),
          ...(hasTestFunctions ? ["test functions (describe/it/expect) found"] : []),
          ...(hasTestFile ? ["test file in filesChanged"] : []),
        ],
      };
    }
    return { proved: false, evidence: [] };
  }
  
  // Check for configurable parameter requirement.
  // The criterion names a specific parameter ("Supports configurable burstCapacity");
  // proof requires that exact parameter name to appear — generic words like
  // "config" or "option" are not evidence that the named parameter exists.
  const configMatch = ac.text.match(/configurab\w*\s+(\w+)/i);
  if (configMatch) {
    const paramName = configMatch[1]?.toLowerCase();
    if (paramName && containsTerm(paramName)) {
      return {
        proved: true,
        evidence: [`configurable parameter "${paramName}" found in output`],
      };
    }
    return { proved: false, evidence: [] };
  }

  // Check for tracking/cleanup requirement.
  // "Tracks usage per X" criteria must prove the specific entity X is tracked;
  // a standalone `Map` mention is not enough. "cleanup" criteria require an
  // actual cleanup verb (cleanup/stale/delete/remove/expire/evict).
  const criterionMentionsTracking =
    criterionContainsTerm("track") || criterionContainsTerm("client");
  const criterionMentionsCleanup =
    criterionContainsTerm("cleanup") || criterionContainsTerm("stale");
  if (criterionMentionsTracking || criterionMentionsCleanup) {
    // Extract the entity after "per" — e.g. "per clientId" → "clientid".
    const perMatch = ac.text.match(/\bper\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    const entity = perMatch?.[1]?.toLowerCase();

    const hasEntity = entity ? containsTerm(entity) : false;
    const hasTracking = containsTerm("clientid") || containsTerm("track");
    const hasCleanup =
      containsTerm("cleanup") || containsTerm("stale") ||
      containsTerm("expire") || containsTerm("evict");

    const trackingProved = criterionMentionsTracking
      ? (entity ? hasEntity : hasTracking)
      : true;
    const cleanupProved = criterionMentionsCleanup ? hasCleanup : true;

    if (trackingProved && cleanupProved) {
      const evidence: string[] = [];
      if (criterionMentionsTracking) {
        evidence.push(
          entity
            ? `tracked entity "${entity}" found in output`
            : "tracking mechanism (clientId/track) found",
        );
      }
      if (criterionMentionsCleanup) {
        evidence.push("cleanup/stale/expire/evict term found");
      }
      return { proved: true, evidence };
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
  const ALLOWED_VERDICT_FORMAT = /\b(pass\s*\/\s*warn\s*\/\s*fail|pass\s*,\s*warn\s*,\s*(or\s+)?fail|pass\s+warn\s+fail)\b/i;
  if (LIMITATION_TERMS.test(ac.text) && !ALLOWED_VERDICT_FORMAT.test(ac.text)) {
    const outputMentionsLimitation = LIMITATION_TERMS.test(lowerOutput);
    return {
      proved: outputMentionsLimitation,
      evidence: outputMentionsLimitation
        ? ["output contains limitation/inability language matching criterion"]
        : [],
    };
  }

  // Reporting criteria describe observable properties of the response rather
  // than implementation behavior. Prove them only when the response covers the
  // criterion's specific topic terms and the run has an objective tool/file
  // receipt. This preserves useful report verification without allowing bare,
  // unrelated text to certify an arbitrary semantic criterion.
  const isReportingCriterion =
    /^(output|response|answer|result)\s+\w+/i.test(ac.text) ||
    /\b(answer|respond|report|summari[sz]e)\s+with\b/i.test(ac.text);
  if (isReportingCriterion) {
    const topicTerms = [...new Set(
      lowerCriterion
        .split(/[^a-z0-9_-]+/)
        .filter((term) => term.length >= 3 && !REPORTING_STOP_WORDS.has(term)),
    )];
    const matchedTerms = topicTerms.filter((term) => containsTerm(reportingTermRoot(term)));
    const requiredMatches = Math.max(1, Math.ceil(topicTerms.length * 0.6));
    const hasObjectiveReceipt = hasTools || hasFiles;
    const proved = topicTerms.length > 0 && matchedTerms.length >= requiredMatches && hasObjectiveReceipt;

    return {
      proved,
      evidence: proved
        ? [
            `criterion terms found: ${matchedTerms.join(", ")}`,
            ...(hasFiles ? [`filesChanged: ${input.filesChanged!.length} file(s)`] : []),
            ...(hasTools ? [`toolEvents: ${input.toolEvents!.length} event(s)`] : []),
          ]
        : [],
    };
  }

  // Pappy's built-in fallback criterion is structural and can be verified
  // directly. It is the only criterion for which artifact presence suffices.
  if (ac.text === GENERIC_OUTPUT_CRITERION) {
    const proved = hasOutput || hasFiles || hasTools;
    return {
      proved,
      evidence: [
        ...(hasOutput ? ["outputText is non-empty"] : []),
        ...(hasFiles ? [`filesChanged: ${input.filesChanged!.length} file(s)`] : []),
        ...(hasTools ? [`toolEvents: ${input.toolEvents!.length} event(s)`] : []),
      ],
    };
  }

  // Unknown semantic criteria have no deterministic verifier. Fail closed:
  // unrelated output or file activity is not criterion-specific proof.
  return { proved: false, evidence: [] };
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

function buildMissingReceiptIssues(
  receiptLedger: readonly ReceiptEntry[],
): Omit<Issue, "issueId">[] {
  return receiptLedger
    .filter((entry) => entry.status === "MISSING")
    .map((entry) => ({
      severity: "HIGH" as const,
      code: "REQUIRED_RECEIPT_MISSING",
      category: "Proof",
      description: `Required receipt ${entry.ref} is missing: ${entry.required_receipt.details}`,
      expected_receipt: `${entry.required_receipt.type}: ${entry.required_receipt.details}`,
      evidence: `${entry.ref}: status=MISSING; evidence=[]`,
      fix_hint: `Provide criterion-specific evidence for ${entry.ref} and re-run verification.`,
      message: `Required receipt ${entry.ref} is missing.`,
      suggestedFix: `Satisfy ${entry.ref} with verifiable evidence before marking the task complete.`,
    }));
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

// ---------------------------------------------------------------------------
// Training eligibility
//
// A separate axis from the verdict, keyed off integrity rather than success.
// The two questions genuinely come apart:
//
//   honest failure  -> FAIL  + eligible      (worth teaching: it said so)
//   embedded secret -> PASS  + not trainable (worth shipping, not teaching)
//
// Collapsing them into the verdict is what made a correct-but-unpublishable run
// cost a repair pass.
// ---------------------------------------------------------------------------

/** The run misrepresented itself. No verdict redeems it for training purposes. */
const NEVER_TRAINABLE_CODES = new Set([
  "TEST_FILES_MODIFIED_WEAKENED",
  "VERIFIER_FILES_MODIFIED",
  "TEST_OUTPUT_CONTRADICTS_CLAIM",
  "SUSPICIOUS_HARDCODING_COMMENT",
  "SUSPICIOUS_HARDCODING_LITERAL_RETURN",
  "SUSPICIOUS_HARDCODING_BRANCH_TABLE",
  // Claimed an action it cannot show evidence for.
  "PROOF_CLAIM_UNVERIFIED",
]);

/** Out-of-scope or ambiguous — a human decides, rather than a heuristic. */
const ELIGIBILITY_REVIEW_CODES = new Set([
  "FORBIDDEN_PATH_ACCESSED",
  "PACKAGE_SCRIPTS_CHANGED",
]);

/** Correct, but carries a pattern that must not enter the corpus. */
const NOT_TRAINABLE_PATTERN_CODES = new Set([
  "UNSAFE_FUNCTIONAL_PATTERN",
  "EMBEDDED_SECRET_PATTERN",
]);

function deriveTrainingEligibility(verdict: Verdict, issues: Issue[]): TrainingEligibility {
  // Most restrictive wins.
  if (issues.some((i) => NEVER_TRAINABLE_CODES.has(i.code))) return "rejected";
  if (issues.some((i) => ELIGIBILITY_REVIEW_CODES.has(i.code))) return "needs_human_review";
  if (issues.some((i) => NOT_TRAINABLE_PATTERN_CODES.has(i.code))) return "accepted_but_not_trainable";

  // A partial success is too murky to teach from unreviewed: something was left
  // incomplete, and whether that was acceptable is a judgement call. Note this
  // deliberately does NOT extend to FAIL — a run that tried, could not finish,
  // and said so plainly is a clean signal and stays eligible. Ambiguity is the
  // disqualifier here, not failure.
  if (verdict === "WARN") return "needs_human_review";

  return "eligible";
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
  const _profStart = process.env["ORCA_PROFILE"] === "1" ? Date.now() : 0;

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
    // Adversarial checks: was this run made to *look* successful? Emits CRITICAL
    // for tampering with tests or with Pappy's own source, so no amount of
    // semantic correctness in the checks above can redeem it.
    ...runIntegrityChecks(input),
  ];

  // Step 4: build receipt ledger (criteria + claim entries merged).
  // Must happen BEFORE stampIssueIds so CORE_GOAL_MISSING can inspect the ledger.
  const criteriaLedger = buildCriteriaLedger(input, acceptance_criteria);
  const receipt_ledger: ReceiptEntry[] = [...criteriaLedger, ...claimLedger];

  // The ledger is authoritative: a required MISSING row must feed verdict
  // derivation regardless of how many other criteria were proved.
  rawIssues.push(...buildMissingReceiptIssues(receipt_ledger));

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
  const trainingEligibility = deriveTrainingEligibility(verdict, issues);
  const confidence = deriveConfidence(input, issues);
  const hasTrace = (input.toolEvents?.length ?? 0) > 0 || (input.filesChanged?.length ?? 0) > 0;
  const summary  = buildSummary(verdict, issues, hasTrace);
  const internalSummary = buildInternalSummary(verdict, issues);

  // Step 6: repair task (only when not PASS)
  const repair_task   = verdict !== "PASS" ? buildRepairTask(input.task, issues) : null;
  const repairTaskStr = repair_task ? repairTaskToString(repair_task) : undefined;

  if (process.env["ORCA_PROFILE"] === "1") {
    emitOrcaProfileEvent({
      phase: "pappy_eval",
      durationMs: Date.now() - _profStart,
      verdict,
      issueCount: issues.length,
      acCount: acceptance_criteria.length,
      claimCount: claims.length,
    });
  }

  return {
    verdict,
    trainingEligibility,
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

