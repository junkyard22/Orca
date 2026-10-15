/**
 * Tool-call approvals between the main process and the approval card
 * (1.7.0 release stabilization, after live rehearsal A7).
 *
 * A7: the card offered "Always approve run_command this session". Once ticked,
 * the renderer approved every later run_command by itself — any command, not
 * the one the user had read. The main process accepted it: it could not tell
 * a person's decision from the renderer's own.
 *
 * Every approval is now bound to the request it answers, and the main process
 * decides whether it counts:
 *   - it must answer a pending request (a late, repeated or unknown answer
 *     authorizes nothing);
 *   - it must come while the requesting task is still running;
 *   - it must name the tool, and for run_command the exact command, that the
 *     card showed — approving `npm test` cannot approve `node --test` or
 *     anything else;
 *   - it must come no sooner than a person could have read the card
 *     (MIN_DECISION_MS) — an automatic "yes" is refused even if a renderer
 *     path reappears;
 *   - nothing persists: each call is decided on its own, and a restart starts
 *     with no approvals at all.
 * Deny, timeout and Stop all resolve the request as not approved.
 */

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** The task that asked; an answer after it stopped authorizes nothing. */
  taskId?: string;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  /** The tool and command the card displayed (echoed back by the renderer). */
  tool?: string;
  command?: string;
}

export interface ApprovalDecision {
  accepted: boolean;
  approved: boolean;
  reason: string;
}

export interface ApprovalBrokerOptions {
  send: (request: ApprovalRequest) => void;
  isTaskRunning: (taskId: string | undefined) => boolean;
  /** Told how every request was settled, so the card can show what actually happened. */
  onSettled?: (request: ApprovalRequest, approved: boolean, reason: string) => void;
  now?: () => number;
  timeoutMs?: number;
  minDecisionMs?: number;
  log?: (message: string) => void;
}

/** Faster than this, nobody read the card: the "yes" was not a person's. */
export const MIN_DECISION_MS = 400;
export const APPROVAL_TIMEOUT_MS = 60_000;

export function commandOf(args: Record<string, unknown>): string | undefined {
  return typeof args["command"] === "string" ? (args["command"] as string) : undefined;
}

export function createApprovalBroker(options: ApprovalBrokerOptions) {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const minDecisionMs = options.minDecisionMs ?? MIN_DECISION_MS;
  const log = options.log ?? (() => {});
  const pending = new Map<string, { request: ApprovalRequest; at: number; resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;

  function settle(id: string, approved: boolean, reason: string): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    log(`approval ${id} (${entry.request.tool}${commandOf(entry.request.args) ? ` ${commandOf(entry.request.args)}` : ""}): ${approved ? "approved" : "not approved"} — ${reason}`);
    entry.resolve(approved);
    options.onSettled?.(entry.request, approved, reason);
  }

  return {
    /** Ask for one call. Resolves true only for a valid decision by a person. */
    request(tool: string, args: Record<string, unknown>, taskId?: string): Promise<boolean> {
      const id = `tool_${now()}_${++seq}_${Math.random().toString(36).slice(2, 7)}`;
      const request: ApprovalRequest = { id, tool, args, ...(taskId ? { taskId } : {}) };
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(id, false, "timed out"), timeoutMs);
        pending.set(id, { request, at: now(), resolve, timer });
        options.send(request);
      });
    },

    /** The card's answer. Returns what was decided and why. */
    respond(response: ApprovalResponse): ApprovalDecision {
      const entry = pending.get(response.id);
      if (!entry) return { accepted: false, approved: false, reason: "no pending request with this id (late, repeated or unknown answer)" };
      const { request, at } = entry;
      if (!response.approved) { settle(request.id, false, "denied by the user"); return { accepted: true, approved: false, reason: "denied" }; }
      if (!options.isTaskRunning(request.taskId)) { settle(request.id, false, "the task is no longer running"); return { accepted: true, approved: false, reason: "task not running" }; }
      if (response.tool !== request.tool) { settle(request.id, false, `the answer names ${response.tool ?? "no tool"}, the request was ${request.tool}`); return { accepted: true, approved: false, reason: "tool mismatch" }; }
      const command = commandOf(request.args);
      if (command !== undefined && response.command !== command) { settle(request.id, false, "the answer does not name the command that was shown"); return { accepted: true, approved: false, reason: "command mismatch" }; }
      if (now() - at < minDecisionMs) { settle(request.id, false, `answered ${now() - at} ms after the card appeared — before a person could read it`); return { accepted: true, approved: false, reason: "too fast" }; }
      settle(request.id, true, "approved by the user");
      return { accepted: true, approved: true, reason: "approved" };
    },

    /** Stop, lock or shutdown: every pending request is not approved. */
    denyAll(reason: string): void {
      for (const id of [...pending.keys()]) settle(id, false, reason);
    },

    pendingCount(): number {
      return pending.size;
    },
  };
}

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
