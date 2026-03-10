import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContextStore } from './context/contextStore.js';
import { PlanReviewer } from './review/planReviewer.js';
import type { UserBrief, DeweyReview, BrainPlan, ObservedRun } from './types.js';

const DEFAULT_CONTEXT_PATH = join(homedir(), '.orca', 'userContext.json');

type TaskType = 'scheduling' | 'food' | 'communication' | 'work' | 'general';

function detectTaskType(task: string): TaskType {
  const t = task.toLowerCase();
  if (/scheduling|calendar|planning/.test(t)) return 'scheduling';
  if (/food|meal|recipe|dinner/.test(t)) return 'food';
  if (/email|message|communication/.test(t)) return 'communication';
  if (/code|coding|implement/.test(t)) return 'work';
  return 'general';
}

function detectTone(
  communicationPrefs: string[],
): UserBrief['suggestedTone'] {
  const joined = communicationPrefs.join(' ').toLowerCase();
  if (/\bbrief\b|\bshort\b/.test(joined)) return 'brief';
  if (/\bdetailed\b/.test(joined)) return 'detailed';
  if (/\bformal\b/.test(joined)) return 'formal';
  return 'casual';
}

export class Dewey {
  private store: ContextStore;
  private reviewer: PlanReviewer;

  constructor(contextPath?: string) {
    this.store = new ContextStore(contextPath ?? DEFAULT_CONTEXT_PATH);
    this.reviewer = new PlanReviewer(this.store);
  }

  async brief(task: string): Promise<UserBrief> {
    const context = await this.store.load();
    const taskType = detectTaskType(task);

    const { preferences, notes, availableApps } = this.store.getRelevantContext(taskType);
    const tone = detectTone(context.warm.preferences.communication);

    console.log(`[Dewey] Briefing for task type "${taskType}", tone "${tone}"`);

    return {
      userName: context.hot.name,
      timezone: context.hot.timezone,
      relevantPreferences: preferences,
      relevantContext: notes,
      availableApps,
      suggestedTone: tone,
    };
  }

  async reviewPlan(plan: BrainPlan, task: string): Promise<DeweyReview> {
    const brief = await this.brief(task);
    console.log('[Dewey] Running pre-flight review');
    return this.reviewer.review(plan, brief);
  }

  async observe(run: ObservedRun): Promise<void> {
    await this.store.load();

    // 1. Record task in session history (hot context)
    await this.store.recordTask(run.taskSummary);
    console.log(`[Dewey] Observed run: ${run.taskType} — ${run.verdict}`);

    // 2. Add new signals to warm context
    if (run.newSignals.length > 0) {
      const taskType = detectTaskType(run.taskType);
      for (const signal of run.newSignals) {
        await this.store.addSignal(signal, taskType);
      }
    }
  }

  async startSession(): Promise<void> {
    await this.store.load();
    await this.store.startSession();
  }
}
