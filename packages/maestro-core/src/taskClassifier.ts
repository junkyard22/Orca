/**
 * Task Classifier — Categorises incoming user requests into one of:
 * SMALL_EDIT, FEATURE, REFACTOR, PACKAGING, INFRASTRUCTURE, UNKNOWN.
 *
 * Uses heuristic keyword and structure signals. No LLM calls.
 * Pure function — no external dependencies.
 *
 * Extracted from maestro-vscode/src/taskClassifier.ts.
 */

import { TaskType, TaskClassification } from './types/orchestration';

// ============================================================================
// Pattern sets (order matters — first match wins for type, but impact
// is computed cumulatively)
// ============================================================================

const PACKAGING_PATTERNS: RegExp[] = [
  /\b(electron[-\s]?builder|electron[-\s]?forge|electron[-\s]?packager)\b/i,
  /\b(build|package|bundle)\b.*\b(installer|dmg|exe|appimage|nsis|snap|flatpak)\b/i,
  /\b(installer|packaging|electron)\b/i,
  /\bproduct\.json\b/i,
  /\bmain\.ts\b.*\b(entry\s*point|electron)\b/i,
  /\b(sign|notari[sz]e|code[\s-]?sign)\b/i,
];

const INFRASTRUCTURE_PATTERNS: RegExp[] = [
  /\b(ci[\s/]?cd|github[\s-]?actions|gitlab[\s-]?ci)\b/i,
  /\b(deploy|deployment)\b.*\b(server|cloud|prod|staging|heroku|vercel|aws|gcp|azure)\b/i,
  /\b(ci[\s/]?cd|build[\s-]?pipeline|deploy[\s-]?pipeline|release[\s-]?pipeline)\b/i,
  /\b(docker|kubernetes|k8s|helm|terraform|ansible)\b/i,
  /\b(nginx|apache|load[\s-]?balancer|ssl|certificate)\b/i,
  /\b(aws|gcp|azure|cloud)\b.*\b(setup|config|provision)\b/i,
  /\b(monitoring|alerting|logging[\s-]?infrastructure)\b/i,
];

const REFACTOR_PATTERNS: RegExp[] = [
  /\brefactor\b/i,
  /\bredesign\b/i,
  /\b(migrate|migration)\b/i,
  /\brestructur(e|ing)\b/i,
  /\b(split|separate|extract)\b.*\b(module|component|file|class|function)\b/i,
  /\brename\b.*\b(module|package|project|repo|namespace)\b/i,
  /\b(rewrite|overhaul|rearchitect)\b/i,
  /\b(convert|transform)\b.*\b(into|to|from)\b/i,
  /\bdesktop\s+app\b/i,
];

const FEATURE_PATTERNS: RegExp[] = [
  /\b(add|implement|create|build|introduce)\b.*\b(feature|module|component|system|service|page|endpoint)\b/i,
  /\bnew\s+(feature|module|component|api|endpoint|route)\b/i,
  /\bimplement\b/i,
  /\b(design|architect|propose)\b.*\b(architecture|system|framework)\b/i,
  /\bframework\b/i,
];

const SMALL_EDIT_PATTERNS: RegExp[] = [
  /\bfix\s+(typo|spelling|whitespace|indent)\b/i,
  /\b(add|remove)\s+(comment|logging|print|import)\b/i,
  /\brename\s+(variable|function|method|param|const|let)\b/i,
  /\b(lint|eslint|prettier|format)\b/i,
  /\bupdate\s+(version|constant|string|text|message)\b/i,
  /\b(typo|spelling)\b/i,
  /\bfix\s+style\b/i,
];

// ============================================================================
// Multi-step detection
// ============================================================================

const MULTI_STEP_SIGNALS: RegExp[] = [
  /;\s*(and\s+)?(then\s+)?/i,
  /\band\s+then\b/i,
  /\b(first|second|third|finally)\b.*\b(then|next)\b/i,
  /\d+\.\s+/,
  /\b(also|additionally|furthermore|plus)\b/i,
  /\bwith\b.*\band\b/i,
  /\bbefore\s+(coding|implementing|writing|starting)\b/i,
  /\band\b.*\band\b/i,
];

function detectMultiStep(task: string): boolean {
  const verbPhrases = task.match(/\b(add|create|implement|fix|update|remove|build|deploy|configure)\b/gi);
  if (verbPhrases && verbPhrases.length >= 3) {
    return true;
  }

  for (const pattern of MULTI_STEP_SIGNALS) {
    if (pattern.test(task)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Impact estimation
// ============================================================================

const IMPACT_KEYWORDS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\b(entire|whole|all|every)\b/i, weight: 0.3 },
  { pattern: /\bcodebase\b/i, weight: 0.3 },
  { pattern: /\b(multiple\s+files?|multi[\s-]?file)\b/i, weight: 0.2 },
  { pattern: /\b(breaking\s+change|major)\b/i, weight: 0.25 },
  { pattern: /\b(entry\s*point|main\.(ts|js)|index\.(ts|js))\b/i, weight: 0.2 },
  { pattern: /\b(product\.json|package\.json|tsconfig)\b/i, weight: 0.15 },
  { pattern: /\b(route|router|module|service)\b/i, weight: 0.1 },
  { pattern: /\b(framework|architecture|system\s+design)\b/i, weight: 0.2 },
  { pattern: /\b(redesign|rewrite|overhaul)\b/i, weight: 0.25 },
  { pattern: /\b(rigorous|reproducible|reliable|robust)\b/i, weight: 0.1 },
];

function estimateImpact(task: string): number {
  let impact = 0;

  for (const { pattern, weight } of IMPACT_KEYWORDS) {
    if (pattern.test(task)) {
      impact += weight;
    }
  }

  if (task.length > 500) {
    impact += 0.15;
  } else if (task.length > 200) {
    impact += 0.05;
  }

  return Math.min(1, impact);
}

// ============================================================================
// Main classifier
// ============================================================================

function matchType(task: string): TaskType {
  for (const p of PACKAGING_PATTERNS) {
    if (p.test(task)) { return TaskType.PACKAGING; }
  }

  for (const p of INFRASTRUCTURE_PATTERNS) {
    if (p.test(task)) { return TaskType.INFRASTRUCTURE; }
  }

  for (const p of REFACTOR_PATTERNS) {
    if (p.test(task)) { return TaskType.REFACTOR; }
  }

  for (const p of SMALL_EDIT_PATTERNS) {
    if (p.test(task)) { return TaskType.SMALL_EDIT; }
  }

  for (const p of FEATURE_PATTERNS) {
    if (p.test(task)) { return TaskType.FEATURE; }
  }

  return TaskType.UNKNOWN;
}

/**
 * Classify a user request into a TaskClassification.
 *
 * This is a pure, synchronous heuristic — no LLM calls.
 */
export function classifyTask(task: string): TaskClassification {
  const type = matchType(task);
  const estimatedImpact = estimateImpact(task);
  const multiStep = detectMultiStep(task);

  return { type, estimatedImpact, multiStep };
}
