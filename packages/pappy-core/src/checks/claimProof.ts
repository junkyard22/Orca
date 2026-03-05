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
 * action claims but there is no trace at all, issue a MED instrumentation
 * warning so the repair asks for a re-run with logging enabled.
 */

import type { Issue, PappyInput, Claim, ReceiptEntry, ReceiptType } from "../types.js";

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
          f.path === filePath ||
          f.path.endsWith(filePath) ||
          filePath.endsWith(f.path),
      );
      if (!hit) return null;
      return `filesChanged: ${hit.path} changeType=${hit.changeType}${hit.diff ? ` (+diff)` : ""}`;
    },
    receiptDetails(match) {
      return `diff or filesChanged entry for "${match[1] ?? "file"}"`;
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
          (f.path === filePath || f.path.endsWith(filePath) || filePath.endsWith(f.path)),
      );
      if (!hit) return null;
      return `filesChanged: ${hit.path} changeType=${hit.changeType}`;
    },
    receiptDetails(match) {
      return `filesChanged entry (changeType=A) for "${match[1] ?? "file"}"`;
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
          /test|jest|vitest|mocha|pytest|cargo\s+test|go\s+test/i.test(e.tool + " " + e.summary),
      );
      if (!testEvent) return null;
      return `toolEvent: tool=${testEvent.tool} ok=true summary="${testEvent.summary}"`;
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
      const cmd = (match[1] ?? "").toLowerCase().trim();
      const event = (input.toolEvents ?? []).find((e) =>
        e.summary.toLowerCase().includes(cmd.split(/\s+/)[0] ?? cmd),
      );
      if (!event) return null;
      return `toolEvent: tool=${event.tool} ok=${event.ok} summary="${event.summary}"`;
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
  {
    pattern: /\b(?:based\s+on\s+(?:source|research)|i\s+verified|i\s+confirmed|according\s+to)\b/gi,
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
  const claims: Claim[] = [];
  let claimIndex = 0;

  for (const def of CLAIM_PATTERNS) {
    const regex = new RegExp(def.pattern.source, def.pattern.flags);
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(outputText)) !== null) {
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

  const outputText = input.outputText ?? "";
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
        status: proofPointer ? "PROVED" : hasAnyTrace ? "MISSING" : "MISSING",
        evidence: proofPointer ? [proofPointer] : [],
      };
      ledger.push(entry);

      if (!proofPointer) {
        issues.push({
          severity: hasAnyTrace ? "HIGH" : "MEDIUM",
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
  // Skip for pure code-gen output that contains no claims (no toolEvents expected).
  if (!hasAnyTrace && outputText.length > 0 && claims.length > 0) {
    issues.push({
      severity: "MEDIUM",
      code: "PROOF_NO_TRACE",
      category: "Proof",
      description: "No tool events or file changes were provided. Claims cannot be objectively verified.",
      expected_receipt: "toolEvents and/or filesChanged populated by the runtime.",
      evidence: "toolEvents=[] filesChanged=[]",
      fix_hint: "Re-run with instrumentation enabled so Pappy can verify receipts.",
      message: "No run trace available — verification is impossible.",
      suggestedFix: "Enable tool/event logging and re-run.",
    });
  }

  return { issues, ledger, claims };
}
