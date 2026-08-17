import { describe, expect, it } from 'vitest';
import { formatNarratorProgress } from './progressNarration.js';

describe('formatNarratorProgress', () => {
  it('uses general, user-facing language for milestones', () => {
    expect(formatNarratorProgress({ milestone: 'planning' })).toEqual({
      milestone: 'planning',
      message: 'I’m planning the approach.',
      tone: 'active',
    });
    expect(formatNarratorProgress({ milestone: 'checking' }).message)
      .toBe('The main work is complete. I’m checking the result.');
  });

  it('reports completed work steps without role or pipeline terminology', () => {
    const progress = formatNarratorProgress({ milestone: 'step_completed', completedSteps: 2 });
    expect(progress.message).toBe('Work step 2 is complete.');
    expect(progress.message).not.toMatch(/brain|maestro|gate|subagent|qc/i);
  });

  it('clamps malformed step counts', () => {
    expect(formatNarratorProgress({ milestone: 'step_completed', completedSteps: -1 }).message)
      .toBe('A work step is complete.');
    expect(formatNarratorProgress({ milestone: 'step_completed', completedSteps: 50_000 }).message)
      .toBe('Work step 9999 is complete.');
  });
});
