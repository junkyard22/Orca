/**
 * Brain Decompose — Maestro's task routing intelligence.
 *
 * Maestro sends every incoming task to Brain with this prompt.
 * Brain either routes it to a single specialist ("direct") or
 * splits it into parallel department subtasks ("decompose").
 *
 * Only Brain responds here — departments run AFTER this decision.
 */

import type { RoleName } from './roleSelector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeadName = Exclude<RoleName, 'vision'> | 'brain';

export interface DirectRouting {
  routing: 'direct';
  role: HeadName;
}

export interface DepartmentTask {
  head: HeadName;
  subtask: string;
  /** Any extra context Brain wants to pass to this department. */
  context?: string;
}

export interface DecomposeRouting {
  routing: 'decompose';
  departments: DepartmentTask[];
  /** Brief instruction for how to merge department outputs into one answer. */
  synthesis_hint?: string;
}

export type DecomposeDecision = DirectRouting | DecomposeRouting;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * System prompt for Brain's decompose call.
 * Kept short so a fast/cheap model handles it in < 3 seconds.
 */
export const BRAIN_DECOMPOSE_SYSTEM = `\
You are Maestro's task router. Read the user request and decide how to handle it.

Reply with ONLY valid JSON — no markdown fences, no explanation.

## Option A — one specialist handles it:
{ "routing": "direct", "role": "<role>" }

## Option B — multiple specialists work in parallel:
{
  "routing": "decompose",
  "departments": [
    { "head": "<role>", "subtask": "<fully self-contained directive>", "context": "<optional background>" }
  ],
  "synthesis_hint": "<how to merge the outputs>"
}

## Role menu:
brain         — reasoning, analysis, open-ended questions
coder_strong  — full feature implementation, complex code, multi-file changes
coder_cheap   — tiny edits, renames, formatting, single-line fixes
reviewer      — code review, bug finding, security audit
narrator      — documentation, READMEs, JSDoc, user-facing writing
planner_deep  — step-by-step plans for large/risky work
debugger      — root cause analysis of errors and failures
reader        — summarising long documents, logs, or large text
utility       — general tasks that don't fit other categories

## Rules:
- Use "direct" for the VAST MAJORITY of requests.
- Only use "decompose" when two or more specialists genuinely need to work independently and in parallel (e.g. "implement X AND document it", "review this code AND fix the bugs").
- Single-focus tasks like "write a function" or "explain this" are always "direct".
- Maximum 3 departments.
- Each subtask must be complete and actionable on its own — departments don't talk to each other.`;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse Brain's JSON decision. Throws on malformed JSON.
 * Callers should catch and fall back to { routing: 'direct', role: 'brain' }.
 */
export function parseBrainDecision(raw: string): DecomposeDecision {
  // Strip accidental markdown code fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  if (parsed['routing'] === 'direct') {
    return {
      routing: 'direct',
      role: (parsed['role'] as HeadName) ?? 'brain',
    };
  }

  if (parsed['routing'] === 'decompose') {
    const rawDepts = parsed['departments'];
    const departments: DepartmentTask[] = Array.isArray(rawDepts)
      ? rawDepts.map((d) => ({
          head:     (d as Record<string, unknown>)['head']    as HeadName ?? 'brain',
          subtask:  String((d as Record<string, unknown>)['subtask'] ?? ''),
          context:  (d as Record<string, unknown>)['context'] as string | undefined,
        }))
      : [];

    if (departments.length === 0) {
      // Decompose with no departments makes no sense — fall back to direct
      return { routing: 'direct', role: 'brain' };
    }

    return {
      routing:          'decompose',
      departments,
      synthesis_hint:   parsed['synthesis_hint'] as string | undefined,
    };
  }

  throw new Error(`Unknown routing value: ${JSON.stringify(parsed['routing'])}`);
}

// ---------------------------------------------------------------------------
// Synthesis prompt
// ---------------------------------------------------------------------------

/**
 * Build the synthesis prompt Brain uses to merge department outputs
 * into a single coherent answer for the user.
 */
export function buildSynthesisPrompt(
  originalTask: string,
  deptOutputs: Array<{ head: string; subtask: string; output: string }>,
  hint?: string,
): string {
  const sections = deptOutputs
    .map((d) => `### ${d.head.toUpperCase()} output (subtask: "${d.subtask}")\n${d.output}`)
    .join('\n\n');

  return [
    `You are synthesising the outputs of multiple specialist departments into one coherent response for the user.`,
    ``,
    `Original request: "${originalTask}"`,
    hint ? `Synthesis instruction: ${hint}` : '',
    ``,
    `## Department outputs`,
    sections,
    ``,
    `## Instructions`,
    `Merge the above into a single, clean, unified reply. Do not add headers like "CODER_STRONG said..." — present the integrated result naturally as if one person wrote it.`,
  ].filter((l) => l !== null).join('\n');
}
