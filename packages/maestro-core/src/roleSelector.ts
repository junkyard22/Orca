/**
 * Role Selector - Deterministic Role Selection with Fallbacks.
 *
 * No external dependencies. Logger is optional.
 * Extracted from maestro-vscode/src/roleSelector.ts.
 */

import { Logger } from './interfaces';

// ============================================================================
// Role Type Definitions
// ============================================================================

export type CoreRoleName = 'brain' | 'coder_strong' | 'coder_cheap' | 'utility' | 'reviewer' | 'narrator';
export type OptionalRoleName = 'planner_deep' | 'debugger' | 'reader' | 'vision';
export type RoleName = CoreRoleName | OptionalRoleName;

// ============================================================================
// Role Metadata
// ============================================================================

export interface RoleMetadata {
  purpose: string;
  trigger: string;
  fallback: CoreRoleName;
}

export const OPTIONAL_ROLE_METADATA: Record<OptionalRoleName, RoleMetadata> = {
  planner_deep: {
    purpose: 'Careful planning for risky/big changes involving multiple files or refactors',
    trigger: 'Task involves multi-file changes, refactor keywords, migrations, or user selects "Deep Plan"',
    fallback: 'brain'
  },
  debugger: {
    purpose: 'Diagnose build, test, lint, or runtime failures with detailed analysis',
    trigger: 'TypeScript/test/lint/command failure output detected',
    fallback: 'coder_strong'
  },
  reader: {
    purpose: 'Summarize long documents, logs, or files into actionable tasks',
    trigger: 'Large pasted text/logs (>2000 chars), large file summaries, document ingestion',
    fallback: 'narrator'
  },
  vision: {
    purpose: 'Interpret screenshots, images, diagrams, or visual content',
    trigger: 'User input includes images or visual content',
    fallback: 'brain'
  }
};

// ============================================================================
// Task Context for Role Selection
// ============================================================================

export interface TaskContext {
  task: string;
  filePath?: string;
  fileCount?: number;
  hasImages?: boolean;
  errorOutput?: string;
  textLength?: number;
  isDeepPlanRequested?: boolean;
}

// ============================================================================
// Role Selection Logic
// ============================================================================

/**
 * Select the appropriate role based on task context and available roles.
 */
export function selectRole(
  context: TaskContext,
  availableOptionalRoles: Set<OptionalRoleName>,
  defaultRole: CoreRoleName = 'brain',
  logger?: Logger,
): { role: RoleName; isFallback: boolean; warning?: string } {
  // 1. VISION
  if (context.hasImages) {
    if (availableOptionalRoles.has('vision')) {
      logger?.info('[RoleSelector] Selected: vision (images detected)');
      return { role: 'vision', isFallback: false };
    } else {
      const fallback = OPTIONAL_ROLE_METADATA.vision.fallback;
      const warning = 'Images detected but vision role not configured. Using fallback. Configure a vision-capable model for better image understanding.';
      logger?.warn(`[RoleSelector] ${warning}`);
      return { role: fallback, isFallback: true, warning };
    }
  }

  // 2. DEBUGGER
  if (context.errorOutput && context.errorOutput.length > 100) {
    const hasCompileError = /error TS\d+:|SyntaxError:|Error:/i.test(context.errorOutput);
    const hasTestFailure = /FAIL|failed|Error in|Test suite failed/i.test(context.errorOutput);
    const hasLintError = /ESLint|Lint error|warning:/i.test(context.errorOutput);

    if (hasCompileError || hasTestFailure || hasLintError) {
      if (availableOptionalRoles.has('debugger')) {
        logger?.info('[RoleSelector] Selected: debugger (error output detected)');
        return { role: 'debugger', isFallback: false };
      } else {
        const fallback = OPTIONAL_ROLE_METADATA.debugger.fallback;
        logger?.info(`[RoleSelector] Error detected but debugger role not configured. Using fallback: ${fallback}`);
        return { role: fallback, isFallback: true };
      }
    }
  }

  // 3. READER
  if (context.textLength && context.textLength > 2000) {
    if (availableOptionalRoles.has('reader')) {
      logger?.info('[RoleSelector] Selected: reader (large text input detected)');
      return { role: 'reader', isFallback: false };
    } else {
      const fallback = OPTIONAL_ROLE_METADATA.reader.fallback;
      logger?.info(`[RoleSelector] Large text detected but reader role not configured. Using fallback: ${fallback}`);
      return { role: fallback, isFallback: true };
    }
  }

  // 4. PLANNER_DEEP
  const isRiskyChange = (
    context.isDeepPlanRequested ||
    (context.fileCount !== undefined && context.fileCount > 3) ||
    /refactor|migration|migrate|restructure|breaking change|major change/i.test(context.task)
  );

  if (isRiskyChange) {
    if (availableOptionalRoles.has('planner_deep')) {
      logger?.info('[RoleSelector] Selected: planner_deep (risky/complex change detected)');
      return { role: 'planner_deep', isFallback: false };
    } else {
      const fallback = OPTIONAL_ROLE_METADATA.planner_deep.fallback;
      logger?.info(`[RoleSelector] Risky change detected but planner_deep role not configured. Using fallback: ${fallback}`);
      return { role: fallback, isFallback: true };
    }
  }

  // 5. Core role selection based on task content
  const coreRole = pickCoreRole(context.task);
  logger?.info(`[RoleSelector] Selected: ${coreRole} (pattern-based routing)`);
  return { role: coreRole, isFallback: false };
}

// ============================================================================
// Core Role Pattern Matching
// ============================================================================

/**
 * Pick a core role based on task keywords and patterns.
 *
 * Rules:
 * - Writing/creative tasks → narrator
 * - Planning/decomposition tasks → brain (for routing only, not execution)
 * - Coding tasks → coder_strong or coder_cheap
 * - Review/audit tasks → reviewer
 * - Cleanup/formatting tasks → utility
 *
 * Fallback is 'narrator' for general tasks that don't match other patterns.
 * Brain is NEVER returned as a fallback — it is only used for explicit planning requests.
 */
export function pickCoreRole(task: string): CoreRoleName {
  const lowerTask = task.toLowerCase();
  
  // NARRATOR — writing, creative, documentation, explanations
  const narratorPatterns = [
    /\bwrite\s+(a\s+)?(song|poem|story|essay|letter|email|article|post|message)\b/i,
    /\b(compose|draft|create)\b.*\b(writing|content|copy|message|document)\b/i,
    /\b(describe|explain|summarize)\b/i,
    /\b(documentation|readme|doc|guide|tutorial)\b/i,
    /\b(creative|writing|narrative|prose)\b/i,
    /\b(translat[e|ing])\b/i,
    /\b(edit|proofread|revise)\b.*\b(text|writing|content|document)\b/i,
  ];
  
  for (const pattern of narratorPatterns) {
    if (pattern.test(task)) {
      return 'narrator';
    }
  }
  
  // BRAIN — planning, decomposition, orchestration ONLY (not execution)
  const brainPatterns = [
    /\b(plan|schedule|organize)\b/i,
    /\b(break\s+down|decompose)\b/i,
    /\b(steps?\s+for|approach\s+to|strategy\s+for)\b/i,
    /\b(roadmap|timeline|phases?)\b/i,
  ];
  
  for (const pattern of brainPatterns) {
    if (pattern.test(task)) {
      return 'brain';
    }
  }
  
  // REVIEWER — code review, audit, critique, quality check
  const reviewerPatterns = [
    /\b(review|audit|critique|analyze)\b.*\b(code|implementation|pr|pull\s+request)\b/i,
    /\b(quality\s+check|qa|test\s+review)\b/i,
    /\b(find\s+(bugs?|issues?|problems?|errors?)\b)/i,
    /\b(security\s+review|vulnerability|audit)\b/i,
  ];
  
  for (const pattern of reviewerPatterns) {
    if (pattern.test(task)) {
      return 'reviewer';
    }
  }
  
  // CODER_STRONG — complex coding, implementation, multi-file
  const coderStrongPatterns = [
    /\b(implement|build|create|develop)\b.*\b(feature|module|component|system|service|api|endpoint)\b/i,
    /\b(complex|multi-file|full-stack|end-to-end)\b/i,
    /\b(architecture|design\s+pattern|refactor)\b/i,
    /\b(test|unit\s+test|integration\s+test)\b.*\b(write|create|add)\b/i,
    /\b(migrate|migration|convert)\b.*\b(code|implementation)\b/i,
  ];
  
  for (const pattern of coderStrongPatterns) {
    if (pattern.test(task)) {
      return 'coder_strong';
    }
  }
  
  // CODER_CHEAP — simple edits, formatting, small fixes
  const coderCheapPatterns = [
    /\bfix\s+(typo|bug|error|issue)\b/i,
    /\b(add|remove)\s+(import|comment|log|field|property)\b/i,
    /\b(rename|reformat|format)\b/i,
    /\b(small|simple|quick|minor)\b.*\b(change|fix|edit|update)\b/i,
  ];
  
  for (const pattern of coderCheapPatterns) {
    if (pattern.test(task)) {
      return 'coder_cheap';
    }
  }
  
  // UTILITY — lint, format, convert, transform, cleanup
  const utilityPatterns = [
    /\b(lint|eslint|prettier|format)\b/i,
    /\b(clean\s+up|cleanup|tidy)\b/i,
    /\b(convert|transform)\b.*\b(format|type|json|yaml|csv)\b/i,
    /\b(remove|delete)\b.*\b(unused|dead\s+code|console\.log)\b/i,
  ];
  
  for (const pattern of utilityPatterns) {
    if (pattern.test(task)) {
      return 'utility';
    }
  }
  
  // FALLBACK: narrator for general tasks that don't match other patterns
  // Brain is NOT used as fallback — brain is only for explicit planning requests
  return 'narrator';
}

/**
 * Get available optional roles from effective config.
 */
export function getAvailableOptionalRoles(
  roleConfigs: Partial<Record<RoleName, { configured: boolean; hasKey: boolean }>>
): Set<OptionalRoleName> {
  const available = new Set<OptionalRoleName>();

  const optionalRoles: OptionalRoleName[] = ['planner_deep', 'debugger', 'reader', 'vision'];
  for (const role of optionalRoles) {
    const config = roleConfigs[role];
    if (config && config.configured && config.hasKey) {
      available.add(role);
    }
  }

  return available;
}

export function isOptionalRole(role: RoleName): role is OptionalRoleName {
  return ['planner_deep', 'debugger', 'reader', 'vision'].includes(role);
}

export function getCoreRoles(): CoreRoleName[] {
  return ['brain', 'coder_strong', 'coder_cheap', 'utility', 'reviewer', 'narrator'];
}

export function getOptionalRoles(): OptionalRoleName[] {
  return ['planner_deep', 'debugger', 'reader', 'vision'];
}

export function getAllRoles(): RoleName[] {
  return [...getCoreRoles(), ...getOptionalRoles()];
}
