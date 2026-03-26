/**
 * Brain Task Graph — deep decomposition into a per-file work order.
 *
 * Used when brainRoute returns routing === 'decompose'.
 * Brain is called again with thinking enabled and a 4000+ token budget,
 * producing a task_graph where each node targets exactly one file.
 *
 * Prompt ported faithfully from the Python-era BRAIN_PROMPT_TEMPLATE
 * (coordinator.py / test_brain_decomposition.py).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskNode {
  /** Unique identifier within this graph, e.g. "T1". */
  id: string;
  /** Action-verb description — must name the specific thing being added/changed. */
  description: string;
  /** Role to execute this task: brain | coder_strong | coder_cheap | utility | narrator | reviewer | planner_deep | debugger | reader */
  model_role: string;
  /** Target file path with extension, or UNKNOWN/<filename.ext> when path is unknown. */
  file_path: string;
  /** IDs of tasks that must complete before this one starts. */
  dependencies: string[];
}

export interface TaskGraphResponse {
  task_graph: TaskNode[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Static instructions for Brain's deep decomposition call.
 * The full prompt is assembled by buildTaskGraphPrompt().
 */
const TASK_GRAPH_INSTRUCTIONS = `\
━━━ REQUIRED FORMAT (one object per file) ━━━
{"task_graph":[
  {"id":"T1","description":"<verb> <specific what>","model_role":"<role>","file_path":"src/folder/filename.ext","dependencies":[]}
]}

━━━ ROLE SELECTION — decision tree, follow in order ━━━
Step 1: Is the task deleting a file?           → coder_cheap (always)
Step 2: Is the task ONLY reformatting/linting? → utility     (always)
Step 3: Does the target file end in one of:
        .md .txt .env .yaml .yml .json .toml .ini .cfg .bak .lock
                                               → coder_cheap (always, even if creating)
Step 4: Does the task create or modify a CODE file (.py .ts .js .tsx .go .java .cs .rb .rs)
        AND requires writing new functions, classes, endpoints, or test logic?
                                               → coder_strong
Step 5: All other small edits to existing files→ coder_cheap

DO NOT default to coder_strong. coder_strong is reserved for new logic only.
If you are unsure, pick coder_cheap.

Role examples — read each one:
  Update README.md to add installation steps       → coder_cheap   (.md file, step 3)
  Add SMTP_HOST key to .env                        → coder_cheap   (.env file, step 3)
  Delete old_auth.py.bak                           → coder_cheap   (deletion, step 1)
  Add config keys to config/settings.py            → coder_cheap   (small edit, step 5)
  Reformat imports in src/utils/security.py        → utility        (reformat only, step 2)
  Create src/notifications/email.py with EmailSender → coder_strong (new class, step 4)
  Implement /auth/refresh endpoint in src/api/auth.py → coder_strong (new function, step 4)
  Write tests in tests/test_auth.py                → coder_strong   (new test logic, step 4)

━━━ FILE PATH RULES ━━━
1. ONE TASK PER FILE — 10 files = 10 tasks.
2. file_path MUST be a full filename with extension.
   BAD: {"file_path":"src/models/"}              ← directory, FORBIDDEN
   GOOD: {"file_path":"src/models/password_reset.py"}
3. No path in project structure? ALWAYS use UNKNOWN/<filename.ext>. Never invent paths.
   GOOD: {"file_path":"UNKNOWN/login.py"}         ← correct when path unknown
   GOOD: {"file_path":"UNKNOWN/login.test.js"}
4. Bulk file operations: use wildcard like "*.bak" or "src/**/*.tmp" instead of one generic task.

━━━ DESCRIPTION RULES ━━━
1. MUST start with an action verb: Add, Create, Implement, Delete, Update, Write, Fix, Refactor.
2. MUST name the specific thing being added/changed — not just "update file" or "modify code".
   BAD: "Update login endpoint"          ← too vague, worker will be blocked
   GOOD: "Add email format validation to login endpoint in src/api/auth.py"

━━━ BULK-DELETE EXAMPLE ━━━
If user asks to remove .bak files and project has 3 of them:
BAD — lazy single task:  {"task_graph":[{"id":"T1","description":"Delete all .bak files","model_role":"coder_cheap","file_path":"root"}]}
GOOD — one task per file: {"task_graph":[
  {"id":"T1","description":"Delete old.bak","model_role":"coder_cheap","file_path":"old.bak","dependencies":[]},
  {"id":"T2","description":"Delete backup.bak","model_role":"coder_cheap","file_path":"backup.bak","dependencies":[]}
]}`;

/**
 * Build the full prompt for Brain's deep decomposition call.
 * Mirrors BRAIN_PROMPT_TEMPLATE from coordinator.py / test_brain_decomposition.py.
 */
export function buildTaskGraphPrompt(
  task: string,
  projectContext: string,
  filePreviews: string,
): string {
  return [
    'You are a WORK ORDER DISPATCHER. Output ONLY JSON.',
    'Output ONLY the JSON object. Do NOT write anything before or after it.',
    '',
    `User request: ${task}`,
    '',
    'Project structure:',
    projectContext,
    '',
    'Relevant file previews:',
    filePreviews,
    '',
    TASK_GRAPH_INSTRUCTIONS,
    '',
    'Output JSON:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class TaskGraphParseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TaskGraphParseError';
  }
}

/**
 * Extract and parse the task_graph JSON from a raw Brain response.
 * Brain may wrap the JSON in prose — we search for the outermost { } block.
 */
export function parseTaskGraph(raw: string): TaskNode[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new TaskGraphParseError(
      `No JSON object found in Brain response. Got: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new TaskGraphParseError(
      `Invalid JSON: ${(err as SyntaxError).message}. Snippet: ${match[0].slice(0, 200)}`,
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>)['task_graph'])
  ) {
    throw new TaskGraphParseError(
      `Response must have a "task_graph" array. Got: ${JSON.stringify(Object.keys(parsed as object))}`,
    );
  }

  const raw_nodes = (parsed as { task_graph: unknown[] }).task_graph;
  const nodes: TaskNode[] = [];

  for (let i = 0; i < raw_nodes.length; i++) {
    const n = raw_nodes[i] as Record<string, unknown>;
    if (typeof n !== 'object' || n === null) {
      throw new TaskGraphParseError(`task_graph[${i}] is not an object`);
    }

    const id          = typeof n['id']          === 'string' ? n['id']          : `T${i + 1}`;
    const description = typeof n['description'] === 'string' ? n['description'] : '';
    const model_role  = typeof n['model_role']  === 'string' ? n['model_role']  : '';
    const file_path   = typeof n['file_path']   === 'string' ? n['file_path']   : '';
    const dependencies = Array.isArray(n['dependencies'])
      ? (n['dependencies'] as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];

    nodes.push({ id, description, model_role, file_path, dependencies });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const TASK_GRAPH_VALID_ROLES = new Set([
  'brain', 'coder_strong', 'coder_cheap', 'utility',
  'reviewer', 'narrator', 'planner_deep', 'debugger', 'reader',
]);

export const TASK_GRAPH_ACTION_VERBS = [
  'add', 'create', 'implement', 'delete', 'update', 'write', 'fix', 'refactor',
  'remove', 'replace', 'migrate', 'extract', 'move', 'rename', 'integrate',
  'configure', 'register', 'inject', 'extend', 'generate',
];

export const TASK_GRAPH_COMPLEXITY_KEYWORDS = [
  'function', 'class', 'endpoint', 'module', 'service', 'api', 'hook',
  'algorithm', 'implement', 'integration', 'auth', 'generate', 'test',
  'component', 'middleware', 'handler', 'route', 'schema', 'interface',
];

export const TASK_GRAPH_BLOCKER_BAIT = [
  'unclear', 'tbd', 'to be determined', 'not specified', 'as needed',
  'various', 'n/a', 'unknown details', 'some', 'etc.',
];

export const TASK_GRAPH_INVENTED_PATH_PATTERNS = [
  /^path[/\\]to[/\\]/i,
  /^exact[/\\]path[/\\]/i,
  /^your[/\\]/i,
  /^\/path[/\\]/i,
  /^path_to_/i,
];

export interface TaskGraphIssue {
  severity: 'FAIL' | 'WARN';
  task_id: string;
  rule: string;
  message: string;
  toString(): string;
}

export interface TaskGraphValidationResult {
  issues: TaskGraphIssue[];
  graph_issues: TaskGraphIssue[];
  passed: boolean;
}

function makeIssue(severity: 'FAIL' | 'WARN', task_id: string, rule: string, message: string): TaskGraphIssue {
  return {
    severity, task_id, rule, message,
    toString() { return `[${severity}] ${task_id}: ${rule} — ${message}`; },
  };
}

export class TaskGraphValidator {
  private readonly parentTask: string;
  private readonly minTasks: number;
  private readonly maxTasks: number;

  constructor(opts: { parentTask: string; minTasks?: number; maxTasks?: number }) {
    this.parentTask = opts.parentTask;
    this.minTasks   = opts.minTasks ?? 1;
    this.maxTasks   = opts.maxTasks ?? 20;
  }

  validate(nodes: TaskNode[]): TaskGraphValidationResult {
    const issues: TaskGraphIssue[] = [];
    const graph_issues: TaskGraphIssue[] = [];

    // ── Graph-level checks ───────────────────────────────────────────────────

    // Task count
    if (nodes.length < this.minTasks) {
      graph_issues.push(makeIssue('FAIL', 'GRAPH', 'task_count',
        `Expected at least ${this.minTasks} task(s), got ${nodes.length}`));
    }
    if (nodes.length > this.maxTasks) {
      graph_issues.push(makeIssue('WARN', 'GRAPH', 'task_count',
        `Expected at most ${this.maxTasks} task(s), got ${nodes.length}`));
    }

    // Duplicate IDs
    const seenIds = new Set<string>();
    for (const n of nodes) {
      if (seenIds.has(n.id)) {
        graph_issues.push(makeIssue('FAIL', n.id, 'duplicate_id',
          `Duplicate task ID "${n.id}"`));
      }
      seenIds.add(n.id);
    }

    // Dependency IDs must exist
    for (const n of nodes) {
      for (const dep of n.dependencies) {
        if (!seenIds.has(dep)) {
          graph_issues.push(makeIssue('FAIL', n.id, 'unknown_dependency',
            `Dependency "${dep}" does not exist in this task_graph`));
        }
      }
    }

    // ── Per-task checks ──────────────────────────────────────────────────────

    for (const n of nodes) {
      // 1. Description length
      if (n.description.length < 25) {
        issues.push(makeIssue('FAIL', n.id, 'description_too_short',
          `Description "${n.description}" is too short (${n.description.length} chars, min 25)`));
      }

      // 2. Action verb
      const firstWord = n.description.split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!TASK_GRAPH_ACTION_VERBS.includes(firstWord)) {
        issues.push(makeIssue('FAIL', n.id, 'no_action_verb',
          `Description must start with an action verb (Add, Create, Implement…), got "${firstWord}"`));
      }

      // 3. Blocker bait
      const descLower = n.description.toLowerCase();
      for (const bait of TASK_GRAPH_BLOCKER_BAIT) {
        if (descLower.includes(bait)) {
          issues.push(makeIssue('FAIL', n.id, 'blocker_bait',
            `Description contains vague blocker-bait phrase "${bait}"`));
          break;
        }
      }

      // 4. Echo of parent task
      const parentLower = this.parentTask.toLowerCase().slice(0, 60);
      if (descLower.startsWith(parentLower.slice(0, 40))) {
        issues.push(makeIssue('WARN', n.id, 'echo_of_parent',
          `Description looks like a mirror of the parent task — Brain may have just echoed input`));
      }

      // 5. Valid role
      if (!TASK_GRAPH_VALID_ROLES.has(n.model_role)) {
        issues.push(makeIssue('FAIL', n.id, 'invalid_role',
          `"${n.model_role}" is not a valid role. Valid: ${[...TASK_GRAPH_VALID_ROLES].join(', ')}`));
      }

      // 6. coder_strong complexity check
      if (n.model_role === 'coder_strong') {
        const isComplex =
          n.description.length > 60 ||
          TASK_GRAPH_COMPLEXITY_KEYWORDS.some((kw) => descLower.includes(kw));
        if (!isComplex) {
          issues.push(makeIssue('WARN', n.id, 'coder_strong_not_complex',
            `coder_strong task lacks complexity signals — consider coder_cheap for simple edits`));
        }
      }

      // 7. file_path validation
      if (!n.file_path || n.file_path.trim() === '') {
        issues.push(makeIssue('FAIL', n.id, 'missing_file_path', `file_path is empty or missing`));
      } else {
        const fp = n.file_path.trim();

        // Bare directory (ends with /)
        if (fp.endsWith('/') || fp.endsWith('\\')) {
          issues.push(makeIssue('FAIL', n.id, 'directory_file_path',
            `file_path "${fp}" is a directory — must be a full filename with extension`));
        }

        // "root" placeholder
        if (fp.toLowerCase() === 'root' || fp.toLowerCase() === 'root/') {
          issues.push(makeIssue('FAIL', n.id, 'root_file_path',
            `file_path "root" is forbidden — use a real path or UNKNOWN/<filename.ext>`));
        }

        // Invented path patterns
        for (const pattern of TASK_GRAPH_INVENTED_PATH_PATTERNS) {
          if (pattern.test(fp)) {
            issues.push(makeIssue('FAIL', n.id, 'invented_path',
              `file_path "${fp}" looks invented — use paths from project structure or UNKNOWN/`));
            break;
          }
        }

        // Must have a file extension (or be a wildcard bulk operation)
        const isWildcard = fp.includes('*');
        const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(fp.replace(/\*[^.]*$/, '').split('/').pop() ?? fp);
        if (!isWildcard && !hasExtension) {
          issues.push(makeIssue('WARN', n.id, 'no_file_extension',
            `file_path "${fp}" has no extension — expected a file like "foo.ts" or "UNKNOWN/foo.ts"`));
        }
      }
    }

    return {
      issues,
      graph_issues,
      passed: issues.filter((i) => i.severity === 'FAIL').length === 0 &&
              graph_issues.filter((i) => i.severity === 'FAIL').length === 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Sort task nodes so each task comes after all of its dependencies.
 * Throws TaskGraphParseError if there is a dependency cycle.
 * If a dependency references a missing task ID, it is silently ignored.
 */
export function topologicalSort(nodes: TaskNode[]): TaskNode[] {
  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  const adjList  = new Map(nodes.map((n) => [n.id, [] as string[]]));

  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!idToNode.has(dep)) continue; // skip unknown deps
      adjList.get(dep)!.push(n.id);
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const result: TaskNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(idToNode.get(id)!);
    for (const neighbour of adjList.get(id) ?? []) {
      const deg = (inDegree.get(neighbour) ?? 0) - 1;
      inDegree.set(neighbour, deg);
      if (deg === 0) queue.push(neighbour);
    }
  }

  if (result.length !== nodes.length) {
    throw new TaskGraphParseError(
      'task_graph contains a dependency cycle — cannot determine execution order',
    );
  }

  return result;
}
