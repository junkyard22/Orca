/**
 * Minimal usage example — demonstrates that maestro-core is instantiable
 * in a plain Node environment with zero external dependencies.
 *
 * Run after building:
 *   cd packages/maestro-core && npm run build && node dist/example-usage.js
 */

import { createMaestroCore } from './core';
import { classifyTask } from './taskClassifier';
import { scoreRisk } from './riskScorer';
import { TaskType } from './types/orchestration';

// ── 1. Minimal console logger ────────────────────────────────────────────────
const consoleLogger = {
  debug: (msg: string) => console.debug('[DEBUG]', msg),
  info:  (msg: string) => console.info('[INFO] ', msg),
  warn:  (msg: string) => console.warn('[WARN] ', msg),
  error: (msg: string, err?: Error) => console.error('[ERROR]', msg, err ?? ''),
};

// ── 2. Create the core with no gitRunner (patch-artifact mode) ───────────────
const core = createMaestroCore({ logger: consoleLogger });

console.log('=== Maestro Core — Minimal Usage ===\n');
console.log(`Pod ID:   ${core.id}`);
console.log(`Pod Name: ${core.name}`);
console.log(`Caps:     ${core.capabilities.join(', ')}\n`);

// ── 3. Subscribe to events ───────────────────────────────────────────────────
core.getEventBus().on('run:started', p => console.log('[Event] run:started →', p.run_id));
core.getEventBus().on('task:done',   p => console.log('[Event] task:done   →', p.run_id));

// ── 4. Classify and score a task ─────────────────────────────────────────────
const task = 'Refactor the authentication module and split it into separate files';
const classification = classifyTask(task);
const risk = scoreRisk(classification);

console.log('Task:', task);
console.log('Classification:', classification);
console.log('Risk:          ', risk);
console.log(`Plan gate:      ${risk.requiresPlan ? 'ACTIVE (plan approval required)' : 'OPEN'}\n`);

// ── 5. Run the PodMember interface ───────────────────────────────────────────
(async () => {
  const result = await core.run(
    { id: 'task-001', description: task },
    { workspaceRoot: '/tmp/example-workspace' }
  );
  console.log('Run result:', JSON.stringify(result, null, 2));
})();
