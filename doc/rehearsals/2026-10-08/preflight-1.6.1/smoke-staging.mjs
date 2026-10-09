import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const staging = resolve(evidence, '..', 'Orca-Summit-Staging-1.6.1');
const exe = resolve(staging, 'win-unpacked', 'Orca Summit Staging.exe');
const profile = resolve(staging, 'profile');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const settingsHash = sha(resolve(profile, 'orca-settings.json'));
const report = { exe, profile, checks: {}, rendererErrors: [], networkRequests: [], processSamples: [] };
const stdout = createWriteStream(resolve(evidence, 'staging-stdout.log'));
const stderr = createWriteStream(resolve(evidence, 'staging-stderr.log'));
let child, main, renderer;

function processes() {
  const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='mcp';Expression={$_.CommandLine -match 'desktop-commander|github-mcp-server|modelcontextprotocol[/\\]server-github'}} | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
const before = processes();
const baselineMcpIds = new Set(before.filter(p => p.mcp).map(p => p.ProcessId));
const descendants = new Set();
function sampleProcesses() {
  const all = processes();
  descendants.add(child.pid);
  let changed;
  do {
    changed = false;
    for (const p of all) if (descendants.has(p.ParentProcessId) && !descendants.has(p.ProcessId)) {
      descendants.add(p.ProcessId); changed = true;
    }
  } while (changed);
  const own = all.filter(p => descendants.has(p.ProcessId));
  const unwanted = all.filter(p => (p.mcp && !baselineMcpIds.has(p.ProcessId)) ||
    (descendants.has(p.ProcessId) && /^(docker|npx|npm)\.(exe|cmd)$/i.test(p.Name)));
  report.processSamples.push({ at: new Date().toISOString(), processes: own, unwanted });
  assert.equal(unwanted.length, 0, 'Unexpected MCP/Docker/npx startup');
}

async function connect(port, type) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find(t => type === 'main' || (t.type === 'page' && t.url.startsWith('file:')));
      if (target) return await cdp(target.webSocketDebuggerUrl);
    } catch {}
    assert.equal(child.exitCode, null, 'Staging application exited during startup');
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${type} debugger`);
}
async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (p) { clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    } else listeners.get(msg.method)?.(msg.params);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(next, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  return {
    send, on: (event, cb) => listeners.set(event, cb), close: () => socket.close(),
    eval: async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? ''));
      return r.result.value;
    },
  };
}
async function screenshot(name) {
  const shot = await renderer.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(evidence, name), Buffer.from(shot.data, 'base64'));
}
const stateExpression = `({demoMode, demoExecution, busy, showPipeline: !document.body.classList.contains('hide-pipeline'),
  classes: document.body.className,
  offlineSelected: document.querySelector('[data-demo-exec="offline"]')?.getAttribute('aria-checked'),
  badge: document.getElementById('demo-exec-badge')?.textContent,
  outcome: document.querySelector('.demo-outcome')?.innerText,
  traceVisible: !!document.querySelector('.live-trace-panel') && getComputedStyle(document.querySelector('.live-trace-panel')).display !== 'none',
  traceText: document.querySelector('.live-trace-panel')?.innerText,
  strip: document.getElementById('demo-strip')?.innerText,
  pappyCards: [...document.querySelectorAll('.demo-pappy-card')].map(el => el.innerText),
  pappyChecks: document.querySelectorAll('.demo-pappy-check').length,
  tracker: demoTracker?.getState()})`;

try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19461', '--inspect=127.0.0.1:19462'], {
    cwd: staging, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { report.launchError = error.message; });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  main = await connect(19462, 'main');
  report.identity = await main.eval(`(() => { const app = process.mainModule.require('electron').app; return {name:app.getName(),version:app.getVersion(),userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),isPackaged:app.isPackaged}; })()`);
  assert.equal(report.identity.name, 'Orca Summit Staging');
  assert.equal(report.identity.version, '1.6.1');
  assert.equal(report.identity.userData.toLowerCase(), profile.toLowerCase());
  assert.equal(report.identity.sessionData.toLowerCase(), profile.toLowerCase());
  report.checks.startup = true;
  // Detect and block any unexpected API request during the remaining smoke test.
  await main.eval(`globalThis.__stagingFetchAttempts = []; globalThis.fetch = async (...args) => { globalThis.__stagingFetchAttempts.push(new URL(String(args[0])).hostname); throw new Error('Network disabled during offline staging smoke test'); }; true`);
  renderer = await connect(19461, 'renderer');
  renderer.on('Runtime.exceptionThrown', e => report.rendererErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text));
  renderer.on('Network.requestWillBeSent', e => { if (/^https?:/.test(e.request.url)) report.networkRequests.push(new URL(e.request.url).hostname); });
  await renderer.send('Runtime.enable');
  await renderer.send('Network.enable');
  await renderer.send('Page.enable');
  await renderer.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  for (let i = 0; i < 60; i++) {
    if (await renderer.eval(`typeof demoMode !== 'undefined' && demoMode && initKnown && !!document.querySelector('.demo-preset.primary')`)) break;
    await delay(250);
  }
  report.initial = await renderer.eval(stateExpression);
  assert.equal(report.initial.demoMode, true);
  assert.equal(report.initial.demoExecution, 'offline');
  assert.equal(report.initial.offlineSelected, 'true');
  assert.equal(report.initial.showPipeline, true);
  assert.match(report.initial.badge, /OFFLINE DEMO/);
  report.settings = await renderer.eval(`window.orca.getSettings().then(s => ({ demoMode: s.demoMode, showPipeline: s.showPipeline, providers: s.providers.map(p => ({id:p.id,type:p.type,keyPresent:!!p.apiKey})), roles: Object.fromEntries(Object.entries(s.roles).map(([k,v]) => [k,{providerId:v.providerId,model:v.model}])) }))`);
  assert.equal(report.settings.demoMode, true);
  assert.equal(report.settings.showPipeline, false);
  assert.deepEqual(report.settings.providers.map(p => p.id), ['prov_d833', 'prov_edd8']);
  assert.ok(report.settings.providers.every(p => p.keyPresent), 'Encrypted provider keys did not load');
  report.checks.encryptedCredentialsLoadedWithoutExposure = true;
  report.checks.settingsLoading = true;
  assert.ok(existsSync(resolve(profile, 'userContext.json')), 'Dewey context was not isolated into the staging profile');
  report.checks.deweyContextIsolation = true;
  report.checks.demoModeSelection = true;
  sampleProcesses();
  await screenshot('startup.png');
  console.log('Staging startup, isolated profile, settings and Offline Demo selection passed.');
  await renderer.eval(`document.querySelector('[data-demo-exec="offline"]').click(); document.querySelector('.demo-preset.primary').click(); true`);
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    await delay(1000);
    const state = await renderer.eval(stateExpression);
    sampleProcesses();
    if (!report.during && state.traceVisible && state.tracker?.stage !== 'idle') {
      await renderer.eval(`document.querySelector('.ltp-toggle').click(); true`);
      report.during = await renderer.eval(stateExpression); await screenshot('pipeline.png');
      console.log('Offline Find & Fix playback and pipeline visualization are running.');
    }
    if (!state.busy && state.outcome) { report.final = state; break; }
  }
  assert.ok(report.final, 'Offline scenario did not finish');
  await renderer.eval(`if (document.querySelector('.ltp-toggle')?.getAttribute('aria-expanded') !== 'true') document.querySelector('.ltp-toggle')?.click(); true`);
  report.final = await renderer.eval(stateExpression);
  assert.match(report.final.outcome, /Verified by Pappy/);
  assert.equal(report.final.tracker.lastVerdict, 'PASS');
  assert.ok(report.final.pappyChecks > 0);
  assert.equal(report.final.traceVisible, true);
  assert.match(report.final.traceText, /Pappy/);
  assert.ok(report.final.pappyCards.every(t => /SIMULATED/.test(t)));
  await screenshot('pappy-verdict.png');
  report.checks.offlineFindAndFix = true;
  report.checks.pipelineVisualization = true;
  report.checks.pappyVerdict = true;
  report.checks.noUnnecessaryMcpProcesses = true;
  report.fetchAttempts = await main.eval('globalThis.__stagingFetchAttempts');
  assert.deepEqual(report.fetchAttempts, []);
  assert.deepEqual(report.networkRequests, []);
  assert.deepEqual(report.rendererErrors, []);
  report.checks.noApiCalls = true;
  assert.equal(sha(resolve(profile, 'orca-settings.json')), settingsHash);
  report.checks.stagingSettingsUnchanged = true;
  console.log('Offline Find & Fix finished: simulated Pappy PASS; no API attempts or MCP processes.');
} catch (error) {
  report.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (main) {
    try { await main.eval(`setImmediate(() => process.mainModule.require('electron').app.quit()); true`); } catch {}
    main.close();
  }
  renderer?.close();
  if (child && child.exitCode === null) {
    for (let i = 0; i < 40 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error;
  writeFileSync(resolve(evidence, 'offline-smoke.json'), JSON.stringify(report, null, 2));
  stdout.end(); stderr.end();
}
