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
  /** Brain-defined acceptance criteria Pappy must enforce. */
  done_criteria?: string[];
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
  /** Brain-defined acceptance criteria Pappy must enforce. */
  done_criteria?: string[];
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
{ "routing": "direct", "role": "<role>", "done_criteria": ["<criterion 1>", "<criterion 2>"] }

## Option B — multiple specialists work in parallel:
{
  "routing": "decompose",
  "departments": [
    { "head": "<role>", "subtask": "<fully self-contained directive>", "context": "<optional background>" }
  ],
  "synthesis_hint": "<how to merge the outputs>",
  "done_criteria": ["<criterion 1>", "<criterion 2>"]
}

## done_criteria rules:
- List 1-4 short, objective, verifiable statements about what the final output must contain or achieve.
- Each criterion must be independently checkable (e.g. "Output contains a TypeScript function", "All exported functions have JSDoc comments").
- Do NOT include process steps or explanations — only outcome facts.
- CRITICAL: Criteria must describe what a CORRECT answer to THIS specific request looks like. Ground every criterion in the actual task wording.
- NEVER invent capability limitations (e.g. "unable to access", "explains inability", "no filesystem access") unless the user's request explicitly states a constraint. If a tool can do it, assume it will.
- NEVER introduce concepts not present in the user's request. If the user asks to "count R's in filenames", the criterion must mention "count", "R", and "filenames" — not "limitations" or "alternatives".
- For counting/listing/status tasks: criteria must name what is being counted, listed, or shown. Bad: "Output summarises result". Good: "Output states the count of filenames containing the letter R".

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
- Use "decompose" ONLY when the request explicitly combines two or more distinct types of work that require DIFFERENT specialist roles.
- A strong signal: the request uses "AND" (or "ALSO", "AS WELL AS", "PLUS") to join two clearly different work categories (code vs docs, code vs review, plan vs implement).
- Maximum 3 departments.
- Each subtask must be complete and actionable on its own — departments don't talk to each other.

## Examples — DIRECT (one specialist):
- "write a function that gets the time" → { "routing": "direct", "role": "coder_strong" }
- "explain how async/await works" → { "routing": "direct", "role": "brain" }
- "fix the bug in line 42" → { "routing": "direct", "role": "debugger" }
- "implement a login form" → { "routing": "direct", "role": "coder_strong" }
- "show me the current deployment status" → { "routing": "direct", "role": "brain" }
- "what is currently deployed in production" → { "routing": "direct", "role": "brain" }
- "investigate why the service is down" → { "routing": "direct", "role": "debugger" }
- "give me a repo overview" → { "routing": "direct", "role": "brain" }
- "what files changed recently" → { "routing": "direct", "role": "brain" }
- "count how many filenames contain R" → { "routing": "direct", "role": "brain", "done_criteria": ["Output states the count of top-level filenames containing the letter R", "Output states the count of top-level filenames containing the letter D"] }
  BAD done_criteria for that task: ["Output explains inability to access filesystem"] ← NEVER invent limitations

## Anti-patterns — DO NOT route to utility unless task is ONLY lint/format/cleanup:
- status queries → brain, NOT utility
- deployment queries → brain, NOT utility
- investigation / fact-finding → brain or debugger, NOT utility
- "show me" / "tell me" / "what is" → brain, NOT utility

## Examples — DECOMPOSE (multiple specialists):
- "implement a login form AND write the JSDoc for it" → decompose: [coder_strong, narrator]
- "review this code AND fix all the bugs you find" → decompose: [reviewer, coder_strong]
- "write a detailed plan AND then implement it" → decompose: [planner_deep, coder_strong]
- "build the API endpoint AND write the README for it" → decompose: [coder_strong, narrator]`;

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
      done_criteria: Array.isArray(parsed['done_criteria'])
        ? (parsed['done_criteria'] as string[]).filter((s) => typeof s === 'string')
        : undefined,
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
      done_criteria:    Array.isArray(parsed['done_criteria'])
        ? (parsed['done_criteria'] as string[]).filter((s) => typeof s === 'string')
        : undefined,
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
