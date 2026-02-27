/**
 * Plan Gate — Controls the plan-before-execute workflow.
 *
 * No direct dependencies on VS Code, Electron, or global singletons.
 * EventBus and Logger are injected at construction time.
 * Extracted from maestro-vscode/src/planGate.ts.
 */

import {
  RiskAssessment,
  StructuredPlan,
  PlanStep,
  PlanApprovalResult,
} from './types/orchestration';
import { EventBus } from './eventBus';
import { Logger } from './interfaces';

export class PlanGate {
  constructor(
    private eventBus: EventBus,
    private logger?: Logger,
  ) {}

  /**
   * Determine whether execution is gated for this risk assessment.
   */
  checkGate(riskAssessment: RiskAssessment): boolean {
    return riskAssessment.requiresPlan;
  }

  /**
   * Build a prompt that instructs the Brain to produce a StructuredPlan.
   */
  generatePlanPrompt(task: string): string {
    return `You are a senior architect performing a pre-execution comprehension check.

TASK FROM USER:
${task}

INSTRUCTIONS:
Before any code changes, you must produce a structured plan in JSON format.
This plan will be shown to the user for approval. No file mutations may occur
until the plan is approved.

Your plan MUST include:
1. **restatement** — Restate the user's intent in your own words. Be specific.
   If structural misunderstanding is possible (e.g., product composition vs rename),
   explicitly distinguish your interpretation.
2. **non_goals** — What this task is NOT about. Be explicit.
3. **assumptions** — What you assume to be true.
4. **ambiguities** — Anything unclear that could change the approach.
5. **affected_components** — Files, modules, or systems that will be touched.
6. **plan_steps** — Numbered steps with acceptance criteria for each.
7. **definition_of_done** — What must be true for this task to be considered complete.

RESPOND WITH ONLY the following JSON (no explanation, no markdown fences):

{
  "restatement": "...",
  "non_goals": ["..."],
  "assumptions": ["..."],
  "ambiguities": ["..."],
  "affected_components": ["..."],
  "plan_steps": [
    {
      "step": 1,
      "description": "...",
      "acceptance_criteria": ["..."]
    }
  ],
  "definition_of_done": ["..."]
}`;
  }

  /**
   * Parse a Brain response into a StructuredPlan.
   * Returns null if the response cannot be parsed or lacks required fields.
   */
  parsePlan(brainResponse: string): StructuredPlan | null {
    try {
      let cleaned = brainResponse.trim();
      const jsonFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonFenceMatch) {
        cleaned = jsonFenceMatch[1].trim();
      }

      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!objMatch) {
        this.logger?.warn('[PlanGate] No JSON object found in Brain response');
        return null;
      }

      const parsed = JSON.parse(objMatch[0]);

      if (!parsed.restatement || typeof parsed.restatement !== 'string') {
        this.logger?.warn('[PlanGate] Plan missing or invalid restatement');
        return null;
      }

      if (!Array.isArray(parsed.plan_steps) || parsed.plan_steps.length === 0) {
        this.logger?.warn('[PlanGate] Plan missing or empty plan_steps');
        return null;
      }

      const steps: PlanStep[] = parsed.plan_steps.map((s: Record<string, unknown>, i: number) => ({
        step: typeof s.step === 'number' ? s.step : i + 1,
        description: String(s.description || ''),
        acceptance_criteria: Array.isArray(s.acceptance_criteria)
          ? s.acceptance_criteria.map(String)
          : [],
      }));

      if (parsed.restatement.length < 20) {
        this.logger?.warn('[PlanGate] Restatement too short — possible false comprehension');
        return null;
      }

      const plan: StructuredPlan = {
        restatement: parsed.restatement,
        non_goals: Array.isArray(parsed.non_goals) ? parsed.non_goals.map(String) : [],
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
        ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities.map(String) : [],
        affected_components: Array.isArray(parsed.affected_components) ? parsed.affected_components.map(String) : [],
        plan_steps: steps,
        definition_of_done: Array.isArray(parsed.definition_of_done) ? parsed.definition_of_done.map(String) : [],
      };

      return plan;
    } catch (err) {
      this.logger?.error('[PlanGate] Failed to parse plan', err as Error);
      return null;
    }
  }

  /**
   * Emit plan events and record approval result.
   */
  recordApproval(plan: StructuredPlan, runId: string, result: PlanApprovalResult): void {
    switch (result) {
      case 'approved':
        this.eventBus.emit('plan:approved', { run_id: runId, plan });
        break;
      case 'rejected':
        this.eventBus.emit('plan:rejected', { run_id: runId, plan });
        break;
      case 'modified':
        this.eventBus.emit('plan:rejected', { run_id: runId, plan, reason: 'modified' });
        break;
      case 'clarification_needed':
        this.eventBus.emit('plan:rejected', { run_id: runId, plan, reason: 'clarification_needed' });
        break;
    }
  }

  /**
   * Record that a plan was generated.
   */
  recordGenerated(plan: StructuredPlan, runId: string): void {
    this.eventBus.emit('plan:generated', { run_id: runId, plan });
  }

  /**
   * Validate that a plan meets the "No False Comprehension" requirement.
   */
  validateComprehension(plan: StructuredPlan): { valid: boolean; reason?: string } {
    if (!plan.restatement || plan.restatement.length < 20) {
      return { valid: false, reason: 'Restatement is missing or too brief. Brain must clearly restate intent.' };
    }

    if (plan.plan_steps.length === 0) {
      return { valid: false, reason: 'No plan steps defined.' };
    }

    const stepsWithoutCriteria = plan.plan_steps.filter(s => s.acceptance_criteria.length === 0);
    if (stepsWithoutCriteria.length > 0) {
      return {
        valid: false,
        reason: `Steps ${stepsWithoutCriteria.map(s => s.step).join(', ')} lack acceptance criteria.`,
      };
    }

    return { valid: true };
  }
}
