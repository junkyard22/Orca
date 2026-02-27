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

  // 5. Default
  logger?.info(`[RoleSelector] Selected: ${defaultRole} (default, no special triggers matched)`);
  return { role: defaultRole, isFallback: false };
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
