import { describe, expect, it } from 'vitest';
import {
  applyNarratorLexicon,
  buildNarratorLexiconPrompt,
  createNarratorProgressTracker,
  parseNarratorLexicon,
} from './narratorProgress';

describe('Narrator progress tracker', () => {
  it('turns a direct run into general progress updates', () => {
    const tracker = createNarratorProgressTracker();
    const messages = [
      tracker.consume({ type: 'task:start', taskId: 't1', intent: 'secret request' }),
      tracker.consume({ type: 'maestro:start', taskId: 't1', attempt: 0, isRepair: false }),
      tracker.consume({
        type: 'maestro:agent_done',
        taskId: 't1',
        role: 'strong_model',
        stoppedBecause: 'done',
        iterations: 3,
      }),
      tracker.consume({ type: 'maestro:done', taskId: 't1', attempt: 0, isRepair: false, hasOutput: true }),
      tracker.consume({
        type: 'qc:result',
        taskId: 't1',
        attempt: 0,
        isRepair: false,
        verdict: 'PASS',
        issueCount: 0,
      }),
      tracker.consume({ type: 'task:done', taskId: 't1', status: 'SUCCESS' }),
    ].flatMap((item) => item ? [item.message] : []);

    expect(messages).toEqual([
      'I’ve got your request. I’m outlining the work.',
      'I’m planning the approach.',
      'Work step 1 is complete.',
      'The main work is complete. I’m checking the result.',
      'The result passed its checks.',
      'Everything is complete. I’m preparing the final response.',
    ]);
  });

  it('counts subagent completions once and suppresses lower-level duplicates', () => {
    const tracker = createNarratorProgressTracker();
    tracker.consume({ type: 'subagent:spawned', taskId: 't1', subagentId: 'a', role: 'coder', task: 'secret' });

    const duplicate = tracker.consume({
      type: 'maestro:agent_done',
      taskId: 't1',
      role: 'coder',
      stoppedBecause: 'done',
      iterations: 2,
    });
    const first = tracker.consume({ type: 'subagent:done', taskId: 't1', subagentId: 'a', role: 'coder', ok: true });
    const second = tracker.consume({ type: 'subagent:done', taskId: 't1', subagentId: 'b', role: 'reviewer', ok: true });

    expect(duplicate).toBeUndefined();
    expect(first?.message).toBe('Work step 1 is complete.');
    expect(second?.message).toBe('Work step 2 is complete.');
  });

  it('never repeats free-text task or error payloads', () => {
    const tracker = createNarratorProgressTracker();
    const started = tracker.consume({
      type: 'subagent:spawned',
      taskId: 't1',
      subagentId: 'a',
      role: 'reader',
      task: 'SECRET TASK CONTENT',
    });
    const failed = tracker.consume({
      type: 'subagent:failed',
      taskId: 't1',
      subagentId: 'a',
      role: 'reader',
      error: 'SECRET ERROR CONTENT',
    });

    expect(JSON.stringify([started, failed])).not.toContain('SECRET');
    expect(failed?.tone).toBe('warning');
  });

  it('narrates context, repair, and terminal failure milestones', () => {
    const tracker = createNarratorProgressTracker();
    const updates = [
      tracker.consume({
        type: 'dewey:brief',
        taskId: 't1',
        userName: 'User',
        suggestedTone: 'brief',
        relevantPreferences: [],
        relevantContext: [],
      }),
      tracker.consume({ type: 'repair:start', taskId: 't1', pass: 1, maxPasses: 2 }),
      tracker.consume({ type: 'task:done', taskId: 't1', status: 'FAIL' }),
    ];

    expect(updates.map((update) => update?.milestone)).toEqual([
      'context_ready',
      'repairing',
      'failed',
    ]);
    expect(updates.at(-1)?.tone).toBe('warning');
  });

  it('applies a validated model-authored voice without losing step counts', () => {
    const lexicon = parseNarratorLexicon(JSON.stringify({
      planning: 'Let me map out the best approach.',
      step_completed: 'Nice — step {step} is wrapped up.',
    }));
    const tracker = createNarratorProgressTracker();
    const planning = tracker.consume({ type: 'maestro:start', taskId: 't1', attempt: 0, isRepair: false });
    const completed = tracker.consume({
      type: 'maestro:agent_done',
      taskId: 't1',
      role: 'strong_model',
      stoppedBecause: 'done',
      iterations: 1,
    });

    expect(applyNarratorLexicon(planning!, lexicon).message)
      .toBe('Let me map out the best approach.');
    expect(applyNarratorLexicon(completed!, lexicon).message)
      .toBe('Nice — step 1 is wrapped up.');
  });

  it('rejects malformed, unsafe, and placeholder-breaking model copy', () => {
    expect(parseNarratorLexicon('not json')).toEqual({});
    expect(parseNarratorLexicon(JSON.stringify({
      planning: 'Brain is planning through the pipeline.',
      step_completed: 'Another step is done.',
      checking: 'I’m checking the result.\u001b',
    }))).toEqual({ checking: 'I’m checking the result.' });
  });

  it('builds a styling prompt from canonical milestones only', () => {
    const prompt = buildNarratorLexiconPrompt();
    expect(prompt).toContain('{step}');
    expect(prompt).not.toContain('SECRET TASK CONTENT');
    expect(prompt).not.toContain('error payload');
  });
});
