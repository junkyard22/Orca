export interface PreferenceBuckets {
  scheduling: string[];
  communication: string[];
  food: string[];
  work: string[];
  general: string[];
}

export type ContextFileKind = 'file' | 'folder';

export interface ContextRepositoryResource {
  id: string;
  kind: 'repository';
  locator: string;
  label: string;
  branch?: string;
}

export interface ContextWorkspace {
  rootPath: string;
  label: string;
  repository?: ContextRepositoryResource;
}

export interface ContextFileResource {
  id: string;
  kind: ContextFileKind;
  path: string;
  label: string;
}

export interface ContextTaskResource {
  id: string;
  kind: 'task';
  reference: string;
  label: string;
}

export interface ContextConnectorResource {
  id: string;
  kind: 'connector';
  connectorId: string;
  label: string;
  available: boolean;
}

export interface ContextUrlResource {
  id: string;
  kind: 'url';
  url: string;
  label: string;
}

export interface ContextPreviousRunResource {
  id: string;
  kind: 'previous_run';
  runId: string;
  label: string;
}

/**
 * Dewey-owned resource metadata for the active workspace.
 *
 * This intentionally contains references only. Resource contents are fetched
 * lazily by tools so reads and writes continue through Miranda's gates.
 */
export interface ContextManifest {
  version: 1;
  workspace?: ContextWorkspace;
  files: ContextFileResource[];
  tasks: ContextTaskResource[];
  connectors: ContextConnectorResource[];
  urls: ContextUrlResource[];
  previousRuns: ContextPreviousRunResource[];
  updatedAt: string;
}

export type ContextManifestAction =
  | { type: 'set_workspace'; rootPath: string; label?: string; at?: string }
  | { type: 'attach_repository'; locator: string; label?: string; branch?: string; at?: string }
  | { type: 'attach_file'; path: string; label?: string; fileKind?: ContextFileKind; at?: string }
  | { type: 'attach_task'; reference: string; label?: string; at?: string }
  | { type: 'attach_connector'; connectorId: string; label?: string; available?: boolean; at?: string }
  | { type: 'attach_url'; url: string; label?: string; at?: string }
  | { type: 'attach_previous_run'; runId: string; label?: string; at?: string }
  | { type: 'remove'; resourceId: string; at?: string }
  | { type: 'sync_connectors'; connectors: Array<{ id: string; label: string; available: boolean }>; at?: string }
  | { type: 'clear'; preserveWorkspace?: boolean; at?: string };

export interface ContextManifestBrief {
  summary: string;
  lines: string[];
  counts: {
    workspaces: number;
    repositories: number;
    files: number;
    tasks: number;
    connectors: number;
    urls: number;
    previousRuns: number;
  };
}

export interface UserContext {
  hot: {
    name: string;
    timezone: string;
    currentSession: {
      startedAt: string;
      recentTasks: string[];
      manifest: ContextManifest;
    };
  };

  warm: {
    learnedPreferences: PreferenceBuckets;
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
  resourceBrief: ContextManifestBrief;
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
