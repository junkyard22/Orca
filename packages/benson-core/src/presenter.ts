import type { ExecutionResult, TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Tone rules:
//   - Calm, concise, professional "butler" vibe.
//   - No emojis. No internal system talk. No component names.
//   - FAIL: brief apology + one next-step question.
//   - followUpQuestion: surface it directly.
// ---------------------------------------------------------------------------

export function presentResult(result: ExecutionResult, task: TaskSpec): string {
  // followUpQuestion takes precedence — the executor needs more info
  if (result.followUpQuestion) {
    return result.followUpQuestion.trim();
  }

  if (result.status === "SUCCESS") {
    return presentSuccess(result, task);
  }

  return presentFailure(result, task);
}

function presentSuccess(result: ExecutionResult, task: TaskSpec): string {
  // Prefer an explicit user-facing message from the executor
  if (result.userFacingText) {
    return result.userFacingText.trim();
  }

  // Construct a concise confirmation from the task goals
  const summary = task.goals.length === 1
    ? task.goals[0]
    : task.goals.map((g, i) => `${i + 1}. ${g}`).join("\n");

  return `Done. Here is what was completed:\n\n${summary}`;
}

function presentFailure(result: ExecutionResult, task: TaskSpec): string {
  // If there IS output, show it — the LLM did produce something even if QC
  // flagged issues. Append the next-step question below so the user can act.
  if (result.userFacingText) {
    const nextStep = chooseNextStepQuestion(task);
    return `${result.userFacingText.trim()}\n\n---\n*QC noted some issues with the above. ${nextStep}*`;
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
