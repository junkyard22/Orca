export type NarratorProgressMilestone =
  | 'received'
  | 'context_ready'
  | 'planning'
  | 'work_started'
  | 'step_completed'
  | 'step_incomplete'
  | 'checking'
  | 'check_passed'
  | 'check_warned'
  | 'check_failed'
  | 'repairing'
  | 'finalizing'
  | 'failed';

export type NarratorProgressTone = 'active' | 'complete' | 'warning';

export interface NarratorProgressInput {
  milestone: NarratorProgressMilestone;
  completedSteps?: number;
}

export interface NarratorProgressUpdate {
  milestone: NarratorProgressMilestone;
  message: string;
  tone: NarratorProgressTone;
  completedSteps?: number;
}

function safeStepCount(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return 0;
  return Math.min(9_999, Math.floor(value));
}

/**
 * Benson-owned, privacy-safe progress language for the desktop Narrator.
 * Inputs are semantic milestones only, so model output, prompts, tool args,
 * paths, and internal gate diagnostics cannot leak into these updates.
 */
export function formatNarratorProgress(input: NarratorProgressInput): NarratorProgressUpdate {
  const completedSteps = safeStepCount(input.completedSteps);

  switch (input.milestone) {
    case 'received':
      return { milestone: input.milestone, message: 'I’ve got your request. I’m outlining the work.', tone: 'active' };
    case 'context_ready':
      return { milestone: input.milestone, message: 'I’ve loaded the relevant context.', tone: 'complete' };
    case 'planning':
      return { milestone: input.milestone, message: 'I’m planning the approach.', tone: 'active' };
    case 'work_started':
      return { milestone: input.milestone, message: 'Work is underway.', tone: 'active' };
    case 'step_completed':
      return {
        milestone: input.milestone,
        message: completedSteps > 0
          ? `Work step ${completedSteps} is complete.`
          : 'A work step is complete.',
        tone: 'complete',
        ...(completedSteps > 0 && { completedSteps }),
      };
    case 'step_incomplete':
      return {
        milestone: input.milestone,
        message: 'A work step finished, but it may need another pass.',
        tone: 'warning',
      };
    case 'checking':
      return {
        milestone: input.milestone,
        message: 'The main work is complete. I’m checking the result.',
        tone: 'active',
      };
    case 'check_passed':
      return { milestone: input.milestone, message: 'The result passed its checks.', tone: 'complete' };
    case 'check_warned':
      return {
        milestone: input.milestone,
        message: 'The checks are complete, with a few cautions.',
        tone: 'warning',
      };
    case 'check_failed':
      return { milestone: input.milestone, message: 'The checks found something to fix.', tone: 'warning' };
    case 'repairing':
      return { milestone: input.milestone, message: 'I’m correcting the issues that were found.', tone: 'active' };
    case 'finalizing':
      return {
        milestone: input.milestone,
        message: 'Everything is complete. I’m preparing the final response.',
        tone: 'complete',
      };
    case 'failed':
      return {
        milestone: input.milestone,
        message: 'I couldn’t complete the work. I’m preparing a clear explanation.',
        tone: 'warning',
      };
  }
}
