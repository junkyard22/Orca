/**
 * Risk Scorer — Computes a composite risk score from a TaskClassification
 * and determines whether a structured plan is mandatory.
 *
 * Pure function — no external dependencies.
 * Extracted from maestro-vscode/src/riskScorer.ts.
 */

import { TaskClassification, TaskType, RiskAssessment } from './types/orchestration';

// ============================================================================
// Type-based base weights
// ============================================================================

const TYPE_WEIGHTS: Record<TaskType, number> = {
  [TaskType.PACKAGING]:       0.8,
  [TaskType.INFRASTRUCTURE]:  0.8,
  [TaskType.REFACTOR]:        0.7,
  [TaskType.FEATURE]:         0.4,
  [TaskType.SMALL_EDIT]:      0.1,
  [TaskType.UNKNOWN]:         0.3,
};

const MULTI_STEP_BONUS = 0.2;

// ============================================================================
// Scorer
// ============================================================================

/**
 * Compute a risk assessment from a task classification.
 *
 * Risk score formula:
 *   score = clamp(0, 1, typeWeight * 0.5 + estimatedImpact * 0.3 + multiStepBonus * 0.2)
 *
 * requiresPlan hard rules override the score threshold.
 */
export function scoreRisk(classification: TaskClassification): RiskAssessment {
  const typeWeight = TYPE_WEIGHTS[classification.type];
  const multiStepContribution = classification.multiStep ? MULTI_STEP_BONUS : 0;

  const raw =
    typeWeight * 0.5 +
    classification.estimatedImpact * 0.3 +
    multiStepContribution;

  const riskScore = Math.min(1, Math.max(0, raw));

  let requiresPlan = false;

  if (classification.type === TaskType.PACKAGING) {
    requiresPlan = true;
  } else if (classification.type === TaskType.REFACTOR) {
    requiresPlan = true;
  } else if (classification.multiStep) {
    requiresPlan = true;
  } else if (riskScore >= 0.6) {
    requiresPlan = true;
  }

  return { riskScore, requiresPlan };
}
