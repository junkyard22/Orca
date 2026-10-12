/**
 * Start-up recovery — what a previous Orca process left behind, said
 * plainly, and recorded. Pure: the Electron init path feeds it what the
 * budget journal and the workspace guard recovered and shows / stores what
 * comes back. Nothing here resumes a task, repeats a request, or releases a
 * workspace; the guard decides releases, and only by verification.
 */
import type { RunRecord, UnresolvedBudgetTask, WorkspaceProtection, WorkspaceRelease } from "@clawde/orca-core";

export interface RecoveryInput {
  /** Tasks the budget journal found open (reservations never reconciled). */
  unresolvedBudget: UnresolvedBudgetTask[];
  /** What the workspace guard recovered from its file. */
  guard: { kept: WorkspaceProtection[]; released: WorkspaceRelease[] };
  /** Recovery text for the kept protections (guard.describe). */
  describe: (protections: WorkspaceProtection[]) => string;
  /** The journal or the protection file could not be read fully. */
  corrupt?: Array<{ what: string; error: string }>;
}

export interface RecoveryOutput {
  warnings: string[];
  /** Interrupted runs to record in the history: FAIL / interrupted, cost as an upper bound. */
  runs: RunRecord[];
}

export function recoveryWarnings(input: RecoveryInput): RecoveryOutput {
  const warnings: string[] = [];
  const runs: RunRecord[] = [];

  for (const unresolved of input.unresolvedBudget) {
    const summary = `Interrupted: Orca stopped while this task was running (${unresolved.snapshot.requests.inFlight} model request(s) in flight, started ${unresolved.startedAt}). Up to $${unresolved.exposureUsd.toFixed(4)} may have been charged without being reconciled. Nothing was resumed; check the workspace before continuing.`;
    warnings.push(`A previous session ended with task ${unresolved.taskId} still running: ${summary}`);
    runs.push({
      id: unresolved.taskId,
      createdAt: unresolved.startedAt,
      intent: "(interrupted before completion)",
      status: "FAIL",
      stoppedBecause: "interrupted",
      summary,
      costUnreconciledUsd: unresolved.exposureUsd,
      costBasis: "upper_bound",
    } as RunRecord);
  }

  for (const release of input.guard.released) {
    warnings.push(`Workspace ${release.root} was left protected by task ${release.taskId} and is released: ${release.reason}. Review the workspace for partial changes before continuing.`);
  }
  if (input.guard.kept.length > 0) {
    const unknown = input.guard.kept.filter((p) => p.resources.length > 0);
    warnings.push(input.describe(input.guard.kept));
    if (unknown.length > 0) {
      warnings.push(`${unknown.length} workspace(s) stay protected because a process a previous task started could not be confirmed gone (${unknown.flatMap((p) => p.resources.map((r) => `pid ${r.pid}`)).join(", ")}). Unknown is not safe: nothing will run there until the process is verified gone or you override, which is recorded as your decision.`);
    }
  }
  for (const c of input.corrupt ?? []) {
    warnings.push(`${c.what} could not be read (${c.error}). What it recorded is unknown: treat any task that was running when Orca last closed as unreconciled, and check the workspace before continuing.`);
  }
  return { warnings, runs };
}
