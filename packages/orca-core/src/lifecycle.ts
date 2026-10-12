/**
 * Task lifecycle — the authoritative state of one task from intake to
 * settlement, owned by the runtime (Maestro's side of the contract) and
 * observable by everything else.
 *
 * The states answer two different questions that the old "Stopped." label
 * conflated: *what the task is doing* (PLANNING, RUNNING, WAITING_FOR_APPROVAL,
 * VERIFYING, REPAIRING) and *whether anything can still act on its behalf*.
 * Cancellation is therefore three things, kept apart:
 *
 *   cancel()      the request: the task moves to CANCELLING, no new model or
 *                 tool dispatch is allowed, active operations get the signal;
 *   settle        operations that are still running (a command being killed,
 *                 an MCP call that cannot be interrupted) are tracked until
 *                 they end; only then is the task CANCELLED;
 *   interrupt()   the drain gave up: the task is INTERRUPTED and the
 *                 operations that never settled are named, so nothing can
 *                 pretend the workspace is quiet.
 *
 * Terminal states (COMPLETED, FAILED, CANCELLED, INTERRUPTED) cannot be left:
 * a late event after the end is recorded as ignored, never applied.
 */

export type TaskState =
  | "CREATED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "VERIFYING"
  | "REPAIRING"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["CANCELLED", "COMPLETED", "FAILED", "INTERRUPTED"]);

/** Allowed transitions. Anything not listed is rejected and recorded. */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["PLANNING", "RUNNING", "VERIFYING", "CANCELLING", "FAILED"],
  PLANNING: ["RUNNING", "VERIFYING", "CANCELLING", "FAILED"],
  RUNNING: ["PLANNING", "WAITING_FOR_APPROVAL", "VERIFYING", "REPAIRING", "CANCELLING", "FAILED", "COMPLETED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "CANCELLING", "FAILED"],
  VERIFYING: ["REPAIRING", "COMPLETED", "FAILED", "CANCELLING"],
  REPAIRING: ["RUNNING", "WAITING_FOR_APPROVAL", "VERIFYING", "CANCELLING", "FAILED", "COMPLETED"],
  CANCELLING: ["CANCELLED", "INTERRUPTED"],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
  INTERRUPTED: [],
};

export type OperationKind = "model" | "tool" | "approval" | "verification" | "other";

export interface ActiveOperation {
  id: number;
  kind: OperationKind;
  label: string;
  startedAt: string;
  /** Whether the operation can be interrupted by the task's abort signal. */
  cancellable: boolean;
}

/**
 * Something outside this process that an operation started and could not
 * confirm stopped: a child process whose kill was requested but whose exit
 * never arrived. The operation itself has settled; the resource has not. A
 * task with a resource like this is not safely stopped, and the workspace it
 * can write to is not quiet.
 */
export interface UnsettledResource {
  kind: "process";
  pid: number;
  /** What was started (the command line, trimmed). */
  label: string;
  startedAt: string;
  /** Identity beyond the pid (creation time) when the host captured it, so a reused pid is not mistaken for the original. */
  identity?: string;
  reason: string;
}

/** Errors thrown by an operation may carry the resource it left behind. */
export function unsettledResourceOf(error: unknown): UnsettledResource | undefined {
  if (!error || typeof error !== "object") return undefined;
  const r = (error as { unsettledResource?: unknown }).unsettledResource;
  if (!r || typeof r !== "object") return undefined;
  const c = r as Partial<UnsettledResource>;
  if (c.kind !== "process" || typeof c.pid !== "number") return undefined;
  return {
    kind: "process",
    pid: c.pid,
    label: typeof c.label === "string" ? c.label : "process",
    startedAt: typeof c.startedAt === "string" ? c.startedAt : new Date().toISOString(),
    ...(typeof c.identity === "string" ? { identity: c.identity } : {}),
    reason: typeof c.reason === "string" ? c.reason : "the process had not exited when the operation gave up waiting",
  };
}

export interface TaskTransition {
  at: string;
  from: TaskState;
  to: TaskState;
  reason: string;
}

export interface TaskLifecycleSnapshot {
  taskId: string;
  state: TaskState;
  terminal: boolean;
  cancelRequested: boolean;
  cancelReason?: string;
  transitions: TaskTransition[];
  activeOperations: ActiveOperation[];
  /** Operations that were still active when the task was interrupted. */
  unsettledOperations: ActiveOperation[];
  /** External resources (child processes) that outlived their operation and were not confirmed gone. */
  unsettledResources: UnsettledResource[];
  /** Events that arrived after a terminal state and were ignored. */
  ignoredAfterEnd: Array<{ at: string; event: string }>;
}

export interface OperationHandle {
  readonly id: number;
  /** The operation ended (successfully or not). Idempotent. */
  end(): void;
}

export interface TaskLifecycleOptions {
  taskId: string;
  now?: () => Date;
  onChange?: (snapshot: TaskLifecycleSnapshot, transition?: TaskTransition) => void;
}

export class TaskLifecycle {
  readonly taskId: string;
  private state: TaskState = "CREATED";
  private readonly now: () => Date;
  private readonly listeners: Array<(snapshot: TaskLifecycleSnapshot, transition?: TaskTransition) => void> = [];
  private readonly transitions: TaskTransition[] = [];
  private readonly active = new Map<number, ActiveOperation>();
  private readonly unsettled: ActiveOperation[] = [];
  private readonly residues: UnsettledResource[] = [];
  private readonly ignored: Array<{ at: string; event: string }> = [];
  private nextOp = 0;
  private cancelRequestedFlag = false;
  private cancelReasonText?: string;
  private settleWaiters: Array<() => void> = [];

  constructor(options: TaskLifecycleOptions) {
    this.taskId = options.taskId;
    this.now = options.now ?? (() => new Date());
    if (options.onChange) this.listeners.push(options.onChange);
  }

  get current(): TaskState {
    return this.state;
  }

  get terminal(): boolean {
    return TERMINAL_TASK_STATES.has(this.state);
  }

  get cancelRequested(): boolean {
    return this.cancelRequestedFlag;
  }

  subscribe(listener: (snapshot: TaskLifecycleSnapshot, transition?: TaskTransition) => void): () => void {
    this.listeners.push(listener);
    return () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); };
  }

  private notify(transition?: TaskTransition): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s, transition);
  }

  /**
   * Move to `to` for `reason`. Returns false (and records the attempt) when
   * the move is not allowed — a terminal state is never left, and a stage
   * cannot skip the order of execution.
   */
  transition(to: TaskState, reason: string): boolean {
    if (this.state === to) return true;
    if (this.terminal) {
      this.ignored.push({ at: this.now().toISOString(), event: `${to} (${reason}) after ${this.state}` });
      return false;
    }
    if (!TRANSITIONS[this.state].includes(to)) {
      this.ignored.push({ at: this.now().toISOString(), event: `invalid ${this.state} -> ${to} (${reason})` });
      return false;
    }
    // Once cancellation is requested, only cancellation outcomes may follow.
    if (this.cancelRequestedFlag && to !== "CANCELLING" && to !== "CANCELLED" && to !== "INTERRUPTED") {
      this.ignored.push({ at: this.now().toISOString(), event: `${to} (${reason}) after cancellation was requested` });
      return false;
    }
    const t: TaskTransition = { at: this.now().toISOString(), from: this.state, to, reason };
    this.state = to;
    this.transitions.push(t);
    this.notify(t);
    return true;
  }

  /** Register an operation that acts for this task; call `end()` when it settles. */
  begin(kind: OperationKind, label: string, cancellable = true): OperationHandle {
    const id = ++this.nextOp;
    const op: ActiveOperation = { id, kind, label, startedAt: this.now().toISOString(), cancellable };
    this.active.set(id, op);
    this.notify();
    return {
      id,
      end: () => {
        if (!this.active.delete(id)) return;
        // An operation that outlived the task is still an operation: its end is
        // recorded (so the workspace can be declared quiet) but changes nothing.
        if (this.terminal) this.ignored.push({ at: this.now().toISOString(), event: `${op.kind} ${op.label} settled after ${this.state}` });
        this.notify();
        this.maybeSettle();
      },
    };
  }

  /**
   * Run `fn` as a tracked operation. An error carrying an `unsettledResource`
   * (a child process whose exit was never confirmed) ends the operation but
   * leaves the resource on record: the task cannot settle as CANCELLED while
   * something it started may still be running.
   */
  async track<T>(kind: OperationKind, label: string, fn: () => Promise<T>, cancellable = true): Promise<T> {
    const op = this.begin(kind, label, cancellable);
    try {
      return await fn();
    } catch (error) {
      const residue = unsettledResourceOf(error);
      if (residue) this.residues.push(residue);
      throw error;
    } finally {
      op.end();
    }
  }

  activeOperations(): ActiveOperation[] {
    return [...this.active.values()];
  }

  unsettledResources(): UnsettledResource[] {
    return [...this.residues];
  }

  /** A resource was verified gone (or the user took responsibility for it). */
  releaseResource(pid: number, reason: string): boolean {
    const index = this.residues.findIndex((r) => r.pid === pid);
    if (index < 0) return false;
    const [r] = this.residues.splice(index, 1);
    this.ignored.push({ at: this.now().toISOString(), event: `process ${r!.pid} (${r!.label}) released: ${reason}` });
    this.notify();
    this.maybeSettle();
    return true;
  }

  /** Nothing acting for this task is running, in this process or outside it. */
  get quiet(): boolean {
    return this.active.size === 0 && this.residues.length === 0;
  }

  /** Whether a new model or tool dispatch is allowed right now. */
  get mayDispatch(): boolean {
    return !this.cancelRequestedFlag && !this.terminal;
  }

  /**
   * Request cancellation. The task moves to CANCELLING; it becomes CANCELLED
   * once every active operation has ended. Repeated requests are idempotent.
   */
  cancel(reason = "cancelled"): void {
    if (this.terminal) {
      this.ignored.push({ at: this.now().toISOString(), event: `cancel (${reason}) after ${this.state}` });
      return;
    }
    if (this.cancelRequestedFlag) return;
    this.cancelRequestedFlag = true;
    this.cancelReasonText = reason;
    this.transition("CANCELLING", reason);
    this.maybeSettle();
  }

  private maybeSettle(): void {
    if (this.state !== "CANCELLING" || this.active.size > 0) return;
    if (this.residues.length > 0) {
      // Every operation ended, but one of them left a process it could not
      // confirm stopped: that is an interruption, not a clean stop.
      this.interrupt(`${this.cancelReasonText ?? "cancelled"}; operations settled but a process was not confirmed stopped`);
      return;
    }
    this.transition("CANCELLED", `${this.cancelReasonText ?? "cancelled"}; all operations settled`);
    for (const w of this.settleWaiters.splice(0)) w();
  }

  /**
   * Wait for the task to be quiet, up to `timeoutMs`. Resolves true when
   * every operation settled and no resource is outstanding, false when the
   * timeout passed with operations still active or a resource unconfirmed.
   */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.quiet) return Promise.resolve(true);
    if (this.active.size === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      let unsub = () => {};
      const finish = (settled: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(settled);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      unsub = this.subscribe(() => {
        if (this.quiet) finish(true);
        else if (this.active.size === 0) finish(false);
      });
    });
  }

  /** The drain gave up: name what never settled and end the task as INTERRUPTED. */
  interrupt(reason: string): void {
    if (this.terminal) return;
    this.unsettled.push(...this.active.values());
    if (this.state !== "CANCELLING") {
      this.cancelRequestedFlag = true;
      this.cancelReasonText = reason;
      this.transition("CANCELLING", reason);
    }
    const ops = this.unsettled.map((o) => `${o.kind} ${o.label}`);
    const procs = this.residues.map((r) => `process ${r.pid} (${r.label})`);
    this.transition("INTERRUPTED", `${reason}; ${this.unsettled.length} operation(s) never settled: ${ops.join(", ") || "none"}${procs.length ? `; not confirmed stopped: ${procs.join(", ")}` : ""}`);
  }

  /** End the task from the runtime's result. Refused after cancellation (the cancellation outcome wins). */
  finish(outcome: "COMPLETED" | "FAILED", reason: string): boolean {
    return this.transition(outcome, reason);
  }

  snapshot(): TaskLifecycleSnapshot {
    return {
      taskId: this.taskId,
      state: this.state,
      terminal: this.terminal,
      cancelRequested: this.cancelRequestedFlag,
      ...(this.cancelReasonText ? { cancelReason: this.cancelReasonText } : {}),
      transitions: [...this.transitions],
      activeOperations: [...this.active.values()],
      unsettledOperations: [...this.unsettled],
      unsettledResources: [...this.residues],
      ignoredAfterEnd: [...this.ignored],
    };
  }
}
