/**
 * Pappy AHP Verifier — evaluateAHPPacket()
 *
 * Pappy is the receipt checker at the exit door.  For AHP packets she checks:
 *   1. VIOLATION guard  — if Miranda already flagged a constraint breach,
 *      force lifecycle → FAILED and do not run AC evaluation.
 *   2. INCONCLUSIVE guard — incomplete trace (no worker entry) OR empty output.
 *   3. Schema check — lightweight key-presence check against expectedOutput.schema.
 *   4. Acceptance Criteria — each AC string is evaluated against the actual output.
 *   5. Verdict mapped to AHPVerdict (PASS / WARN / FAIL / INCONCLUSIVE).
 *   6. Trace entry appended with actor = "pappy" and a per-AC summary.
 *
 * The packet is mutated in place and returned (same reference).
 * Callers that need an immutable copy must clone before calling.
 */

import type { AHPPacket, AHPEvalMeta } from "@clawde/miranda-core";
import { AHPLifecycle, AHPVerdict, appendAHPTrace } from "@clawde/miranda-core";
import { transitionAHPLifecycle } from "@clawde/miranda-core";
import {
  classifyTaskType,
  deriveDefaultACs,
  mergeAcceptanceCriteria,
  getACPriority,
} from "./taskClassifier.js";
import { verifyFileChanges } from "./fileVerifier.js";
import { buildAHPRepairPrompt } from "./repairPrompt.js";

// ---------------------------------------------------------------------------
// Input shape — only the fields Pappy needs from the execution result
// ---------------------------------------------------------------------------

export interface AHPVerificationInput {
  /** Agent's final text output. */
  outputText?: string;
  /** Files written/modified during execution. */
  filesChanged?: Array<{
    path: string;
    diff?: string;
    /** Add/Modify/Delete — sourced from OrcaFileChange.changeType. */
    changeType?: "A" | "M" | "D";
  }>;
  /**
   * Absolute path to the workspace root.  When provided Pappy can perform
   * disk-based file verification (existence + content reads) in addition to
   * checking the in-memory filesChanged list.
   */
  workspaceRoot?: string;
}

// ---------------------------------------------------------------------------
// AC evaluation — lightweight heuristic keyword check
// ---------------------------------------------------------------------------

/**
 * Returns true if the actual output provides evidence that satisfies the
 * acceptance criterion text.
 *
 * Strategy:
 *   - Extract significant words from the AC (≥4 chars, not stop-words).
 *   - Consider the AC proved if ANY of those words appear in the search corpus
 *     (outputText + file diffs), OR if outputText is non-empty and the AC is
 *     generic (no distinctive keyword found).
 *
 * This intentionally favours recall over precision — a WARN is preferable to
 * a false FAIL on a vague AC.  Poorly-specified ACs will surface as
 * INCONCLUSIVE via the scheme check path instead.
 */
function checkACAgainstOutput(
  acText: string,
  input: AHPVerificationInput,
): { passed: boolean; evidence: string } {
  const outputText = input.outputText ?? "";
  const diffText   = (input.filesChanged ?? []).map((f) => f.diff ?? "").join("\n");
  const corpus     = `${outputText} ${diffText}`.toLowerCase();

  if (!corpus.trim()) {
    return { passed: false, evidence: "no output" };
  }

  // tool_event requirement: AC asserts a specific tool was called (Brain done_criteria pattern).
  // Keyword matching on outputText is insufficient — the model often MENTIONS the tool name
  // without actually calling it. Require the file to appear in filesChanged instead.
  if (/tool_event/i.test(acText)) {
    const filePathMatch =
      acText.match(/creating\s+([\w.\-\/]+)/i) ??
      acText.match(/\b([\w.\-]+\.[\w]{1,6})\b/);
    const p = filePathMatch?.[1] ?? "";
    const touched = (input.filesChanged ?? []).map((f) => f.path);
    if (p) {
      if (touched.some((t) => t.endsWith(p) || t === p)) {
        return { passed: true, evidence: `file present: ${p}` };
      }
      return { passed: false, evidence: `tool_event AC: file not created: ${p}` };
    }
    // No specific file — require at least one file change
    if (touched.length > 0) {
      return { passed: true, evidence: "files were changed" };
    }
    return { passed: false, evidence: "tool_event AC: no files changed" };
  }

  // File-path requirement: `File "x" must be ...`
  const fileReq = acText.match(/[Ff]ile ["`']?([^"`'\s,]+)["`']?/);
  if (fileReq) {
    const p = fileReq[1] ?? "";
    const touched = (input.filesChanged ?? []).map((f) => f.path);
    if (touched.some((t) => t.endsWith(p) || t === p)) {
      return { passed: true, evidence: `file present: ${p}` };
    }
    if (outputText.toLowerCase().includes(p.toLowerCase())) {
      return { passed: true, evidence: `file referenced in output: ${p}` };
    }
    return { passed: false, evidence: `file not found: ${p}` };
  }

  // Extract significant keywords (≥4 chars; skip common stop words)
  const STOP_WORDS = new Set([
    "must", "should", "each", "that", "with", "from", "have", "been",
    "will", "when", "then", "this", "there", "their", "than", "into",
    "also", "some", "more", "such", "they", "what", "were", "your",
    "does",
  ]);

  const keywords = acText
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  if (keywords.length === 0) {
    // Generic/empty AC — prove with non-empty output
    return outputText.trim().length > 0
      ? { passed: true, evidence: "output is non-empty" }
      : { passed: false, evidence: "output is empty" };
  }

  const matchedKeywords = keywords.filter((kw) => corpus.includes(kw));
  // Require at least half the keywords to match (min 1)
  const threshold = Math.max(1, Math.ceil(keywords.length / 2));
  if (matchedKeywords.length >= threshold) {
    return {
      passed: true,
      evidence: `keywords matched: ${matchedKeywords.slice(0, 3).join(", ")}`,
    };
  }

  // Fallback: non-empty output satisfies a vague AC
  if (outputText.trim().length > 0 && keywords.length <= 2) {
    return { passed: true, evidence: "output is non-empty (vague AC)" };
  }

  return {
    passed: false,
    evidence: matchedKeywords.length > 0
      ? `partial match (${matchedKeywords.length}/${keywords.length} keywords)`
      : "no matching keywords found",
  };
}

// ---------------------------------------------------------------------------
// Schema check — lightweight key-presence check
// ---------------------------------------------------------------------------

/**
 * Returns true if every top-level key in `schema` appears somewhere in the
 * output corpus.  An empty schema always returns true (no constraint).
 */
function checkSchemaAgainstOutput(
  schema: Record<string, unknown>,
  input: AHPVerificationInput,
): { passed: boolean; missingKeys: string[] } {
  const keys = Object.keys(schema);
  if (keys.length === 0) return { passed: true, missingKeys: [] };

  const outputText = input.outputText ?? "";
  const diffText   = (input.filesChanged ?? []).map((f) => f.diff ?? "").join("\n");
  const corpus     = `${outputText} ${diffText}`.toLowerCase();

  const missingKeys = keys.filter((k) => !corpus.includes(k.toLowerCase()));
  return { passed: missingKeys.length === 0, missingKeys };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Verify an AHPPacket against the actual execution output.
 *
 * Mutates `packet` in place (verdict + trace + meta.updatedAt) and returns it.
 * Callers that need an immutable result must clone before calling.
 *
 * @param packet - The AHPPacket threaded through the Maestro pipeline.
 *                 Expected lifecycle: RUNNING, COMPLETE, or FAILED.
 * @param input  - Execution output for evaluation.
 * @returns The same packet reference, now with verdict and trace updated.
 */
export function verifyAHPPacket(
  packet: AHPPacket,
  input: AHPVerificationInput,
): AHPPacket {
  const now = new Date().toISOString();

  // ── Step 1: VIOLATION guard ────────────────────────────────────────────────
  // Miranda already set verdict = VIOLATION via onViolation callback.
  // Transition lifecycle to FAILED when the state machine permits it.
  // Terminal states (COMPLETE) and illegal-source states are NOT rewritten —
  // Pappy does not casually mutate finalized lifecycles. Instead we append a
  // protocol-anomaly trace entry so the orchestrator can reconcile.
  if (packet.verdict === AHPVerdict.VIOLATION) {
    if (packet.lifecycle === AHPLifecycle.FAILED) {
      appendAHPTrace(packet, {
        timestamp: now,
        state: AHPLifecycle.FAILED,
        actor: "pappy",
        note: "Verification skipped — VIOLATION verdict; lifecycle already FAILED",
      });
    } else if (packet.lifecycle === AHPLifecycle.COMPLETE) {
      appendAHPTrace(packet, {
        timestamp: now,
        state: packet.lifecycle,
        actor: "pappy",
        note: "ANOMALY: VIOLATION verdict on COMPLETE packet — terminal lifecycle preserved, not rewritten",
      });
    } else {
      try {
        transitionAHPLifecycle(packet.lifecycle, AHPLifecycle.FAILED);
        packet.lifecycle = AHPLifecycle.FAILED;
        appendAHPTrace(packet, {
          timestamp: now,
          state: AHPLifecycle.FAILED,
          actor: "pappy",
          note: "Verification skipped — VIOLATION verdict set by Miranda; lifecycle transitioned to FAILED",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendAHPTrace(packet, {
          timestamp: now,
          state: packet.lifecycle,
          actor: "pappy",
          note: `ANOMALY: VIOLATION verdict from lifecycle=${packet.lifecycle} — ${msg}; lifecycle preserved`,
        });
      }
    }
    packet.meta.updatedAt = now;
    return packet;
  }

  // ── Step 2: INCONCLUSIVE guard ─────────────────────────────────────────────
  // Incomplete trace: no worker role entry. Brain can be a real worker in the
  // direct desktop path, so an "Agent stopped" trace entry also counts.
  const INFRASTRUCTURE_ACTORS = new Set(["brain", "miranda", "pappy"]);
  const hasWorkerEntry =
    packet.trace.some((e) => !INFRASTRUCTURE_ACTORS.has(e.actor)) ||
    packet.trace.some((e) => /\bAgent stopped:/i.test(e.note ?? ""));
  const outputText     = input.outputText ?? "";
  const hasOutput      = outputText.trim().length > 0;

  if (!hasWorkerEntry || !hasOutput) {
    packet.verdict = AHPVerdict.INCONCLUSIVE;
    appendAHPTrace(packet, {
      timestamp: now,
      state: packet.lifecycle,
      actor: "pappy",
      note: !hasWorkerEntry
        ? "INCONCLUSIVE: no worker role trace entry — expectedOutput definitions may need refinement"
        : "INCONCLUSIVE: output is empty — expectedOutput definitions may need refinement",
    });
    packet.meta.updatedAt = now;
    return packet;
  }

  // ── Step 3: Schema check ───────────────────────────────────────────────────
  const { passed: schemaPassed, missingKeys } = checkSchemaAgainstOutput(
    packet.expectedOutput.schema,
    input,
  );

  // ── Step 3b: Derive and merge task-aware ACs ────────────────────────────────
  const taskType   = classifyTaskType(packet);
  const derived    = deriveDefaultACs(taskType);
  const effectiveACs = mergeAcceptanceCriteria(
    packet.expectedOutput.acceptanceCriteria,
    derived,
  );

  // Store structured classification metadata on the packet.  Consumers inspect
  // these typed fields instead of parsing trace note strings.
  const evalMeta: AHPEvalMeta = {
    taskType,
    derivedAcceptanceCriteria: derived,
    mergedAcceptanceCriteria:  effectiveACs,
  };
  packet.evalMeta = evalMeta;

  // ── Step 3c: File change verification for FileWrite / CodeEdit tasks ───────────
  // Returns precise, disk-backed check results that override the keyword heuristic
  // for the matching default ACs.
  const fileOverrides = verifyFileChanges(packet, input, taskType);
  // ── Step 4: Acceptance Criteria evaluation ─────────────────────────────────
  const acResults = effectiveACs.map((ac, i) => {
    // Use file-verification override when available — it provides stronger
    // evidence than the generic keyword heuristic.
    const overrideKey = ac.toLowerCase().trim();
    if (fileOverrides.has(overrideKey)) {
      const ov = fileOverrides.get(overrideKey)!;
      return { id: `PAC${i + 1}`, ac, passed: ov.passed, evidence: ov.evidence };
    }
    const { passed, evidence } = checkACAgainstOutput(ac, input);
    return { id: `PAC${i + 1}`, ac, passed, evidence };
  });

  const passed = acResults.filter((r) => r.passed);
  const failed = acResults.filter((r) => !r.passed);

  // ── Step 5: Derive AHP verdict ─────────────────────────────────────────────
  let verdict: AHPVerdict;
  if (!schemaPassed) {
    verdict = AHPVerdict.FAIL;
  } else if (failed.length === 0 && acResults.length > 0) {
    verdict = AHPVerdict.PASS;
  } else if (acResults.length === 0) {
    // No ACs defined — non-empty output is sufficient for PASS
    verdict = AHPVerdict.PASS;
  } else if (passed.length > 0 && failed.length > 0) {
    verdict = AHPVerdict.WARN;
  } else {
    // All ACs failed.  If every failure is a soft (stylistic) criterion, downgrade
    // to WARN — soft-only failures should not drive a hard FAIL verdict.
    verdict = failed.every((r) => getACPriority(r.ac) === "soft")
      ? AHPVerdict.WARN
      : AHPVerdict.FAIL;
  }

  packet.verdict = verdict;

  // ── Step 5b: Generate targeted repair prompt for WARN / FAIL ────────────────
  if (verdict === AHPVerdict.WARN || verdict === AHPVerdict.FAIL) {
    packet.repairPrompt = buildAHPRepairPrompt(
      packet,
      failed,
      { passed: schemaPassed, missingKeys },
    );
  }

  // ── Step 6: Build trace note ───────────────────────────────────────────────
  const noteParts: string[] = [`verdict=${verdict}`, `taskType=${taskType}`];
  if (passed.length > 0) {
    noteParts.push(`PASS: ${passed.map((r) => r.id).join(", ")}`);
  }
  if (failed.length > 0) {
    noteParts.push(`FAIL: ${failed.map((r) => `${r.id}(${r.evidence})`).join(", ")}`);
  }
  if (!schemaPassed && missingKeys.length > 0) {
    noteParts.push(`schema missing keys: ${missingKeys.join(", ")}`);
  }

  appendAHPTrace(packet, {
    timestamp: now,
    state: packet.lifecycle,
    actor: "pappy",
    note: noteParts.join("; "),
  });
  packet.meta.updatedAt = now;

  return packet;
}
