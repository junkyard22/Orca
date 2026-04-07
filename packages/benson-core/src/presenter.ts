import type { ExecutionResult, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Tone rules:
//   - Calm, concise, professional "butler" vibe.
//   - No emojis. No internal system talk. No component names.
//   - FAIL: brief apology + one next-step question.
//   - followUpQuestion: surface it via cleanFollowUp() — always sanitized.
// ---------------------------------------------------------------------------

/**
 * Strip internal pipeline markup and agent planning monologue from text
 * before showing it to the user. The user should only see the deliverable —
 * code, answer, or result — not the agent's thinking process.
 *
 * Stripping order:
 *   1. <tool_call>, <thought>, <thinking>, <scratchpad> XML blocks
 *   2. FINAL ANSWER: marker — extract ONLY what follows it, discarding all
 *      thinking that appears before it (Thought/Observation/Next blocks etc.)
 *   3. Fallback when no FINAL ANSWER: marker — if a code block exists, keep
 *      only that region; otherwise strip leading preamble lines.
 *   4. Strip any internal-monologue lines that slipped through.
 *   5. Collapse excess blank lines
 *
 * Trust boundary: this function is the last line of defence before content
 * reaches the user. It must NEVER pass internal-role chatter, reasoning
 * prefixes, or scratchpad text to the caller.
 */
function cleanOutput(text: string): string {
  // 1. Strip XML markup blocks — closed and unclosed tail variants.
  //    Covers <tool_call>, <thought>, <thinking>, <scratchpad>, <analysis>,
  //    <reasoning> and their unclosed variants that trail off.
  let out = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<thought>[\s\S]*/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*/gi, "")
    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "")
    .replace(/<scratchpad>[\s\S]*/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

  // 2. FINAL ANSWER: is the primary thinking/deliverable boundary.
  //    Extract everything AFTER the marker — everything before it is thinking.
  const FA_RE = /^FINAL ANSWER:\s*/im;
  const faIdx = out.search(FA_RE);
  if (faIdx !== -1) {
    const faMatch = out.match(FA_RE)!;
    out = out.slice(faIdx + faMatch[0].length);
  } else {
    // 3. No FINAL ANSWER: marker — if a code block exists, keep only that region.
    const codeBlockIdx = out.indexOf("```");
    if (codeBlockIdx > 0) {
      const afterFirst = out.slice(codeBlockIdx);
      const lastFenceIdx = afterFirst.lastIndexOf("```");
      out = lastFenceIdx > 0
        ? afterFirst.slice(0, lastFenceIdx + 3).trimEnd()
        : afterFirst;
    } else {
      // 4. Plain text — strip leading preamble sentences line by line.
      const PREAMBLE = /^(#{1,3}\s|step\s+\d|let'?s\s+(proceed|start|begin|take|do)|i\s+will\s|i'll\s|let\s+me\s|first[,\s]|now[,\s])/i;
      const lines = out.split("\n");
      let start = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim() === "" || PREAMBLE.test(lines[i]!.trim())) {
          start = i + 1;
        } else {
          break;
        }
      }
      out = lines.slice(start).join("\n");
    }
  }

  // 5a. Strip internal-monologue label lines (Thought:, Observation:, etc.)
  out = out.replace(/^(Thought|Observation|Next|Thinking|Reasoning|Analysis|Scratchpad|Internal note|Chain of thought):\s.*$/gmi, "");

  // 5b. Strip role-prefixed handoff lines that are not meant for the user.
  //     Matches lines like "Brain: let me route this" or "Reviewer: the code has issues".
  //     Only strips lines where the role label is at the very start of the line,
  //     so it doesn't catch legitimate inline text that happens to use these words.
  out = out.replace(/^(Brain|Reviewer|Narrator|Planner|Utility|Debugger|Reader|Vision|Subagent):\s.*/gmi, "");

  // 5c. Strip whole lines that are pure internal-thought openers.
  //     These are conservative — only strip if the *entire line* matches a
  //     known leakage pattern, so we don't accidentally cut real content.
  out = out.replace(/^(thinking\.\.\.|let me (think|check|look|see|read|verify|review|examine|analyze|inspect|investigate|find|determine|try).*|i need to .*|i('ll| will) need to .*|first[,.]?\s*i('ll| will)\s+.*|internal note:.*|scratchpad:.*|reasoning:.*|analysis:.*)$/gmi, "");

  // 5c2. Strip "I need to:" planning blocks — a colon-terminated opener followed
  //      by a numbered or bulleted list is always an internal plan, never output.
  out = out.replace(/^[Ii] need to:?\s*\n((?:\s*[\d\-\*•]+\.?\s+.+\n?)*)/gm, "");

  // 5e. Strip inline "Let me [cognitive-verb]..." and "Now let me [verb]..."
  //     sentences that narrate the agent's thinking process mid-response.
  //     Only targets verbs that are unambiguously internal-process narration.
  //     "Let me know" is intentionally excluded — it is user-facing language.
  out = out.replace(/\.?\s*(Now\s+)?[Ll]et me (?:also\s+|just\s+|quickly\s+|then\s+|now\s+|go ahead and\s+)?(think|check|look|see|read|search|verify|review|examine|analyze|inspect|investigate|find|determine|try)\b[^.!?\n]*[.!?]?/gi, "");

  // 5f. Remove immediately-repeated text blocks — the model sometimes echoes its
  //     own prior turn when given conversation context, producing "X...X" output.
  //     Matches any 30+ char string that appears twice in immediate succession.
  out = out.replace(/(.{30,})\1/g, "$1");

  // 5d. Strip internal pipeline metadata fragments.
  //     Covers Pappy verdict tallies, run_id tokens, and Dewey block markers.
  //     These are structural artifacts of the runtime, not user-facing content.
  //     Pattern ^dewey_[a-z_]*blocked matches: dewey_blocked, dewey_review_blocked, etc.
  out = out.replace(/\bverdict=(PASS|WARN|FAIL)\b[^\n]*/gi, "");
  out = out.replace(/\b\d+x(CRITICAL|HIGH|MEDIUM|LOW)\b/gi, "");
  out = out.replace(/\brun_id=\S+/gi, "");
  out = out.replace(/^dewey_[a-z_]*blocked\b.*/gmi, "");

  // 6. Collapse excess blank lines
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Lighter sanitization for follow-up questions (clarifying questions the
 * executor surfaces back to the user).  We apply all markup and label
 * stripping from cleanOutput() but intentionally skip the destructive
 * FINAL ANSWER extraction and code-block extraction steps — those heuristics
 * assume an agent's full response, not a short clarifying question, and would
 * incorrectly destroy legitimate content like "I'll need the API key first."
 *
 * Trust boundary: closes the bypass where followUpQuestion could carry
 * <thinking> blocks, role-prefixed lines, or reasoning labels to the user.
 */
function cleanFollowUp(text: string): string {
  // Step 1: strip XML internal blocks (same as cleanOutput step 1)
  let out = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<thought>[\s\S]*/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*/gi, "")
    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "")
    .replace(/<scratchpad>[\s\S]*/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

  // Step 5a: strip internal-monologue label lines (same as cleanOutput step 5a)
  out = out.replace(/^(Thought|Observation|Next|Thinking|Reasoning|Analysis|Scratchpad|Internal note|Chain of thought):\s.*$/gmi, "");

  // Step 5b: strip role-prefixed handoff lines (same as cleanOutput step 5b)
  out = out.replace(/^(Brain|Reviewer|Narrator|Planner|Utility|Debugger|Reader|Vision|Subagent):\s.*/gmi, "");

  // Step 5c: strip whole-line internal-thought openers (same as cleanOutput step 5c)
  out = out.replace(/^(thinking\.\.\.|let me (think|check|look|see|read|verify|review|examine|analyze|inspect|investigate|find|determine|try).*|i need to (think|figure|work|check|analyze|determine).*|first[,.]?\s*i('ll| will)\s+.*|internal note:.*|scratchpad:.*|reasoning:.*|analysis:.*)$/gmi, "");

  // Step 5e: strip inline "Let me / Now let me [cognitive-verb]..." sentences (same as cleanOutput step 5e)
  out = out.replace(/\.?\s*(Now\s+)?[Ll]et me (?:also\s+|just\s+|quickly\s+|then\s+|now\s+|go ahead and\s+)?(think|check|look|see|read|search|verify|review|examine|analyze|inspect|investigate|find|determine|try)\b[^.!?\n]*[.!?]?/gi, "");

  // Step 5f: remove immediately-repeated text blocks (same as cleanOutput step 5f)
  out = out.replace(/(.{30,})\1/g, "$1");

  // Step 5d: strip internal pipeline metadata that should never reach the user.
  //   Covers Pappy verdict tallies ("verdict=FAIL 2xHIGH"), run identifiers
  //   ("run_id=run_123_abc"), and Dewey block markers ("dewey_blocked ...",
  //   "dewey_review_blocked", and similar). Pattern ^dewey_[a-z_]*blocked covers
  //   all current and future dewey_*blocked naming variants.
  out = out.replace(/\bverdict=(PASS|WARN|FAIL)\b[^\n]*/gi, "");
  out = out.replace(/\b\d+x(CRITICAL|HIGH|MEDIUM|LOW)\b/gi, "");
  out = out.replace(/\brun_id=\S+/gi, "");
  out = out.replace(/^dewey_[a-z_]*blocked\b.*/gmi, "");

  // Step 6: collapse blank lines
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function presentResult(result: ExecutionResult, task: TaskSpec): string {
  // followUpQuestion takes precedence — the executor needs more info.
  // Always sanitized: the executor may have accidentally included internal
  // markup in the question text.
  if (result.followUpQuestion) {
    return cleanFollowUp(result.followUpQuestion);
  }

  if (result.status === "SUCCESS") {
    return presentSuccess(result, task);
  }

  if (result.status === "WARN") {
    return presentWarn(result, task);
  }

  return presentFailure(result, task);
}

function presentSuccess(result: ExecutionResult, task: TaskSpec): string {
  // Prefer an explicit user-facing message from the executor
  if (result.userFacingText) {
    return cleanOutput(result.userFacingText);
  }

  // Construct a concise confirmation from the task goals
  const summary = task.goals.length === 1
    ? task.goals[0]
    : task.goals.map((g, i) => `${i + 1}. ${g}`).join("\n");

  return `Done. Here is what was completed:\n\n${summary}`;
}

function presentWarn(result: ExecutionResult, task: TaskSpec): string {
  // Budget cap or soft-stop — show whatever output exists, with a clear note.
  const budgetNote = result.summary ?? "Spending limit reached.";
  if (result.userFacingText) {
    return `${cleanOutput(result.userFacingText)}\n\n---\n*Note: ${budgetNote}*`;
  }
  return `Completed with a warning.\n\n> ${budgetNote}`;
}

function presentFailure(result: ExecutionResult, task: TaskSpec): string {
  // If there IS output, show it — the LLM did produce something even if QC
  // flagged issues. Append the next-step question below so the user can act.
  if (result.userFacingText) {
    const nextStep = chooseNextStepQuestion(task);
    return `${cleanOutput(result.userFacingText)}\n\n---\n*QC noted some issues with the above. ${nextStep}*`;
  }

  // Surface the internal error/summary so the user can diagnose the problem
  // (e.g. "API error 401: invalid key", "Brain role not configured", etc.)
  // Trust boundary: apply cleanFollowUp() before surfacing — the summary can
  // carry agent error messages (metadata.errorMessage) that may contain role
  // prefixes or XML markup if the model included them in an error response.
  if (result.summary && !result.summary.startsWith("ok")) {
    const nextStep = chooseNextStepQuestion(task);
    return `That did not complete as expected.\n\n> ${cleanFollowUp(result.summary)}\n\n${nextStep}`;
  }

  // Truly empty output — nothing to show
  const nextStep = chooseNextStepQuestion(task);
  return `That did not complete as expected. ${nextStep}`;
}

function chooseNextStepQuestion(task: TaskSpec): string {
  const intent = task.intent.toLowerCase();

  if (/\b(creat|build|generat|writ)\w*/.test(intent)) {
    return "Would you like me to try a different approach, or adjust the requirements first?";
  }
  if (/\b(fix|repair|resolv|debug)\w*/.test(intent)) {
    return "Would you like me to investigate further, or would you prefer to describe the issue differently?";
  }
  if (/\b(updat|modif|chang|edit)\w*/.test(intent)) {
    return "Would you like to clarify what should change, or would a fresh attempt help?";
  }

  return "How would you like to proceed — retry, adjust the approach, or start over?";
}
