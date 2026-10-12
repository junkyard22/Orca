/**
 * Desktop task session — who holds the task lock, and when it is released.
 *
 * The production bug: `chat:send` awaited `Promise.race([task, stopped])`, so
 * pressing Stop returned control (and released the lock) immediately while the
 * task's model streams, tool processes and approval dialogs were still running.
 * A new message could start on top of them, and their late results could act.
 *
 * Here the lock belongs to the *settlement* of the task, not to its reply:
 *
 *   - Stop is a request: the session moves to "cancelling", the abort signal
 *     fires, and the caller gets its reply right away.
 *   - The lock stays held until the task promise settles (every tracked
 *     operation ended, or the runtime gave up and marked it INTERRUPTED).
 *   - Only then can the next message begin. While the previous task is still
 *     stopping, `tryBegin` says so instead of starting another.
 *   - Approvals are bound to the session: a response to a dialog from a session
 *     that is no longer active authorizes nothing.
 *   - If settlement never comes (a tool that cannot be interrupted), a watchdog
 *     marks the session "interrupted", releases the lock and reports what was
 *     left running, so the user is not locked out forever but is told that the
 *     workspace may still change.
 */

export type TaskSessionState = "running" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted";

export interface TaskSession {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly state: TaskSessionState;
  /** Ask the task to stop. Returns at once; the lock is released when the task settles. */
  cancel(reason?: string): void;
  /** Resolves when the task promise settled or the watchdog gave up. */
  readonly settled: Promise<TaskSessionState>;
}

export interface TaskSessionManagerOptions {
  /** How long to wait for a cancelled task to settle before releasing the lock anyway. */
  interruptAfterMs?: number;
  now?: () => number;
  onInterrupted?: (session: { id: string; reason: string }) => void;
}

export interface BeginRefusal {
  ok: false;
  error: string;
}

export class TaskSessionManager {
  private active: (TaskSession & { settle: (state: TaskSessionState) => void; setState: (s: TaskSessionState) => void }) | null = null;
  private counter = 0;
  private readonly options: TaskSessionManagerOptions;

  constructor(options: TaskSessionManagerOptions = {}) {
    this.options = options;
  }

  /** The session holding the lock, if any. */
  get current(): TaskSession | null {
    return this.active;
  }

  /** Why a new task cannot start right now, or null when it can. */
  refusal(): BeginRefusal | null {
    const s = this.active;
    if (!s) return null;
    if (s.state === "cancelling") return { ok: false, error: "The previous task is still stopping — its operations have not all settled yet. Wait a moment and try again." };
    return { ok: false, error: "A task is already running. Stop it before sending a new message." };
  }

  /**
   * Take the lock and run `work`. The returned `reply` resolves with the
   * work's result or, on Stop, as soon as cancellation was requested; the lock
   * is held until `work` settles regardless.
   */
  begin<T>(work: (session: TaskSession) => Promise<T>, onStop: (reason: string) => T): { session: TaskSession; reply: Promise<T> } {
    const refusal = this.refusal();
    if (refusal) throw new Error(refusal.error);
    const controller = new AbortController();
    const id = `session-${Date.now().toString(36)}-${++this.counter}`;
    let state: TaskSessionState = "running";
    let settleResolve!: (s: TaskSessionState) => void;
    const settled = new Promise<TaskSessionState>((r) => { settleResolve = r; });
    let stopResolve: ((reason: string) => void) | undefined;
    const stopped = new Promise<string>((r) => { stopResolve = r; });
    let watchdog: NodeJS.Timeout | undefined;

    const session = {
      id,
      signal: controller.signal,
      get state() { return state; },
      settled,
      setState: (s: TaskSessionState) => { state = s; },
      settle: (s: TaskSessionState) => {
        if (watchdog) clearTimeout(watchdog);
        if (state === "running" || state === "cancelling") state = s;
        if (this.active === session) this.active = null;
        settleResolve(state);
      },
      cancel: (reason = "Stopped.") => {
        if (state !== "running") return;
        state = "cancelling";
        if (!controller.signal.aborted) controller.abort(new Error(reason));
        stopResolve?.(reason);
        const limit = this.options.interruptAfterMs ?? 30_000;
        watchdog = setTimeout(() => {
          if (state !== "cancelling") return;
          state = "interrupted";
          this.options.onInterrupted?.({ id, reason: `the task did not settle within ${limit} ms after Stop; its remaining operations may still change the workspace` });
          if (this.active === session) this.active = null;
          settleResolve(state);
        }, limit);
      },
    };
    this.active = session;

    const task = work(session).then(
      (value) => { session.settle(state === "cancelling" ? "cancelled" : "completed"); return value; },
      (error: unknown) => { session.settle(state === "cancelling" ? "cancelled" : "failed"); throw error; },
    );
    // The reply: the work's own outcome, or the stop acknowledgement — whichever
    // comes first. The lock is not part of this race.
    const reply = Promise.race([
      task,
      stopped.then((reason) => onStop(reason)),
    ]);
    return { session, reply };
  }

  /** Ask the active task to stop. Returns whether a task was running. */
  cancel(reason?: string): boolean {
    if (!this.active) return false;
    this.active.cancel(reason);
    return true;
  }
}
