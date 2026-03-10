import type { ContextStore } from '../context/contextStore.js';
import type { BrainPlan, UserBrief, DeweyReview } from '../types.js';

const BLOCKING_SCHEDULING_KEYWORDS = [
  'no meetings before',
  'evenings free',
  'blocked',
  'unavailable',
];

// Simple time-mention pattern (e.g. "9am", "6 pm", "18:00", "morning", "evening")
const TIME_MENTION_RE = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|evening|night|afternoon|\d{2}:\d{2})\b/i;

export class PlanReviewer {
  constructor(private store: ContextStore) {}

  async review(plan: BrainPlan, brief: UserBrief): Promise<DeweyReview> {
    const concerns: string[] = [];
    const suggestions: string[] = [];

    // 1. App access check
    const connectedApps = new Set(brief.availableApps.map((a) => a.toLowerCase()));
    for (const tool of plan.toolsRequired) {
      const t = tool.toLowerCase();
      if (t === 'gmail' || t === 'calendar' || t === 'outlook') {
        if (!connectedApps.has(t)) {
          concerns.push(`Plan requires ${tool} but it is not connected`);
          suggestions.push(`Connect ${tool} in Orca settings to enable this`);
        }
      }
    }

    // 2. Scheduling conflict check
    const taskType = plan.role.toLowerCase();
    if (/scheduling|calendar|planning/.test(taskType)) {
      const schedulingPrefs = brief.relevantPreferences;
      for (const pref of schedulingPrefs) {
        const prefLower = pref.toLowerCase();
        const isBlocking = BLOCKING_SCHEDULING_KEYWORDS.some((kw) => prefLower.includes(kw));
        if (isBlocking) {
          const stepsWithTime = plan.steps.filter((s) => TIME_MENTION_RE.test(s));
          if (stepsWithTime.length > 0) {
            concerns.push(
              `Scheduling preference "${pref}" may conflict with planned steps: ${stepsWithTime.join('; ')}`,
            );
            suggestions.push(`Review timing of steps against your scheduling preference: "${pref}"`);
          }
        }
      }
    }

    // 3. Preference alignment check
    for (const pref of brief.relevantPreferences) {
      const prefLower = pref.toLowerCase();
      // Extract keyword to check (first 3 significant words)
      const prefWords = prefLower.split(/\s+/).filter((w) => w.length > 3);
      for (const step of plan.steps) {
        const stepLower = step.toLowerCase();
        // Look for negation of a preference keyword in the step
        for (const word of prefWords) {
          if (stepLower.includes(`no ${word}`) || stepLower.includes(`avoid ${word}`) || stepLower.includes(`don't ${word}`)) {
            concerns.push(`Step "${step}" may contradict preference: "${pref}"`);
            suggestions.push(`Consider adjusting this step to align with your preference: "${pref}"`);
            break;
          }
        }
      }
    }

    const approved = concerns.length === 0;
    if (approved) {
      console.log('[Dewey] Pre-flight review: approved');
    } else {
      console.log('[Dewey] Pre-flight review: rejected with concerns:', concerns);
    }

    return { approved, concerns, suggestions };
  }
}
