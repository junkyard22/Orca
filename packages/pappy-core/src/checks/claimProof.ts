/**
 * Claim-to-Proof Verification — Pappy's core check.
 *
 * "Show me the receipt."
 *
 * Extracts claims from the assistant's output text, then verifies each
 * claim against the available trace (toolEvents, filesChanged).
 * Claims with no matching evidence become PROOF issues.
 *
 * Also handles the "NO-TOOLS" environment case: if the output makes
 * action claims but there is no trace at all, keep the no-trace warning
 * and fail the unverified claim so the task is sent back for repair.
 */

import type { Issue, PappyInput, Claim, ReceiptEntry, ReceiptType } from "../types.js";

function pathMatches(candidate: string, expected: string): boolean {
  return candidate === expected || candidate.endsWith(expected) || expected.endsWith(candidate);
}

function extractToolPath(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const candidate = record["path"] ?? record["filePath"];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function extractToolCommand(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const candidate = record["command"];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function extractToolOutput(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const candidate = record["_outputForProof"] ?? record["output"] ?? record["stdout"];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, " ")
    .replace(/[^\w./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeToolEvidence(raw: unknown): string {
  const command = extractToolCommand(raw);
  const output = extractToolOutput(raw);
  const outputPreview = output ? output.slice(0, 120) : null;
  return [command ? `command="${command}"` : null, outputPreview ? `output="${outputPreview}"` : null]
    .filter(Boolean)
    .join(" ");
}

function getExecutionEvents(input: PappyInput) {
  return (input.toolEvents ?? []).filter((entry) => {
    if (!entry.ok) return false;
    return Boolean(extractToolCommand(entry.raw) || extractToolOutput(entry.raw) || /run_command|start_process|execute/i.test(entry.tool));
  });
}

function extractQuotedPhrases(text: string): string[] {
  const phrases: string[] = [];
  const regex = /[`"']([^`"'\n]{2,120})[`"']/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const phrase = match[1]?.trim();
    if (phrase) phrases.push(phrase);
  }

  return phrases;
}

function stripMachineIssueLines(outputText: string): string {
  return outputText
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:PROOF|TOOL|COMPLETENESS|CONSISTENCY|SATISFACTION|ROUTING|CORE)_[A-Z_]+:/.test(line))
    .join("\n");
}

function findSuccessfulFileToolEvent(
  input: PappyInput,
  filePath: string,
  tools: string[],
): string | null {
  const event = (input.toolEvents ?? []).find((entry) => {
    if (!entry.ok || !tools.includes(entry.tool)) return false;
    const eventPath = extractToolPath(entry.raw);
    return eventPath ? pathMatches(eventPath, filePath) : false;
  });

  if (!event) return null;

  const eventPath = extractToolPath(event.raw);
  return `toolEvent: tool=${event.tool} ok=true path="${eventPath ?? filePath}"`;
}

// ---------------------------------------------------------------------------
// Claim pattern definitions
// ---------------------------------------------------------------------------

interface ClaimPattern {
  /** Regex to detect the claim in outputText */
  pattern: RegExp;
  /** Human label for the claim type */
  label: string;
  /** Receipt type required to prove this claim */
  receiptType: ReceiptType;
  /**
   * Given the match and input, return the evidence pointer if proof exists,
   * or null if proof is missing.
   */
  findProof(match: RegExpMatchArray, input: PappyInput): string | null;
  /** Build the "required receipt" details string */
  receiptDetails(match: RegExpMatchArray): string;
}

function isForwardLookingActionContext(contextBefore: string): boolean {
  return /\b(i'?ll|will|let me|i'?m going to|need to|i would|i'?d|going to|plan to)\s*$/i.test(contextBefore);
}

function isNegatedActionContext(contextBefore: string): boolean {
  return /\b(did\s+not|didn't|do\s+not|don't|does\s+not|doesn't|were\s+not|was\s+not|wasn't|not|never|no)\s*$/i.test(contextBefore);
}

const COMMAND_CLAIM_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "displayed",
  "exact",
  "exactly",
  "expected",
  "executed",
  "invoked",
  "it",
  "output",
  "printed",
  "produced",
  "ran",
  "returned",
  "script",
  "showed",
  "successfully",
  "the",
  "which",
]);

function findProofForCommandExecutionClaim(match: RegExpMatchArray, input: PappyInput): string | null {
  const claimText = (match[1] ?? "").trim();
  const normalizedClaim = normalizeForMatch(claimText);
  const quotedPhrases = extractQuotedPhrases(claimText).map(normalizeForMatch).filter(Boolean);
  const events = getExecutionEvents(input);

  for (const event of events) {
    const haystack = normalizeForMatch(
      [event.summary, extractToolCommand(event.raw) ?? "", extractToolOutput(event.raw) ?? ""].join(" "),
    );
    if (quotedPhrases.some((phrase) => haystack.includes(phrase))) {
      const evidence = summarizeToolEvidence(event.raw);
      return evidence
        ? `toolEvent: tool=${event.tool} ok=true ${evidence}`
        : `toolEvent: tool=${event.tool} ok=true summary="${event.summary}"`;
    }
    if (normalizedClaim.length > 0 && haystack.includes(normalizedClaim)) {
      const evidence = summarizeToolEvidence(event.raw);
      return evidence
        ? `toolEvent: tool=${event.tool} ok=true ${evidence}`
        : `toolEvent: tool=${event.tool} ok=true summary="${event.summary}"`;
    }
  }

  const claimTokens = normalizedClaim
    .split(/\s+/)
    .map((token) => token.replace(/^\W+|\W+$/g, ""))
    .filter((token) => token.length >= 3 && !COMMAND_CLAIM_STOPWORDS.has(token));

  for (const event of events) {
    const haystack = normalizeForMatch(
      [event.summary, extractToolCommand(event.raw) ?? "", extractToolOutput(event.raw) ?? ""].join(" "),
    );
    const tokenMatches = claimTokens.filter((token) => haystack.includes(token));
    if (tokenMatches.length >= Math.min(2, claimTokens.length) && tokenMatches.length > 0) {
      const evidence = summarizeToolEvidence(event.raw);
      return evidence
        ? `toolEvent: tool=${event.tool} ok=true ${evidence}`
        : `toolEvent: tool=${event.tool} ok=true summary="${event.summary}"`;
    }
  }

  // When the claim is entirely composed of stopwords / meta-words (e.g.
  // "ran successfully and produced the expected output", or "ran the script
  // which produced the exact output:" where a newline cuts off the content),
  // there are no content tokens to match. Also handles single-token noise:
  // adverbs like "exactly", or regex-truncation fragments like "expec". Any
  // successful execution event is sufficient proof for such generic claims.
  if (claimTokens.length <= 1 && events.length > 0) {
    const event = events[0]!;
    const evidence = summarizeToolEvidence(event.raw);
    return evidence
      ? `toolEvent: tool=${event.tool} ok=true ${evidence}`
      : `toolEvent: tool=${event.tool} ok=true summary="${event.summary}"`;
  }

  if (events.length === 1 && /\b(?:script|command|program|app)\b/i.test(claimText)) {
    const event = events[0]!;
    const evidence = summarizeToolEvidence(event.raw);
    return evidence
      ? `toolEvent: tool=${event.tool} ok=true ${evidence}`
      : `toolEvent: tool=${event.tool} ok=true summary="${event.summary}"`;
  }

  return null;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  // "I updated/changed/modified/edited file X"
  {
    pattern: /\b(?:updated?|changed?|modified|edited?)\s+(?:file\s+)?[`"']?([\w./\\-]+\.\w+)[`"']?/gi,
    label: "file modification claim",
    receiptType: "diff",
    findProof(match, input) {
      const filePath = match[1] ?? "";
      const changed = input.filesChanged ?? [];
      const hit = changed.find(
        (f) =>
          pathMatches(f.path, filePath),
      );
      if (hit) {
        return `filesChanged: ${hit.path} changeType=${hit.changeType}${hit.diff ? ` (+diff)` : ""}`;
      }

      return findSuccessfulFileToolEvent(input, filePath, ["write_file", "modify_file", "create_file"]);
    },
    receiptDetails(match) {
      return `filesChanged entry or successful write_file/modify_file tool event for "${match[1] ?? "file"}"`;
    },
  },

  // "I created/added file X"
  {
    pattern: /\b(?:created?|added?)\s+(?:file\s+)?[`"']?([\w./\\-]+\.\w+)[`"']?/gi,
    label: "file creation claim",
    receiptType: "file_exists",
    findProof(match, input) {
      const filePath = match[1] ?? "";
      const changed = input.filesChanged ?? [];
      const hit = changed.find(
        (f) =>
          (f.changeType === "A" || f.changeType === "M") &&
          pathMatches(f.path, filePath),
      );
      if (hit) {
        return `filesChanged: ${hit.path} changeType=${hit.changeType}`;
      }

      return findSuccessfulFileToolEvent(input, filePath, ["write_file", "create_file"]);
    },
    receiptDetails(match) {
      return `filesChanged entry or successful write_file/create_file tool event for "${match[1] ?? "file"}"`;
    },
  },

  // "tests pass/passed", "all tests pass"
  {
    pattern: /\b(?:all\s+)?tests?\s+(?:pass(?:ed)?|are\s+(?:passing|green))\b/gi,
    label: "tests-pass claim",
    receiptType: "command_exit_0",
    findProof(_match, input) {
      const testEvent = (input.toolEvents ?? []).find(
        (e) =>
          e.ok &&
          /test|jest|vitest|mocha|pytest|cargo\s+test|go\s+test/i.test(
            `${e.tool} ${e.summary} ${extractToolCommand(e.raw) ?? ""}`,
          ),
      );
      if (!testEvent) return null;
      const command = extractToolCommand(testEvent.raw);
      return command
        ? `toolEvent: tool=${testEvent.tool} ok=true command="${command}"`
        : `toolEvent: tool=${testEvent.tool} ok=true summary="${testEvent.summary}"`;
    },
    receiptDetails() {
      return "run_command or tool_event for test runner with exit=0";
    },
  },

  // "I ran/executed command X" or "ran: X"
  {
    pattern: /\b(?:ran|executed?|invoked?|ran:)\s+[`"']?([^`"'\n]{3,60})[`"']?/gi,
    label: "command execution claim",
    receiptType: "tool_event",
    findProof(match, input) {
      return findProofForCommandExecutionClaim(match, input);
    },
    receiptDetails(match) {
      return `tool_event matching "${match[1] ?? "command"}"`;
    },
  },

  // "I searched for X" or "searched the repo/codebase"
  {
    pattern: /\b(?:searched?(?:\s+for|\s+the)?(?:\s+(?:repo|codebase|directory|files?|source))?)\b/gi,
    label: "search claim",
    receiptType: "tool_event",
    findProof(_match, input) {
      const event = (input.toolEvents ?? []).find((e) =>
        /search|grep|ripgrep|find|glob/i.test(e.tool + " " + e.summary),
      );
      if (!event) return null;
      return `toolEvent: tool=${event.tool} ok=${event.ok} summary="${event.summary}"`;
    },
    receiptDetails() {
      return "tool_event for search/grep/glob with results summary";
    },
  },

  // "based on sources" / "I verified / confirmed"
  // Note: "according to" is excluded when followed by task-internal references
  // (task/requirements/prompt/instructions/spec/description/your/this/above/below)
  // to avoid false positives on "According to the task requirements…"
  {
    pattern: /\b(?:based\s+on\s+(?:source|research)|i\s+verified|i\s+confirmed|according\s+to(?!\s+(?:the\s+)?(?:task|requirement|prompt|instruction|spec|description|your|this|our|above|below)))\b/gi,
    label: "source verification claim",
    receiptType: "citations",
    findProof(_match, input) {
      // Check for fetch/web tool events or URLs in the output
      const fetchEvent = (input.toolEvents ?? []).find((e) =>
        /fetch|http|web|browse|url/i.test(e.tool + " " + e.summary),
      );
      if (fetchEvent) {
        return `toolEvent: tool=${fetchEvent.tool} ok=${fetchEvent.ok}`;
      }
      // Check for citation-like patterns in outputText
      const urlPattern = /https?:\/\/[^\s)]+/g;
      const urls = input.outputText?.match(urlPattern) ?? [];
      if (urls.length > 0) {
        return `outputText contains URLs: ${urls.slice(0, 2).join(", ")}`;
      }
      return null;
    },
    receiptDetails() {
      return "tool_event for web fetch, or citation list with URL + excerpt";
    },
  },
];

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/** Extract all claims from the output text. */
export function extractClaims(outputText: string): Claim[] {
  const cleanedOutput = stripMachineIssueLines(outputText);
  const claims: Claim[] = [];
  let claimIndex = 0;

  for (const def of CLAIM_PATTERNS) {
    const regex = new RegExp(def.pattern.source, def.pattern.flags);
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(cleanedOutput)) !== null) {
      // Skip forward-looking / intent phrasing: "I'll modify X", "will update X", "Let me edit X".
      // These are plans, not accomplished actions — no receipt should be required.
      const matchStart = match.index ?? 0;
      const contextBefore = cleanedOutput.slice(Math.max(0, matchStart - 35), matchStart);
      if (isForwardLookingActionContext(contextBefore) || isNegatedActionContext(contextBefore)) {
        continue;
      }

      claimIndex++;
      claims.push({
        id: `C${claimIndex}`,
        text: match[0].trim(),
        requires_proof: true,
      });
    }
  }

  return claims;
}

/**
 * Check each extracted claim against the trace and produce issues, ledger entries,
 * and the extracted claims list (so callers don't need to run extractClaims separately).
 */
export function runClaimProofChecks(
  input: PappyInput,
): { issues: Omit<Issue, "issueId">[]; ledger: ReceiptEntry[]; claims: Claim[] } {
  const issues: Omit<Issue, "issueId">[] = [];
  const ledger: ReceiptEntry[] = [];
  const claims: Claim[] = [];

  const outputText = stripMachineIssueLines(input.outputText ?? "");
  const hasAnyTrace =
    (input.toolEvents?.length ?? 0) > 0 ||
    (input.filesChanged?.length ?? 0) > 0;

  let claimIndex = 0;

  for (const def of CLAIM_PATTERNS) {
    const regex = new RegExp(def.pattern.source, def.pattern.flags);
    let match: RegExpMatchArray | null;
    let patternMatched = false;

    while ((match = regex.exec(outputText)) !== null) {
      patternMatched = true;

      // Skip forward-looking / intent phrasing: "I'll modify X", "will update X", "Let me edit X".
      // These are plans, not accomplished actions — requiring a receipt for them is a false positive.
      const matchStart = match.index ?? 0;
      const contextBefore = outputText.slice(Math.max(0, matchStart - 35), matchStart);
      if (isForwardLookingActionContext(contextBefore) || isNegatedActionContext(contextBefore)) {
        continue;
      }

      claimIndex++;
      const claimId = `C${claimIndex}`;
      const claimText = match[0].trim();

      // Accumulate claims so callers don't need a separate extractClaims() pass
      claims.push({ id: claimId, text: claimText, requires_proof: true });

      const proofPointer = def.findProof(match, input);

      // Build ledger entry
      const entry: ReceiptEntry = {
        ref: claimId,
        required_receipt: {
          type: def.receiptType,
          details: def.receiptDetails(match),
        },
        status: proofPointer ? "PROVED" : "MISSING",
        evidence: proofPointer ? [proofPointer] : [],
      };
      ledger.push(entry);

      if (!proofPointer) {
        issues.push({
          severity: "HIGH",
          code: "PROOF_CLAIM_UNVERIFIED",
          category: "Proof",
          description: `Claim "${claimText}" has no supporting evidence in the trace.`,
          expected_receipt: def.receiptDetails(match),
          evidence: hasAnyTrace
            ? `outputText asserts "${claimText}" but no matching ${def.receiptType} found in trace.`
            : `outputText asserts "${claimText}" but no tool trace was provided at all.`,
          fix_hint: hasAnyTrace
            ? `Re-run with explicit ${def.receiptType} logging. Ensure the action actually occurs and is captured.`
            : `Re-run with tool/event logging enabled so receipts can be verified.`,
          message: `Unverified claim: "${claimText}"`,
          suggestedFix: `Provide ${def.receiptDetails(match)} as proof.`,
        });
      }
    }

    if (!patternMatched) {
      // No claim of this type made — nothing to check.
      void patternMatched;
    }
  }

  // If no trace at all AND the output made verifiable claims, add a warning.
  // Project audits are evidence products, so an audit result with no audit
  // receipts is a hard proof failure even when no action claim was extracted.
  const isAuditRun = input.metadata?.audit !== undefined;
  if (!hasAnyTrace && outputText.length > 0 && (claims.length > 0 || isAuditRun)) {
    issues.push({
      severity: isAuditRun ? "HIGH" : "MEDIUM",
      code: "PROOF_NO_TRACE",
      category: "Proof",
      description: "No tool events or file changes were provided. Claims or audit conclusions cannot be objectively verified.",
      expected_receipt: "toolEvents and/or filesChanged populated by the runtime.",
      evidence: "toolEvents=[] filesChanged=[]",
      fix_hint: "Re-run with instrumentation enabled so Pappy can verify receipts.",
      message: "No run trace available — verification is impossible.",
      suggestedFix: "Enable tool/event logging and re-run.",
    });
  }

  return { issues, ledger, claims };
}
