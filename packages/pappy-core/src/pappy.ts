/**
 * Pappy — "Receipt Checker" QC Gate
 *
 * Identity: the old man at the exit door asking for your receipt.
 * Not creative. Not helpful. Checks receipts.
 *
 * PASS  → all required receipts exist, no HIGH issues
 * WARN  → receipts present but partial gaps or instrumentation missing
 * FAIL  → any required receipt missing, HIGH/CRITICAL issue, or unsafe behavior
 *
 * Pappy establishes what the evidence proves — not what the worker claims,
 * what files changed, or what commands executed. For code work the proof is
 * behavioural: a changed file shows a change, a host-recorded run on the final
 * source that exercises the requirement shows the behaviour.
 */

import type {
  PappyInput,
  PappyResult,
  Issue,
  Verdict,
  TrainingEligibility,
  AcceptanceCriterion,
  Claim,
  CriterionAssessment,
  EvidenceRequest,
  EvidenceStrength,
  ReceiptEntry,
  TaskKind,
  VerificationStatus,
} from "./types.js";
import { runWorkspaceVerificationChecks } from "./checks/workspaceVerification.js";
import type { BehaviouralReceipt } from "./checks/workspaceVerification.js";
import { runSafetyChecks }       from "./checks/safety.js";
import { runToolResultChecks }   from "./checks/toolResults.js";
import { runCompletenessChecks, runSatisfactionChecks } from "./checks/completeness.js";
import { runStructureChecks }    from "./checks/structure.js";
import { runClaimProofChecks } from "./checks/claimProof.js";
import { runBrainChecks }      from "./checks/brain.js";
import { runIntegrityChecks }  from "./checks/integrity.js";
import { extractCriterionSymbols, findCriterionSymbols } from "./checks/criterionSymbols.js";
import { distinctiveTerms, textCoversRequirement } from "./checks/evidenceTerms.js";
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
 * Evidence sources the worker does not author, prepared once per evaluation.
 * `changedContent` is what is actually on disk now for files the runtime saw
 * change; `hostOutput` is tool output the host recorded for commands that ran.
 */
interface IndependentEvidence {
  available: boolean;
  changedPaths: Set<string>;
  /** path → after-content of every non-deleted file the runtime saw change (original case). */
  changedFiles: Map<string, string | undefined>;
  /** path + after-content of every non-deleted file the runtime saw change (lower-cased). */
  changedContent: string;
  /** after-content of changed test files (lower-cased). */
  changedTests: string;
  /** host-recorded output of successful tool calls (lower-cased). */
  hostOutput: string;
}

function independentEvidence(input: PappyInput): IndependentEvidence {
  const workspace = input.workspace;
  const available = workspace?.available === true;
  const changes = available ? workspace!.changes.filter((c) => c.status !== "deleted") : [];
  const hostOutput = (input.toolEvents ?? [])
    .filter((event) => event.ok && event.raw && typeof event.raw === "object")
    .map((event) => (event.raw as Record<string, unknown>)["_outputForProof"])
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .toLowerCase();
  return {
    available,
    changedPaths: new Set(changes.map((c) => c.path)),
    changedFiles: new Map(changes.map((c) => [c.path, c.after])),
    changedContent: changes.map((c) => `${c.path} ${c.after ?? ""}`).join("\n").toLowerCase(),
    changedTests: changes.filter((c) => c.kind === "test").map((c) => c.after ?? "").join("\n").toLowerCase(),
    hostOutput,
  };
}

/** What the ledger knows about the run beyond the worker's account. */
interface LedgerContext {
  taskKind: TaskKind;
  receipts: readonly BehaviouralReceipt[];
}

interface CriterionReceipt {
  proved: boolean;
  partial?: boolean;
  evidence: string[];
  strength: EvidenceStrength;
  /** Lexical match only (no identifier anchors the requirement): candidate evidence, never proof. */
  candidate?: "lexical";
  /** Proved by the presence of the criterion's identifier(s) in evidence, not by anything about what is said of them. */
  presenceOnly?: true;
  /**
   * True when the criterion is about code behaviour (a symbol, an
   * implementation, tests, a parameter) rather than about the response text or
   * the mere existence of a file — such receipts need a behavioural receipt on
   * the final source before they count as proved.
   */
  behavioural?: boolean;
  /** Filled in when the criterion was read against runtime evidence. */
  assessment?: CriterionAssessment;
}

const CODE_CHANGE_KINDS = new Set<TaskKind>(["bugfix", "feature", "refactor"]);

/** The behavioural receipt that speaks for this criterion, if any. */
function supportingReceipt(ac: AcceptanceCriterion, receipts: readonly BehaviouralReceipt[]): BehaviouralReceipt | undefined {
  return receipts.find((r) => r.coversTask || textCoversRequirement(r.text, ac.text).covered);
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
 *
 * Each receipt also records where its evidence came from (`strength`). Claims
 * about files, code and tests are `self_reported` when only the worker's own
 * text or reported diff supports them, `corroborated` when host-recorded tool
 * output names the criterion's terms, and `independent` when the runtime's own
 * workspace evidence confirms them. Criteria about the response text itself are
 * `direct`. A successful tool call never corroborates an unrelated claim.
 */
function verifyAcceptanceCriterion(
  ac: AcceptanceCriterion,
  input: PappyInput,
  independent: IndependentEvidence,
): CriterionReceipt {
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
  /** Strength of a term-based proof: runtime-changed content beats host output beats the worker's account. */
  const termStrength = (term: string): EvidenceStrength => {
    const re = new RegExp(`\\b${term}\\w*\\b`, "i");
    if (independent.available && re.test(independent.changedContent)) return "independent";
    if (re.test(independent.hostOutput)) return "corroborated";
    return "self_reported";
  };
  const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

  // Required file criterion. With runtime evidence the file must really differ
  // on disk; a reported write that changed nothing is not a receipt.
  const fileMatch = ac.text.match(/[Ff]ile ["`']?([^"`'\s]+)["`']? must be/);
  if (fileMatch) {
    const path = fileMatch[1] ?? "";
    if (independent.available) {
      const onDisk = independent.changedPaths.has(normalizePath(path));
      return onDisk
        ? { proved: true, evidence: [`workspace snapshot: ${path} changed`], strength: "independent" }
        : { proved: false, evidence: touched.has(path) ? [`reported write to ${path} left it unchanged on disk`] : [], strength: "none" };
    }
    const proved = touched.has(path);
    return {
      proved,
      evidence: proved ? [`filesChanged: ${path}`] : [],
      strength: proved ? "self_reported" : "none",
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
      strength: hasSectionHeading ? "direct" : "none",
    };
  }

  // Criteria about the response text itself ("Output contains …") are
  // satisfied by the response Pappy is reading: that evidence is direct.
  const aboutTheOutput = /^(output|response|answer|result)\b/i.test(ac.text);

  // Check for code / implementation requirements. Mere prose mentioning code
  // keywords (or an otherwise empty fenced block) is not a receipt.
  if (criterionContainsTerm("code") || criterionContainsTerm("implementation") || criterionContainsTerm("function") || criterionContainsTerm("class") || criterionContainsTerm("TypeScript")) {
    const codeDeclarationPattern = /\b(?:function\s+[A-Za-z_$][\w$]*\s*\(|class\s+[A-Za-z_$][\w$]*(?:\s+\w+)*\s*\{|(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=;\n]+)?\s*=|(?:interface|type|enum)\s+[A-Za-z_$][\w$]*|def\s+[A-Za-z_]\w*\s*\()/;
    const hasCodeInOutput = codeDeclarationPattern.test(outputText);
    const hasCodeInDiff = codeDeclarationPattern.test(diffText);
    const hasCodeOnDisk = independent.available && codeDeclarationPattern.test(independent.changedContent);
    const hasCode = hasCodeInOutput || hasCodeInDiff || hasCodeOnDisk;

    if (hasCode) {
      return {
        proved: true,
        evidence: hasCodeOnDisk
          ? ["code declaration found in files the runtime saw change"]
          : hasCodeInOutput
            ? ["code declaration found in output"]
            : ["code declaration found in non-deleted file diff"],
        strength: hasCodeOnDisk ? "independent" : hasCodeInOutput && aboutTheOutput ? "direct" : "self_reported",
        behavioural: !aboutTheOutput,
      };
    }
    return { proved: false, evidence: [], strength: "none" };
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
    const hasTestOnDisk = independent.available && /\b(?:describe|it|test|expect)\s*\(/i.test(independent.changedTests);
    const hasTestArtifact = hasTestFunctions || hasTestFile || hasTestOnDisk;

    if (hasTestFramework && hasTestArtifact) {
      return {
        proved: true,
        evidence: [
          ...(hasTestOnDisk ? ["test file changed on disk contains test functions"] : []),
          ...(requestedFrameworks.length > 0 ? ["requested test framework used in code"] : []),
          ...(hasTestFunctions ? ["test functions (describe/it/expect) found"] : []),
          ...(hasTestFile ? ["test file in filesChanged"] : []),
        ],
        strength: hasTestOnDisk ? "independent" : "self_reported",
        behavioural: !aboutTheOutput,
      };
    }
    return { proved: false, evidence: [], strength: "none" };
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
        strength: termStrength(paramName),
        behavioural: true,
      };
    }
    return { proved: false, evidence: [], strength: "none" };
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
      const terms: string[] = [];
      if (criterionMentionsTracking) {
        evidence.push(
          entity
            ? `tracked entity "${entity}" found in output`
            : "tracking mechanism (clientId/track) found",
        );
        terms.push(entity ?? "track");
      }
      if (criterionMentionsCleanup) {
        evidence.push("cleanup/stale/expire/evict term found");
        terms.push("cleanup", "stale", "expire", "evict");
      }
      const strengths = terms.map(termStrength);
      const strength: EvidenceStrength = strengths.includes("independent") ? "independent" : strengths.includes("corroborated") ? "corroborated" : "self_reported";
      return { proved: true, evidence, strength, behavioural: true };
    }
    return { proved: false, evidence: [], strength: "none" };
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
      strength: outputMentionsLimitation ? "direct" : "none",
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
      strength: proved ? "direct" : "none",
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
      strength: proved ? "direct" : "none",
    };
  }

  // Identifier-anchored behavioural criteria — "<symbol> must <do something>",
  // the dominant shape for coding work. These match none of the verifiers above
  // and previously fell straight to fail-closed, which is why correct work
  // naming a real symbol had no way to produce a receipt at all.
  const symbols = extractCriterionSymbols(ac.text);
  if (symbols.length > 0) {
    // Joined with spaces because this only ever feeds a substring check.
    const changedCode = presentFiles.map((f) => `${f.path} ${f.diff ?? ""}`).join(" ");
    const { inCode, inAccount } = findCriterionSymbols(symbols, changedCode, outputText);
    // The runtime's own record of what changed, and what the host saw commands print.
    const onDisk = independent.available ? findCriterionSymbols(symbols, independent.changedContent, "").inCode : [];
    const inHostOutput = independent.hostOutput ? findCriterionSymbols(symbols, independent.hostOutput, "").inCode : [];

    if (inCode.length > 0 || inAccount.length > 0 || onDisk.length > 0 || inHostOutput.length > 0) {
      // A unified diff routinely changes a function's body without restating
      // its name, so requiring the symbol inside the diff alone rejects correct
      // work over a property of diff formatting. The agent's own account naming
      // the symbol is evidence — but the agent writes that text, so on its own
      // it proves nothing.
      //
      // With runtime evidence the symbol must be in a file the runtime saw
      // change (the implementation receipt); whether its *behaviour* holds is
      // decided afterwards against the behavioural receipts. Host output naming
      // the symbol without a change on disk is not an implementation. Without
      // runtime evidence the legacy rule stands — the symbol in the reported
      // diff, or in the account plus a tool event that ran — but that is
      // self-reported. PARTIAL is the symbol named with nothing objective behind it.
      const named = [...new Set([...onDisk, ...inHostOutput, ...inCode, ...inAccount])].join(", ");
      const legacyCorroborated = inCode.length > 0 || (!independent.available && (input.toolEvents ?? []).some((e) => e.ok));

      if (onDisk.length > 0) {
        return {
          proved: true,
          presenceOnly: true,
          evidence: [`criterion symbol(s) ${named} present in files the runtime saw change`],
          strength: "independent",
          behavioural: true,
        };
      }
      if (independent.available && inHostOutput.length > 0) {
        return {
          proved: false,
          partial: true,
          evidence: [`criterion symbol(s) ${named} named in host-recorded command output, but no file containing them changed on disk`],
          strength: "corroborated",
          behavioural: true,
        };
      }
      if (!independent.available && inHostOutput.length > 0) {
        return {
          proved: true,
          presenceOnly: true,
          evidence: [`criterion symbol(s) ${named} present in host-recorded command output`],
          strength: "corroborated",
          behavioural: true,
        };
      }
      if (legacyCorroborated) {
        return {
          proved: true,
          presenceOnly: true,
          evidence: [
            `criterion symbol(s) ${named} present in ${inCode.length > 0 ? "changed code" : "the run account"}`,
            ...(hasFiles ? [`filesChanged: ${input.filesChanged!.length} file(s)`] : []),
            ...(hasTools ? [`toolEvents: ${input.toolEvents!.length} event(s)`] : []),
          ],
          strength: "self_reported",
          behavioural: true,
        };
      }
      return {
        proved: false,
        partial: true,
        evidence: [`criterion symbol(s) ${named} named, but nothing objective corroborates the change`],
        strength: "self_reported",
        behavioural: true,
      };
    }
  }

  // A criterion that names a workspace file which the runtime saw change
  // ("docs/guide.md must document the back-to-back rule"). Only runtime
  // evidence counts here — never the worker's reported writes — and the file's
  // final content must carry the criterion's own terms: a renamed or rewritten
  // document that omits the requested item is a change, not a receipt.
  if (independent.available) {
    const namedPaths = [...ac.text.matchAll(/(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g)]
      .map((m) => normalizePath(m[1]!))
      .filter((p) => /[\/.]/.test(p) && !/^\d+\.\d+$/.test(p));
    const changedNamed = namedPaths.filter((p) => independent.changedPaths.has(p));
    if (changedNamed.length > 0) {
      const contents = changedNamed.map((p) => independent.changedFiles.get(p)).filter((c): c is string => typeof c === "string");
      if (contents.length === 0) {
        return {
          proved: false,
          partial: true,
          evidence: [`named file(s) changed on disk: ${changedNamed.join(", ")}, but their content was not captured, so it could not be checked against the criterion`],
          strength: "independent",
          assessment: {
            requires: ac.text,
            satisfiedBy: `the final content of ${changedNamed.join(", ")} containing what the criterion asks for`,
            supportedBy: [`${changedNamed.join(", ")} changed on disk`],
            sufficient: false,
            needed: "captured final content of the named file(s)",
          },
        };
      }
      const { covered, matched, terms } = textCoversRequirement(contents.join("\n"), ac.text);
      if (covered) {
        const anchored = extractCriterionSymbols(ac.text).length > 0;
        if (anchored) {
          return {
            proved: true,
            presenceOnly: true,
            evidence: [`named file(s) changed on disk: ${changedNamed.join(", ")}; final content contains ${matched.slice(0, 5).join(", ")}`],
            strength: "independent",
            assessment: {
              requires: ac.text,
              satisfiedBy: `the final content of ${changedNamed.join(", ")} containing what the criterion asks for`,
              supportedBy: [`${changedNamed.join(", ")} changed on disk`, `final content names ${matched.slice(0, 5).join(", ")}`],
              sufficient: true,
            },
          };
        }
        // No identifier anchors the requirement: that the document uses its
        // words (${matched}/${terms}) is candidate evidence for a human, not
        // proof that it says what was asked. Never VERIFIED on this alone.
        return {
          proved: false,
          partial: true,
          candidate: "lexical",
          evidence: [`named file(s) changed on disk: ${changedNamed.join(", ")}; final content uses ${matched.length} of ${terms.length} of the requirement's words (${matched.slice(0, 5).join(", ")}) — candidate evidence, not proof`],
          strength: "independent",
          assessment: {
            requires: ac.text,
            satisfiedBy: `a human reading of ${changedNamed.join(", ")} confirming it says what the criterion asks, or a requirement anchored on an identifier or a documented validation`,
            supportedBy: [`${changedNamed.join(", ")} changed on disk`, `final content uses the requirement's words: ${matched.slice(0, 5).join(", ")}`],
            sufficient: false,
            needed: `human review of ${changedNamed.join(", ")} (word overlap cannot show the requested content is present and correct)`,
          },
        };
      }
      const missing = terms.filter((t) => !matched.includes(t));
      return {
        proved: false,
        partial: true,
        evidence: [`named file(s) changed on disk: ${changedNamed.join(", ")}, but the final content does not contain ${missing.slice(0, 5).join(", ") || "the criterion's terms"}`],
        strength: "independent",
        assessment: {
          requires: ac.text,
          satisfiedBy: `the final content of ${changedNamed.join(", ")} containing what the criterion asks for`,
          supportedBy: [`${changedNamed.join(", ")} changed on disk`],
          sufficient: false,
          contradictedBy: `final content lacks ${missing.slice(0, 5).join(", ") || "the requested item"}`,
          needed: `the requested item (${missing.slice(0, 5).join(", ")}) written into ${changedNamed.join(", ")}`,
        },
      };
    }
  }

  // Unknown semantic criteria have no deterministic verifier. Fail closed:
  // unrelated output or file activity is not criterion-specific proof.
  return { proved: false, evidence: [], strength: "none" };
}

/**
 * Tie a code-behaviour receipt to the behavioural evidence the host recorded.
 * An implementation on disk is proof of a change; the criterion is proved only
 * when a receipt on the final source speaks for it — a reproduced-then-passing
 * failure or full suite for the task, or a test/validation whose text names
 * this criterion. Otherwise the receipt becomes PARTIAL and says what is missing.
 */
function requireBehaviouralEvidence(
  ac: AcceptanceCriterion,
  receipt: CriterionReceipt,
  context: LedgerContext,
): CriterionReceipt {
  const symbols = extractCriterionSymbols(ac.text);
  const what = symbols.length > 0 ? symbols.join(", ") : "the requested behaviour";
  const satisfiedBy = `a host-recorded test or validation run on the final source that exercises ${what}`;
  const supporter = supportingReceipt(ac, context.receipts);
  if (receipt.proved && supporter) {
    return {
      ...receipt,
      evidence: [...receipt.evidence, `behavioural receipt: ${supporter.summary}`],
      assessment: {
        requires: ac.text,
        satisfiedBy,
        supportedBy: [...receipt.evidence, supporter.summary],
        sufficient: true,
      },
    };
  }
  if (receipt.proved) {
    const unrelated = context.receipts.filter((r) => r !== supporter);
    return {
      proved: false,
      partial: true,
      evidence: [...receipt.evidence, `no behavioural receipt on the final source exercises ${what}`],
      strength: receipt.strength,
      behavioural: true,
      assessment: {
        requires: ac.text,
        satisfiedBy,
        supportedBy: receipt.evidence,
        sufficient: false,
        needed: unrelated.length > 0
          ? `a test or validation run that exercises ${what} (the recorded ${unrelated.map((r) => r.kind.replace(/_/g, " ")).join(", ")} does not name it)`
          : `a test or validation run on the final source that exercises ${what}`,
      },
    };
  }
  return {
    ...receipt,
    assessment: receipt.assessment ?? {
      requires: ac.text,
      satisfiedBy,
      supportedBy: receipt.evidence,
      sufficient: false,
      needed: receipt.partial
        ? `a change on disk that contains ${what}, and a test or validation run on the final source that exercises it`
        : `an implementation of ${what} on disk and a test or validation run that exercises it`,
    },
  };
}

/**
 * Words that describe the act of mentioning rather than a claim about the
 * identifier: a requirement left with none of its distinctive words once the
 * identifiers and these are removed asks only that the identifier appear.
 */
const MENTION_WORDS = new Set([
  "mention", "mentions", "mentioned", "mentioning", "reference", "references", "referenced", "referencing",
  "include", "includes", "included", "including", "contain", "contains", "contained", "containing",
  "list", "lists", "listed", "listing", "name", "names", "named", "naming", "show", "shows", "shown", "showing",
  "appear", "appears", "appeared", "present", "exist", "exists", "export", "exports", "exported", "define", "defines", "defined",
  "document", "documents", "documented", "documenting", "describe", "describes", "described", "describing",
  "cover", "covers", "covered", "explain", "explains", "explained", "note", "notes", "noted", "docs", "documentation", "readme",
  "section", "page", "file", "files", "heading", "paragraph", "sentence", "line", "lines",
]);

/**
 * Presence is not a claim. A criterion anchored on an identifier is proved by
 * that identifier's presence only when it asks for nothing more than the
 * mention ("docs/x.md must mention `foo`"). When it makes a substantive
 * claim about the identifier ("document that `foo` refuses unpriced
 * models"), the identifier appearing in a changed file — beside words that
 * may say the opposite — cannot show the claim holds. No keyword rule
 * understands the sentence; so the receipt becomes candidate evidence for a
 * human, with the explanation of what presence could and could not show. A
 * host-recorded run on the final source that covers the criterion proves the
 * *behaviour*; it still cannot vouch for what a document says, so the
 * candidate note says the behaviour is verified and only the wording needs
 * a reader. Code-behaviour criteria in code-change tasks are not routed here:
 * they already need a behavioural receipt (requireBehaviouralEvidence).
 */
function requireSubstantiveEvidence(
  ac: AcceptanceCriterion,
  receipt: CriterionReceipt,
  context: LedgerContext,
): CriterionReceipt {
  if (!receipt.proved || !receipt.presenceOnly) return receipt;
  const symbols = extractCriterionSymbols(ac.text).map((s) => s.toLowerCase());
  const substantive = distinctiveTerms(ac.text).filter((t) => !symbols.includes(t.toLowerCase()) && !MENTION_WORDS.has(t.toLowerCase()));
  if (substantive.length === 0) return receipt; // mention-only: presence is exactly what was asked
  const named = symbols.join(", ");
  const supporter = supportingReceipt(ac, context.receipts);
  const behaviourVerified = supporter !== undefined && supporter.sourceState === "final";
  return {
    proved: false,
    partial: true,
    candidate: "lexical",
    evidence: [
      ...receipt.evidence,
      behaviourVerified
        ? `the behaviour is host-verified (${supporter!.summary}), but whether the document states it correctly needs a reader`
        : `presence of ${named} cannot show that what is said about it (${substantive.slice(0, 6).join(", ")}) is present and correct — candidate evidence, not proof`,
    ],
    strength: receipt.strength,
    behavioural: receipt.behavioural,
    assessment: {
      requires: ac.text,
      satisfiedBy: behaviourVerified
        ? `a human reading confirming the document states the host-verified behaviour of ${named}`
        : `a human reading confirming the document says what the criterion asks about ${named}, or a host-recorded run on the final source that shows it`,
      supportedBy: [...receipt.evidence, ...(behaviourVerified ? [supporter!.summary] : [])],
      sufficient: false,
      needed: behaviourVerified
        ? `human review of the document's statement about ${named} (its behaviour is host-verified; the wording is not)`
        : `human review of the document's statement about ${named}, or a host-recorded run on the final source that shows ${substantive.slice(0, 4).join(", ")}`,
    },
  };
}

/**
 * A criterion proved by the final content of a named file that two workers
 * wrote in the same pass rests on evidence nobody can attribute: unless a
 * host-recorded run on the final source speaks for the task, the receipt
 * becomes PARTIAL and says what would settle it. Criteria proved by a
 * behavioural run already stand on the final state and are left alone.
 */
function requireAttributableEvidence(
  ac: AcceptanceCriterion,
  receipt: CriterionReceipt,
  input: PappyInput,
  context: LedgerContext,
): CriterionReceipt {
  const contested = input.workspace?.contested ?? [];
  if (!receipt.proved || contested.length === 0) return receipt;
  const cited = contested.filter((c) => receipt.evidence.some((line) => /named file\(s\) changed on disk:/.test(line) && line.includes(c.path)));
  if (cited.length === 0) return receipt;
  const finalProof = context.receipts.some((r) => r.sourceState === "final" && r.coversTask && r.kind !== "final_content");
  if (finalProof) {
    return { ...receipt, evidence: [...receipt.evidence, `attribution unresolved: ${cited.map((c) => `${c.path} written by ${c.writers.join(" and ")}`).join("; ")} (final state verified by a run on the final source)`] };
  }
  const list = cited.map((c) => `${c.path} (written by ${c.writers.join(" and ")} in one pass)`).join("; ");
  return {
    proved: false,
    partial: true,
    evidence: [...receipt.evidence, `contested: ${list}; no run on the final source vouches for the content`],
    strength: receipt.strength,
    assessment: {
      requires: ac.text,
      satisfiedBy: `the final content of ${cited.map((c) => c.path).join(", ")} verified by a run on the final source, or written by one worker`,
      supportedBy: receipt.evidence,
      sufficient: false,
      needed: `a test or validation run on the settled final content of ${cited.map((c) => c.path).join(", ")} (two workers wrote it in one pass, so the content cannot be credited to either)`,
    },
  };
}

/**
 * One ledger entry per criterion. Mandatory-evidence rule: when the runtime
 * supplied workspace evidence (available or not), a required criterion whose
 * only support is the worker's own account cannot stay PROVED — it becomes
 * UNVERIFIED, which fails the run until independent evidence exists; and a
 * code-behaviour criterion is PROVED only with a behavioural receipt. Callers
 * that supply no workspace evidence at all keep the legacy statuses; their
 * results are marked not independently verified and are never trainable.
 */
function buildCriteriaLedger(
  input: PappyInput,
  criteria: AcceptanceCriterion[],
  context: LedgerContext,
): ReceiptEntry[] {
  const entries: ReceiptEntry[] = [];
  const independent = independentEvidence(input);
  const mandatory = input.workspace !== undefined;

  for (const ac of criteria) {
    let receipt = verifyAcceptanceCriterion(ac, input, independent);
    if (independent.available && receipt.behavioural && CODE_CHANGE_KINDS.has(context.taskKind)) {
      receipt = requireBehaviouralEvidence(ac, receipt, context);
    }
    // Code-behaviour criteria of code-change tasks are governed by the behavioural rule above.
    if (independent.available && !(receipt.behavioural && CODE_CHANGE_KINDS.has(context.taskKind))) receipt = requireSubstantiveEvidence(ac, receipt, context);
    receipt = requireAttributableEvidence(ac, receipt, input, context);
    const { proved, partial, evidence, strength, assessment, candidate } = receipt;
    let status: ReceiptEntry["status"] = proved ? "PROVED" : partial ? "PARTIAL" : "MISSING";
    if (mandatory && ac.required && status === "PROVED" && strength === "self_reported") {
      status = "UNVERIFIED";
    }

    const entry: ReceiptEntry = {
      ref: ac.id,
      required_receipt: {
        type: "criterion_specific",
        details: ac.text.slice(0, 80) + (ac.text.length > 80 ? "..." : ""),
      },
      status,
      evidence,
      strength,
      ...(candidate ? { candidate } : {}),
    };
    if (mandatory && ac.required) {
      entry.assessment = assessment ?? {
        requires: ac.text,
        satisfiedBy: "criterion-specific evidence the worker did not author",
        supportedBy: evidence,
        sufficient: status === "PROVED",
        ...(status === "PROVED" ? {} : { needed: status === "UNVERIFIED" ? "independent evidence (a real change on disk or a host-recorded run) for what the account reports" : "criterion-specific evidence" }),
      };
    }
    entries.push(entry);
  }

  return entries;
}

function buildMissingReceiptIssues(
  receiptLedger: readonly ReceiptEntry[],
  mandatory: boolean,
): Omit<Issue, "issueId">[] {
  // UNVERIFIED is insufficient proof, not proven incorrectness: the worker
  // reported satisfying the criterion but nothing the runtime recorded
  // confirms it. It still fails the run — mandatory evidence cannot become a
  // warning — and the wording keeps the two cases apart.
  const unverified: Omit<Issue, "issueId">[] = receiptLedger
    .filter((entry) => entry.status === "UNVERIFIED")
    .map((entry) => ({
      severity: "HIGH" as const,
      code: "REQUIRED_EVIDENCE_INSUFFICIENT",
      category: "Proof" as const,
      description: `Not verified (insufficient independent evidence): ${entry.ref} is supported only by the worker's own account — ${entry.required_receipt.details}`,
      expected_receipt: `${entry.required_receipt.type}: ${entry.required_receipt.details}`,
      evidence: `${entry.ref}: status=UNVERIFIED; strength=self_reported; evidence=${JSON.stringify(entry.evidence)}`,
      fix_hint: `Produce independent evidence for ${entry.ref}: a real change in the workspace that the runtime can see, or a host-recorded command/test run that shows it.`,
      message: `Receipt ${entry.ref} is not independently verified.`,
      suggestedFix: `Back ${entry.ref} with a real file change or a recorded test/command result.`,
    }));

  // PARTIAL: the criterion's subject was genuinely touched, but its behaviour
  // is not shown. With runtime evidence that is mandatory evidence not met —
  // HIGH, worded as insufficient proof — because a change is not a result.
  // Legacy callers (no workspace evidence) keep the MEDIUM note: for them a
  // diff that omits the symbol is a property of diff formatting, not of the work.
  // Candidate evidence (a document that uses the requirement's words): not
  // proof, so the run is not verified and not trainable, but not shown wrong
  // either — a human decides. MEDIUM, with the review need stated.
  const candidates: Omit<Issue, "issueId">[] = receiptLedger
    .filter((entry) => entry.status === "PARTIAL" && entry.candidate === "lexical")
    .map((entry) => ({
      severity: "MEDIUM" as const,
      code: "RECEIPT_LEXICAL_CANDIDATE",
      category: "Proof" as const,
      description: `Not verified (candidate evidence only): ${entry.ref} — ${entry.evidence[entry.evidence.length - 1] ?? "the evidence names the requirement's terms, which does not show it says what was asked"}; needs human review — ${entry.required_receipt.details}`,
      expected_receipt: entry.assessment?.satisfiedBy ?? `${entry.required_receipt.type}: ${entry.required_receipt.details}`,
      evidence: `${entry.ref}: status=PARTIAL; candidate=lexical; evidence=${JSON.stringify(entry.evidence)}`,
      fix_hint: entry.assessment?.needed ? `Provide ${entry.assessment.needed}.` : `Have a human confirm the document says what ${entry.ref} asks.`,
      message: `Receipt ${entry.ref} is candidate evidence only (lexical match).`,
      suggestedFix: `Review the document for ${entry.ref}, or anchor the requirement on an identifier or a documented validation.`,
    }));

  const partial: Omit<Issue, "issueId">[] = receiptLedger
    .filter((entry) => entry.status === "PARTIAL" && entry.candidate !== "lexical")
    .map((entry) => ({
      severity: mandatory ? ("HIGH" as const) : ("MEDIUM" as const),
      code: "RECEIPT_PARTIAL",
      category: "Proof" as const,
      description: mandatory
        ? `Not verified (insufficient evidence): ${entry.ref} — ${entry.assessment?.contradictedBy ? entry.assessment.contradictedBy : `the change is on record but nothing recorded shows the criterion's behaviour holds`} — ${entry.required_receipt.details}`
        : `Receipt ${entry.ref} is partial: the named code was changed, but the criterion's behaviour is unverified — ${entry.required_receipt.details}`,
      expected_receipt: entry.assessment?.satisfiedBy ?? `${entry.required_receipt.type}: ${entry.required_receipt.details}`,
      evidence: `${entry.ref}: status=PARTIAL; evidence=${JSON.stringify(entry.evidence)}`,
      fix_hint: entry.assessment?.needed
        ? `Provide ${entry.assessment.needed}.`
        : `Show the criterion's behaviour holds for ${entry.ref} — a passing test or command output naming it.`,
      message: `Receipt ${entry.ref} is partial.`,
      suggestedFix: `Add executable proof for ${entry.ref}.`,
    }));

  const missing: Omit<Issue, "issueId">[] = receiptLedger
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

  return [...missing, ...unverified, ...partial, ...candidates];
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
  // Workspace evidence shows the suite was made to pass rather than fixed.
  "TEST_FILE_DELETED",
  "TEST_EDIT_PROHIBITED",
  "FIX_TEST_COUNT_DROPPED",
  "REFACTOR_TEST_COUNT_DROPPED",
  "FEATURE_TEST_COUNT_DROPPED",
  "FORBIDDEN_DELETE_DETECTED",
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

/**
 * The worker's account presents the work as done, working or accomplished.
 * Broad on purpose: past-tense accomplishment verbs ("Documented…",
 * "Extracted…") and bare "pass" count. This list is a *signal* that the
 * account claims success; it is never what keeps a contradicted run out of
 * training — that is the default (see `deriveTrainingEligibility`).
 */
const SUCCESS_CLAIM_PATTERN =
  /\b(fixed|resolved|works|working|pass|passes|passed|passing|green|succeeded|successfully|complete|completed|done|implemented|verified|confirmed|documented|added|extracted|refactored|updated|created|wrote|written|changed|removed|renamed|in\s+place|now\s+(?:returns?|handles?|supports?|works?|uses?|checks?|does|accepts?|rejects?|treats?)|has\s+been|have\s+been|is\s+now|are\s+now)\b/i;

/**
 * The account says, in its own words, that the work did not succeed or was
 * not done: the honest-failure signal. "0 failed" is a pass count, not an
 * acknowledgement.
 */
const FAILURE_ACKNOWLEDGED_PATTERN =
  /\b(did\s+not|didn't|could\s+not|couldn't|cannot|can't|unable|was\s+not\s+able|not\s+(?:yet\s+)?(?:fixed|resolved|implemented|done|complete|completed|verified|possible|changed|modified)|no\s+(?:files?|changes?|modifications?|source)\s+(?:were|was|have\s+been|has\s+been)?\s*(?:modified|changed|made|written|touched)|(?:still|remains?|remaining)\s+(?:fail\w*|broken|open|unresolved|present)|(?<!\b0\s)(?:fails?|failing|failed)|gave\s+up|blocked|incomplete|partially|ran\s+out\s+of|not\s+able\s+to)\b/i;

export function accountClaimsSuccess(outputText: string): boolean {
  return SUCCESS_CLAIM_PATTERN.test(outputText);
}

export function accountAcknowledgesFailure(outputText: string): boolean {
  return FAILURE_ACKNOWLEDGED_PATTERN.test(outputText);
}

function deriveTrainingEligibility(
  verdict: Verdict,
  issues: Issue[],
  verification: VerificationStatus,
  outputText: string,
): TrainingEligibility {
  // Most restrictive wins.
  if (issues.some((i) => NEVER_TRAINABLE_CODES.has(i.code))) return "rejected";

  // Host evidence contradicts the objective. The only account that survives
  // this is an honest one: it acknowledges the failure and does not present the
  // work as done. Everything else is excluded by default — a success claim the
  // evidence refutes is rejected outright, a mixed account or a silent one goes
  // to a human. No keyword list is needed to keep a fabricated run out.
  if (verification.status === "contradicted") {
    const account = outputText.trim();
    if (!account) return "needs_human_review";
    const acknowledges = accountAcknowledgesFailure(account);
    const claims = accountClaimsSuccess(account);
    if (acknowledges && !claims) return "eligible";
    if (acknowledges && claims) return "needs_human_review";
    if (claims) return "rejected";
    return "needs_human_review";
  }
  if (issues.some((i) => ELIGIBILITY_REVIEW_CODES.has(i.code))) return "needs_human_review";

  // Evidence-integrity gate. Training needs more than a verdict: the run's
  // claims must have been checked against evidence the worker could not author.
  // Without host evidence (no workspace captured, or unreadable) nothing
  // separates an honest run from a well-worded one, so it is never eligible —
  // for legacy callers as much as anyone.
  const hostEvidence = verification.status !== "not_applicable" && verification.status !== "unavailable";
  if (!hostEvidence) return verdict === "PASS" ? "accepted_but_not_trainable" : "needs_human_review";

  // A FAIL is a clean signal only when the evidence actually judged it (an
  // honest failure that the evidence confirms). When the evidence was merely
  // insufficient, a human decides whether the attempt is worth teaching.
  if (verdict === "FAIL" && (verification.status === "unverified" || verification.status === "uninterpretable")) return "needs_human_review";

  if (issues.some((i) => NOT_TRAINABLE_PATTERN_CODES.has(i.code))) return "accepted_but_not_trainable";

  // A partial success is too murky to teach from unreviewed: something was left
  // incomplete, and whether that was acceptable is a judgement call. Note this
  // deliberately does NOT extend to FAIL — a run that tried, could not finish,
  // and said so plainly is a clean signal and stays eligible. Ambiguity is the
  // disqualifier here, not failure.
  if (verdict === "WARN") return "needs_human_review";

  // A PASS is trainable only when the evidence verified it, including a
  // host-recorded test run on the final source. A positive verdict is not an
  // authorisation to train.
  // A change nobody can attribute to one worker is never a training candidate,
  // however well the final state is verified: the lesson would be credited to
  // the wrong author.
  if (verification.attributionUnresolved) return "accepted_but_not_trainable";

  if (verdict === "PASS") {
    return verification.status === "verified" && verification.testEvidence ? "eligible" : "accepted_but_not_trainable";
  }

  return "eligible";
}

/**
 * Heuristic only. A fixed deduction per issue severity after the verdict is
 * decided; it is not calibrated against correctness and must not gate any
 * decision. `PappyResult.confidenceBasis` says so to every consumer.
 */
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

function buildSummary(verdict: Verdict, issues: Issue[], hasTrace: boolean, verification: VerificationStatus): string {
  if (verdict === "PASS") {
    if (verification.status !== "verified") {
      return "All required receipts are present. Task output is accepted but not independently verified (no runtime workspace evidence).";
    }
    const behavioural = verification.behaviouralEvidence?.length
      ? ` Behavioural evidence: ${verification.behaviouralEvidence.join("; ")}.`
      : "";
    return `All required receipts are present. Task output is verified against runtime evidence.${behavioural}`;
  }

  const highCount = issues.filter(
    (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
  ).length;
  const medCount = issues.filter((i) => i.severity === "MEDIUM").length;
  const insufficient = issues.filter((i) => /^Not verified \(/.test(i.description)).length;
  const contradicted = verification.status === "contradicted";

  const parts: string[] = [];
  if (contradicted) parts.push("evidence contradicts the reported work");
  if (insufficient > 0) parts.push(`${insufficient} criterion/check${insufficient > 1 ? "s" : ""} lack independent evidence`);
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

/**
 * Evidence Pappy still needs, stated per requirement so a caller can collect
 * exactly that rather than redo the task. Built from the criteria ledger
 * (what each criterion lacks) and from the workspace checks whose finding is
 * insufficient or unreadable evidence rather than a contradiction. Descriptive
 * only: Pappy does not run anything, fabricate a receipt, or start a repair.
 */
const INSUFFICIENT_PREFIX = /^Not verified \((?:insufficient (?:independent )?evidence|evidence could not be interpreted)\): /;

function buildEvidenceRequests(
  criteria: readonly AcceptanceCriterion[],
  ledger: readonly ReceiptEntry[],
  issues: readonly Issue[],
  verification: VerificationStatus,
): EvidenceRequest[] {
  const requests: EvidenceRequest[] = [];
  const confirmedByWorkspace = [
    ...(verification.behaviouralEvidence ?? []),
  ];
  for (const entry of ledger) {
    if (entry.status === "PROVED" || !entry.assessment || entry.assessment.sufficient) continue;
    const ac = criteria.find((c) => c.id === entry.ref);
    if (!ac?.required) continue;
    requests.push({
      ref: entry.ref,
      requirement: ac.text,
      confirmed: entry.assessment.supportedBy,
      missing: entry.assessment.needed ?? entry.assessment.satisfiedBy,
      action: `${entry.assessment.supportedBy.length > 0 ? `${entry.assessment.supportedBy.join("; ")}. ` : ""}Required evidence is missing: ${entry.assessment.needed ?? entry.assessment.satisfiedBy}. Provide it and report the observed result.`,
    });
  }
  for (const issue of issues) {
    if (issue.category !== "Proof" || !INSUFFICIENT_PREFIX.test(issue.description)) continue;
    if (/^(REQUIRED_EVIDENCE_INSUFFICIENT|RECEIPT_PARTIAL)$/.test(issue.code)) continue; // covered per criterion above
    requests.push({
      ref: issue.code,
      requirement: issue.description.replace(INSUFFICIENT_PREFIX, ""),
      confirmed: confirmedByWorkspace,
      missing: issue.expected_receipt,
      action: issue.fix_hint,
    });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Keyword heuristics that stand in for evidence when there is none: once the
 * runtime's own evidence has proved every goal-derived criterion with an
 * independent, corroborated or direct receipt, the worker's choice of words is
 * no longer the question, and these notes are dropped. Legacy callers (no
 * workspace evidence) keep them.
 */
const SUPERSEDED_BY_EVIDENCE_CODES = new Set(["COMPLETENESS_GOAL_COVERAGE", "COMPLETENESS_MISSING_DOMAIN_TERMS"]);

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

  // Step 3b: workspace verification from runtime evidence (what really changed
  // on disk, which test commands really ran, what behaviour the host saw).
  // Task-aware; inert without `input.workspace`. Where it reports the same code
  // as the diff-based integrity check, the evidence-backed finding replaces the
  // reported-diff one.
  const workspaceVerification = runWorkspaceVerificationChecks(input);
  if (workspaceVerification.issues.length > 0) {
    const evidenceCodes = new Set(workspaceVerification.issues.map((issue) => issue.code));
    for (let i = rawIssues.length - 1; i >= 0; i--) {
      if (evidenceCodes.has(rawIssues[i]!.code)) rawIssues.splice(i, 1);
    }
    rawIssues.push(...workspaceVerification.issues);
  }

  // Step 4: build receipt ledger (criteria + claim entries merged).
  // Must happen BEFORE stampIssueIds so CORE_GOAL_MISSING can inspect the ledger.
  const criteriaLedger = buildCriteriaLedger(input, acceptance_criteria, {
    taskKind: workspaceVerification.verification.taskKind,
    receipts: workspaceVerification.receipts,
  });
  const receipt_ledger: ReceiptEntry[] = [...criteriaLedger, ...claimLedger];

  // The ledger is authoritative: a required MISSING row must feed verdict
  // derivation regardless of how many other criteria were proved.
  rawIssues.push(...buildMissingReceiptIssues(receipt_ledger, input.workspace !== undefined));

  // Evidence supersedes the word-matching stand-ins (see SUPERSEDED_BY_EVIDENCE_CODES).
  if (input.workspace?.available) {
    const goalCriteria = criteriaLedger.slice(0, (input.goals ?? []).length);
    const allProvedByEvidence = goalCriteria.length > 0 && goalCriteria.every((e) =>
      e.status === "PROVED" && (e.strength === "independent" || e.strength === "corroborated" || e.strength === "direct"));
    if (allProvedByEvidence) {
      for (let i = rawIssues.length - 1; i >= 0; i--) {
        if (SUPERSEDED_BY_EVIDENCE_CODES.has(rawIssues[i]!.code)) rawIssues.splice(i, 1);
      }
    }
  }

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

  // Step 5: verdict, then the three separate axes: evidence status (what the
  // evidence shows), training eligibility (integrity), heuristic confidence.
  const verdict  = deriveVerdict(issues);
  const verification = deriveVerificationStatus(workspaceVerification.verification, criteriaLedger, claimLedger, input.workspace?.available === true);
  const trainingEligibility = deriveTrainingEligibility(verdict, issues, verification, input.outputText ?? "");
  const confidence = deriveConfidence(input, issues);
  const hasTrace = (input.toolEvents?.length ?? 0) > 0 || (input.filesChanged?.length ?? 0) > 0;
  const summary  = buildSummary(verdict, issues, hasTrace, verification);
  const internalSummary = buildInternalSummary(verdict, issues);
  const evidenceRequests = input.workspace !== undefined
    ? buildEvidenceRequests(acceptance_criteria, criteriaLedger, issues, verification)
    : undefined;

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
    verification,
    trainingEligibility,
    confidence,
    confidenceBasis: "heuristic",
    summary,
    acceptance_criteria,
    claims,
    receipt_ledger,
    issues,
    ...(evidenceRequests && evidenceRequests.length > 0 ? { evidenceRequests } : {}),
    repair_task,
    internalSummary,
    repairTask: repairTaskStr,  // backward compat
  };
}

/**
 * Fold the criteria ledger into the workspace verification status. A required
 * criterion that is MISSING, PARTIAL or UNVERIFIED means the task is not
 * verified even when the workspace checks found nothing wrong; a claim the
 * account makes that no receipt supports means the same; a contradiction found
 * by the workspace checks is never softened by a satisfied ledger.
 */
function deriveVerificationStatus(
  workspace: VerificationStatus,
  ledger: readonly ReceiptEntry[],
  claimLedger: readonly ReceiptEntry[],
  evidenceAvailable: boolean,
): VerificationStatus {
  if (workspace.status === "not_applicable" || workspace.status === "unavailable" || workspace.status === "contradicted") {
    return workspace;
  }
  const unmet = ledger.filter((entry) => entry.status !== "PROVED");
  const unsupportedClaims = evidenceAvailable ? claimLedger.filter((entry) => entry.status === "MISSING") : [];
  if (unmet.length === 0 && unsupportedClaims.length === 0) return workspace;
  const reasons = [...workspace.reasons];
  if (unmet.length > 0) reasons.push(`required criteria without sufficient evidence: ${unmet.map((e) => `${e.ref} (${e.status})`).join(", ")}`);
  if (unsupportedClaims.length > 0) reasons.push(`claims in the account without a receipt: ${unsupportedClaims.map((e) => e.ref).join(", ")}`);
  return {
    ...workspace,
    status: workspace.status === "verified" ? "unverified" : workspace.status,
    reasons,
  };
}
