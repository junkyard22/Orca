import type { ExecutionResult, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Tone rules:
//   - Calm, concise, professional "butler" vibe.
//   - No emojis. No internal system talk. No component names.
//   - FAIL: brief apology + one next-step question.
//   - followUpQuestion: surface it directly.
// ---------------------------------------------------------------------------

/**
 * Strip internal pipeline markup and agent planning monologue from text
 * before showing it to the user. The user should only see the deliverable —
 * code, answer, or result — not the agent's thinking process.
 *
 * Stripping order:
 *   1. <tool_call> and <thought> blocks (closed and unclosed)
 *   2. "FINAL ANSWER:" prefix
 *   3. Planning monologue — if a code block exists, drop everything before it;
 *      otherwise strip lines that are pure agent preamble (###, Step N:, etc.)
 *   4. Collapse excess blank lines
 */
function cleanOutput(text: string): string {
  // 1. Strip markup blocks (closed first, then unclosed tail)
  let out = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*/g, "")
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/<thought>[\s\S]*/g, "")
    .replace(/^FINAL ANSWER:\s*/im, "");

  // 2. If there's a code block, keep only from the first opening fence to
  //    the last closing fence — drop the planning prefix AND any trailing prose.
  const codeBlockIdx = out.indexOf("```");
  if (codeBlockIdx > 0) {
    const afterFirst = out.slice(codeBlockIdx);
    // Find the last closing fence and drop anything after it
    const lastFenceIdx = afterFirst.lastIndexOf("```");
    out = lastFenceIdx > 0
      ? afterFirst.slice(0, lastFenceIdx + 3).trimEnd()
      : afterFirst;
  } else {
    // 3. No code block — strip pure preamble lines line-by-line.
    const PREAMBLE = /^(#{1,3}\s|step\s+\d|let'?s\s+(proceed|start|begin|take|do)|i\s+will\s|i'll\s|let\s+me\s|first[,\s]|now[,\s])/i;
    const lines = out.split("\n");
    // Find the first line that is actual content (not a heading or preamble sentence)
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

  // 4. Collapse excess blank lines
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function presentResult(result: ExecutionResult, task: TaskSpec): string {
  // followUpQuestion takes precedence — the executor needs more info
  if (result.followUpQuestion) {
    return result.followUpQuestion.trim();
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
  if (result.summary && !result.summary.startsWith("ok")) {
    const nextStep = chooseNextStepQuestion(task);
    return `That did not complete as expected.\n\n> ${result.summary}\n\n${nextStep}`;
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
