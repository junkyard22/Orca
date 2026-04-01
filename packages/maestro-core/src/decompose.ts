/**
 * Brain Decompose — Maestro's task routing intelligence.
 *
 * This module defines the AUTHORITATIVE Brain routing contract.
 * Brain either routes a task to a single specialist ("direct") or
 * splits it into parallel department subtasks ("decompose").
 *
 * Only Brain responds here — departments run AFTER this decision.
 *
 * ARCHITECTURE NOTE: BRAIN_DECOMPOSE_SYSTEM + parseBrainDecision form the
 * canonical single owner of decomposition decisions in Orca. The current live
 * pipeline (apps/runner/src/adapters/maestroAdapter.ts::decomposeTask) uses a
 * parallel path via planner_deep that predates this contract. Future work
 * should consolidate decomposition under this module so Brain is the sole
 * routing authority.
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
You are a task router. You receive a task specification and return a routing decision.

Your entire response MUST be a single bare JSON object. No markdown fences. No text before the JSON. No text after the JSON. No explanation. No confirmation. No questions. No preamble. No post-amble. Any output that is not bare JSON is incorrect.

## Output schemas:

Option A — single specialist handles the task:
{ "routing": "direct", "role": "<role>", "done_criteria": ["<criterion 1>", "<criterion 2>"] }

Option B — multiple specialists work in parallel:
{
  "routing": "decompose",
  "departments": [
    { "head": "<role>", "subtask": "<fully self-contained directive>", "context": "<optional background>" }
  ],
  "synthesis_hint": "<how to merge the outputs>",
  "done_criteria": ["<criterion 1>", "<criterion 2>"]
}

## Valid role values:
brain         — reasoning, analysis, open-ended questions
strong_model  — full feature implementation, complex code, multi-file changes
cheap_model   — tiny edits, renames, formatting, single-line fixes
reviewer      — code review, bug finding, security audit
narrator      — documentation, READMEs, JSDoc, user-facing writing
planner_deep  — step-by-step plans for large/risky work
debugger      — root cause analysis of errors and failures
reader        — summarising long documents, logs, or large text
utility       — general tasks that don't fit other categories

## done_criteria rules:
- List 1-4 short, objective, verifiable statements about what the final output must contain or achieve.
- Each criterion must be independently checkable (e.g. "Output contains a TypeScript function", "All exported functions have JSDoc comments").
- Do NOT include process steps or explanations — only outcome facts.
- CRITICAL: Criteria must describe what a CORRECT answer to THIS specific request looks like. Ground every criterion in the actual task wording.
- NEVER invent capability limitations (e.g. "unable to access", "explains inability", "no filesystem access") unless the user's request explicitly states a constraint. If a tool can do it, assume it will.
- NEVER introduce concepts not present in the user's request. If the user asks to "count R's in filenames", the criterion must mention "count", "R", and "filenames" — not "limitations" or "alternatives".
- For counting/listing/status tasks: criteria must name what is being counted, listed, or shown. Bad: "Output summarises result". Good: "Output states the count of filenames containing the letter R".

## Routing rules:
- Use "direct" for the VAST MAJORITY of requests.
- Use "decompose" ONLY when the request explicitly combines two or more distinct types of work that require DIFFERENT specialist roles.
- A strong signal: the request uses "AND" (or "ALSO", "AS WELL AS", "PLUS") to join two clearly different work categories (code vs docs, code vs review, plan vs implement).
- Maximum 3 departments.
- Each subtask must be complete and actionable on its own — departments don't talk to each other.

## Anti-patterns — DO NOT route to utility unless task is ONLY lint/format/cleanup:
- status queries → brain, NOT utility
- deployment queries → brain, NOT utility
- investigation / fact-finding → brain or debugger, NOT utility
- "show me" / "tell me" / "what is" → brain, NOT utility

## Example:

Input: "implement a debounce utility function in TypeScript"

Expected output:
{"routing":"direct","role":"strong_model","done_criteria":["Output contains a TypeScript function named debounce","Function accepts a callback and a delay in milliseconds","Function returns a debounced wrapper that delays invocation"]}

## More routing examples — DIRECT:
- "write a function that gets the time" → { "routing": "direct", "role": "strong_model" }
- "explain how async/await works" → { "routing": "direct", "role": "brain" }
- "fix the bug in line 42" → { "routing": "direct", "role": "debugger" }
- "implement a login form" → { "routing": "direct", "role": "strong_model" }
- "show me the current deployment status" → { "routing": "direct", "role": "brain" }
- "what is currently deployed in production" → { "routing": "direct", "role": "brain" }
- "investigate why the service is down" → { "routing": "direct", "role": "debugger" }
- "give me a repo overview" → { "routing": "direct", "role": "brain" }
- "what files changed recently" → { "routing": "direct", "role": "brain" }
- "count how many filenames contain R" → { "routing": "direct", "role": "brain", "done_criteria": ["Output states the count of top-level filenames containing the letter R"] }
  BAD done_criteria for that task: ["Output explains inability to access filesystem"] ← NEVER invent limitations

## More routing examples — DECOMPOSE:
- "implement a login form AND write the JSDoc for it" → decompose: [strong_model, narrator]
- "review this code AND fix all the bugs you find" → decompose: [reviewer, strong_model]
- "write a detailed plan AND then implement it" → decompose: [planner_deep, strong_model]
- "build the API endpoint AND write the README for it" → decompose: [strong_model, narrator]`;

// ---------------------------------------------------------------------------
// Schema Validation
// ---------------------------------------------------------------------------

/** All valid values for HeadName (every RoleName except 'vision'). */
export const VALID_HEAD_NAMES = new Set<string>([
  'brain', 'strong_model', 'cheap_model', 'utility', 'reviewer', 'narrator',
  'planner_deep', 'debugger', 'reader',
]);

// Allowed top-level keys per routing type — rejects hallucinated fields like "confidence".
const DIRECT_VALID_KEYS   = new Set(['routing', 'role', 'done_criteria']);
const DECOMPOSE_VALID_KEYS = new Set(['routing', 'departments', 'synthesis_hint', 'done_criteria']);
const DEPT_VALID_KEYS      = new Set(['head', 'subtask', 'context']);

/**
 * Thrown when Brain's output fails schema validation.
 * The `reason` field describes the exact violation — safe to feed back into a repair prompt.
 */
export class BrainDecisionValidationError extends Error {
  public readonly reason: string;
  public readonly raw: string;

  constructor(reason: string, raw: string) {
    super(`Brain decision validation failed: ${reason}`);
    this.name = 'BrainDecisionValidationError';
    this.reason = reason;
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Parse + Validate
// ---------------------------------------------------------------------------

/**
 * Strictly parse and validate Brain's JSON output.
 * Throws BrainDecisionValidationError for any schema violation so callers
 * can catch it and trigger a repair pass rather than silently propagating
 * invalid routing decisions downstream.
 */
export function parseBrainDecision(raw: string): DecomposeDecision {
  // Step 1: Strip <think>...</think> blocks emitted by reasoning models (e.g. qwen3-max).
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Step 2: Strip accidental markdown code fences (one layer only).
  const stripped = withoutThink
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  const cleaned = stripped.trim();

  // Step 2: Reject free text before the JSON object.
  if (!cleaned.startsWith('{')) {
    throw new BrainDecisionValidationError(
      `Response must begin with '{'. Got: ${JSON.stringify(cleaned.slice(0, 60))}`,
      raw,
    );
  }

  // Step 3: Reject free text after the JSON object.
  if (!cleaned.endsWith('}')) {
    throw new BrainDecisionValidationError(
      `Response must end with '}'. Got: ...${JSON.stringify(cleaned.slice(-60))}`,
      raw,
    );
  }

  // Step 4: Parse JSON — wrap SyntaxError as a validation error.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    throw new BrainDecisionValidationError(
      `Invalid JSON: ${(err as SyntaxError).message}`,
      raw,
    );
  }

  // Step 5: Validate 'routing'.
  const routing = parsed['routing'];
  if (routing !== 'direct' && routing !== 'decompose') {
    throw new BrainDecisionValidationError(
      `'routing' must be "direct" or "decompose", got: ${JSON.stringify(routing)}`,
      raw,
    );
  }

  if (routing === 'direct') {
    // Step 6: Reject hallucinated top-level keys (e.g. "confidence", "explanation").
    const extra = Object.keys(parsed).filter((k) => !DIRECT_VALID_KEYS.has(k));
    if (extra.length > 0) {
      throw new BrainDecisionValidationError(
        `Unexpected field(s) in direct routing response: ${extra.join(', ')}`,
        raw,
      );
    }

    // Step 7: Validate 'role' is present and within the enum.
    const role = parsed['role'];
    if (typeof role !== 'string' || role === '') {
      throw new BrainDecisionValidationError(
        `'role' must be a non-empty string, got: ${JSON.stringify(role)}`,
        raw,
      );
    }
    if (!VALID_HEAD_NAMES.has(role)) {
      throw new BrainDecisionValidationError(
        `'role' "${role}" is not valid. Valid values: ${[...VALID_HEAD_NAMES].join(', ')}`,
        raw,
      );
    }

    return {
      routing: 'direct',
      role: role as HeadName,
      done_criteria: Array.isArray(parsed['done_criteria'])
        ? (parsed['done_criteria'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
    };
  }

  // routing === 'decompose'
  // Step 6: Reject hallucinated top-level keys.
  const extra = Object.keys(parsed).filter((k) => !DECOMPOSE_VALID_KEYS.has(k));
  if (extra.length > 0) {
    throw new BrainDecisionValidationError(
      `Unexpected field(s) in decompose routing response: ${extra.join(', ')}`,
      raw,
    );
  }

  // Step 7: Validate 'departments' is a non-empty array.
  const rawDepts = parsed['departments'];
  if (!Array.isArray(rawDepts) || rawDepts.length === 0) {
    throw new BrainDecisionValidationError(
      `'departments' must be a non-empty array for decompose routing`,
      raw,
    );
  }

  const departments: DepartmentTask[] = [];
  for (let i = 0; i < rawDepts.length; i++) {
    const d = rawDepts[i] as Record<string, unknown>;

    const deptExtra = Object.keys(d).filter((k) => !DEPT_VALID_KEYS.has(k));
    if (deptExtra.length > 0) {
      throw new BrainDecisionValidationError(
        `Department[${i}] has unexpected field(s): ${deptExtra.join(', ')}`,
        raw,
      );
    }

    const head = d['head'];
    if (typeof head !== 'string' || head === '') {
      throw new BrainDecisionValidationError(
        `Department[${i}]: 'head' must be a non-empty string`,
        raw,
      );
    }
    if (!VALID_HEAD_NAMES.has(head)) {
      throw new BrainDecisionValidationError(
        `Department[${i}]: 'head' "${head}" is not a valid role`,
        raw,
      );
    }

    const subtask = d['subtask'];
    if (typeof subtask !== 'string' || subtask.trim() === '') {
      throw new BrainDecisionValidationError(
        `Department[${i}]: 'subtask' must be a non-empty string`,
        raw,
      );
    }

    departments.push({
      head: head as HeadName,
      subtask,
      context: typeof d['context'] === 'string' ? d['context'] : undefined,
    });
  }

  return {
    routing:        'decompose',
    departments,
    synthesis_hint: typeof parsed['synthesis_hint'] === 'string' ? parsed['synthesis_hint'] : undefined,
    done_criteria:  Array.isArray(parsed['done_criteria'])
      ? (parsed['done_criteria'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  };
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
