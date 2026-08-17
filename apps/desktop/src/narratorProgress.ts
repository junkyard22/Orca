import {
  formatNarratorProgress,
  type NarratorProgressInput,
  type NarratorProgressUpdate,
} from '@clawde/benson-core';
import type { OrcaEvent } from '@clawde/orca-core';

export type NarratorProgressLexicon = Partial<Record<
  NarratorProgressUpdate['milestone'],
  string
>>;

const NARRATOR_MILESTONES: NarratorProgressUpdate['milestone'][] = [
  'received',
  'context_ready',
  'planning',
  'work_started',
  'step_completed',
  'step_incomplete',
  'checking',
  'check_passed',
  'check_warned',
  'check_failed',
  'repairing',
  'finalizing',
  'failed',
];

const INTERNAL_TERM_PATTERN = /\b(?:brain|maestro|miranda|pappy|subagent|pipeline|gate|qc|trace|token|model)\b/i;

function cleanNarratorMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return INTERNAL_TERM_PATTERN.test(cleaned) ? '' : cleaned;
}

/** One provider call can style every milestone; task and tool data are never included. */
export function buildNarratorLexiconPrompt(): string {
  const canonical = Object.fromEntries(NARRATOR_MILESTONES.map((milestone) => {
    if (milestone === 'step_completed') return [milestone, 'Work step {step} is complete.'];
    return [milestone, formatNarratorProgress({ milestone }).message];
  }));
  return [
    'Rewrite each progress message in a warm, concise narrator voice.',
    'Return only one JSON object with exactly the same keys and string values.',
    'Each value must be one plain sentence under 120 characters.',
    'Do not mention internal components, models, gates, tools, prompts, or diagnostics.',
    'Preserve the literal {step} placeholder in step_completed.',
    JSON.stringify(canonical),
  ].join('\n');
}

export function parseNarratorLexicon(value: unknown): NarratorProgressLexicon {
  if (typeof value !== 'string') return {};
  const candidate = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const record = parsed as Record<string, unknown>;
  const lexicon: NarratorProgressLexicon = {};
  for (const milestone of NARRATOR_MILESTONES) {
    const message = cleanNarratorMessage(record[milestone]);
    if (!message) continue;
    if (milestone === 'step_completed' && !message.includes('{step}')) continue;
    lexicon[milestone] = message;
  }
  return lexicon;
}

export function applyNarratorLexicon(
  update: NarratorProgressUpdate,
  lexicon: NarratorProgressLexicon | undefined,
): NarratorProgressUpdate {
  const styled = cleanNarratorMessage(lexicon?.[update.milestone]);
  if (!styled) return update;
  const message = update.milestone === 'step_completed'
    ? styled.replace('{step}', String(update.completedSteps ?? ''))
    : styled;
  return { ...update, message: message.replace(/\s+/g, ' ').trim() || update.message };
}

export interface NarratorProgressTracker {
  consume(event: OrcaEvent): NarratorProgressUpdate | undefined;
}

/** Maps runtime metadata to Benson's safe, general progress vocabulary. */
export function createNarratorProgressTracker(): NarratorProgressTracker {
  let completedSteps = 0;
  let hasSubagents = false;
  let lastKey = '';

  const emit = (input: NarratorProgressInput): NarratorProgressUpdate | undefined => {
    const key = `${input.milestone}:${input.completedSteps ?? ''}`;
    if (key === lastKey) return undefined;
    lastKey = key;
    return formatNarratorProgress(input);
  };

  return {
    consume(event) {
      switch (event.type) {
        case 'task:start':
          return emit({ milestone: 'received' });
        case 'dewey:brief':
          return emit({ milestone: 'context_ready' });
        case 'maestro:start':
          return event.isRepair ? undefined : emit({ milestone: 'planning' });
        case 'maestro:agent_start':
          return emit({ milestone: 'work_started' });
        case 'subagent:spawned':
          hasSubagents = true;
          return emit({ milestone: 'work_started' });
        case 'maestro:agent_done':
          if (hasSubagents) return undefined;
          if (event.stoppedBecause !== 'done') return emit({ milestone: 'step_incomplete' });
          completedSteps += 1;
          return emit({ milestone: 'step_completed', completedSteps });
        case 'subagent:done':
          if (!event.ok) return emit({ milestone: 'step_incomplete' });
          completedSteps += 1;
          return emit({ milestone: 'step_completed', completedSteps });
        case 'subagent:failed':
          return emit({ milestone: 'step_incomplete' });
        case 'maestro:done':
          return event.hasOutput
            ? emit({ milestone: 'checking' })
            : emit({ milestone: 'step_incomplete' });
        case 'qc:result':
          return event.verdict === 'PASS'
            ? emit({ milestone: 'check_passed' })
            : event.verdict === 'WARN'
              ? emit({ milestone: 'check_warned' })
              : emit({ milestone: 'check_failed' });
        case 'repair:start':
          return emit({ milestone: 'repairing' });
        case 'task:done':
          return event.status === 'FAIL'
            ? emit({ milestone: 'failed' })
            : emit({ milestone: 'finalizing' });
        default:
          return undefined;
      }
    },
  };
}
