export interface UserContext {
  hot: {
    name: string;
    timezone: string;
    currentSession: {
      startedAt: string;
      recentTasks: string[];
    };
  };

  warm: {
    preferences: {
      scheduling: string[];
      communication: string[];
      food: string[];
      work: string[];
      general: string[];
    };
    patterns: {
      commonTaskTypes: string[];
      peakHours: string[];
    };
    household: {
      notes: string[];
    };
    connectedApps: {
      gmail: boolean;
      outlook: boolean;
      calendar: boolean;
      [key: string]: boolean;
    };
  };
}

export interface UserBrief {
  userName: string;
  timezone: string;
  relevantPreferences: string[];
  relevantContext: string[];
  availableApps: string[];
  suggestedTone: 'brief' | 'detailed' | 'casual' | 'formal';
}

export interface DeweyReview {
  approved: boolean;
  concerns: string[];
  suggestions: string[];
}

export interface BrainPlan {
  steps: string[];
  toolsRequired: string[];
  estimatedDuration?: string;
  role: string;
}

export interface ObservedRun {
  taskType: string;
  taskSummary: string;
  timestamp: string;
  verdict: 'PASS' | 'WARN' | 'FAIL';
  preferencesApplied: string[];
  newSignals: string[];
}
