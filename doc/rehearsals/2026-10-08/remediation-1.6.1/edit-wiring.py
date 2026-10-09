from pathlib import Path
root=Path(__file__).resolve().parents[4]
def edit(file, fn):
 p=root/file
 old=p.read_text(encoding='utf-8')
 new=fn(old)
 if new==old: raise RuntimeError(f'No edit applied to {file}')
 p.write_text(new,encoding='utf-8',newline='')
def renderer(s):
 s=s.replace('approveToolCall:   () => {},','onToolApprovalStatus: () => () => {},')
 s=s.replace('    if (id) orca.approveToolCall(id, false);','    if (id && busy) orca.abortTask();')
 start=s.index('// Tools the user has permanently approved for this session')
 end=s.index('// ── Chat session sidebar',start)
 s=s[:start]+'''// The native main-process dialog owns decisions. This renderer only displays
// pending/status receipts and supplies a Stop control; it cannot approve.
let approvalTimerInterval = null;
const APPROVAL_TIMEOUT_S = 60;
function clearApprovalTimer() {
  if (approvalTimerInterval) { clearInterval(approvalTimerInterval); approvalTimerInterval = null; }
  const el = document.getElementById('approval-timer');
  if (el) el.textContent = '';
}
orca.onToolRequest((id, tool, args) => {
  if (!tool) return;
  toolCallCards.set(id, appendToolCard(id, tool, args));
  const dialog = document.getElementById('tool-approval-dialog');
  document.getElementById('approval-tool-name').textContent = tool;
  document.getElementById('approval-args').textContent = formatToolRequestSummary(tool, args);
  dialog.dataset.approvalId = id;
  dialog.style.display = 'flex';
  demoWatchdogPause();
  clearApprovalTimer();
  let remaining = APPROVAL_TIMEOUT_S;
  const tick = () => { document.getElementById('approval-timer').textContent = remaining > 0 ? `${remaining--}s` : 'Approval timed out — stopping'; };
  tick(); approvalTimerInterval = setInterval(tick, 1000);
});
orca.onToolApprovalStatus(({ id, outcome }) => {
  const card = toolCallCards.get(id);
  if (card) {
    card.classList.replace('pending', outcome === 'approved' ? 'approved' : 'denied');
    card.querySelector('.tool-card-status').textContent = outcome === 'timeout' ? 'Approval timed out — command did not execute' : outcome;
  }
  toolCallCards.delete(id);
  const dialog = document.getElementById('tool-approval-dialog');
  if (dialog.dataset.approvalId === id) { clearApprovalTimer(); dialog.style.display = 'none'; }
  demoHeartbeat();
});
document.getElementById('btn-deny-tool').addEventListener('click', () => orca.abortTask());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && busy) { event.preventDefault(); orca.abortTask(); }
});

'''+s[end:]
 return s
edit(Path('apps/desktop/renderer/app.js'),renderer)
def shared(s):
 a=s.index('// Neutral placeholders')
 b=s.index('export function parseToolCalls',a)
 s=s[:a]+'''function throwIfCancelled(ctx: OrcaRunCtx): void {
  if (ctx.abortSignal?.aborted) { const e = new Error(String(ctx.abortSignal.reason?.message ?? ctx.abortSignal.reason ?? 'Cancelled.')); e.name = 'AbortError'; throw e; }
}
function budgetContext(ctx: OrcaRunCtx) {
  const budget = ctx.getBudgetSnapshot?.();
  return { budgetUsed: budget ? budget.spentUsd + budget.reservedUsd : 0, budgetLimit: budget?.limitUsd ?? Infinity };
}

'''+s[b:]
 s=s.replace('...NEUTRAL_LLM_BUDGET_CONTEXT,','...budgetContext(ctx),')
 s=s.replace('  for (let i = 0; i < MAX_ITERATIONS; i++) {','  for (let i = 0; i < MAX_ITERATIONS; i++) {\n    throwIfCancelled(ctx);')
 s=s.replace('{ maxTokens: 4096, simple: true }','{ maxTokens: 4096, simple: true, abortSignal: ctx.abortSignal }')
 s=s.replace('    lastText = text;','    throwIfCancelled(ctx);\n    lastText = text;')
 s=s.replace('await tools.execute(', 'await (throwIfCancelled(ctx), tools.execute(')
 # Close added expression on the execute statement only.
 s=s.replace('tools.execute(call.tool, call.input);','tools.execute(call.tool, call.input));')
 return s
edit(Path('packages/agent-loop-core/src/loop.ts'),shared)
