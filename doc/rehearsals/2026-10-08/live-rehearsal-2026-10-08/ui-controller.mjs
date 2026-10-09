import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const evidence = dirname(fileURLToPath(import.meta.url));
const staging = resolve(evidence, '..', 'Orca-Summit-Staging-1.6.1');
const profile = resolve(staging, 'profile');
const workspace = resolve(profile, 'orca-demo', 'workspace');
const exe = resolve(staging, 'win-unpacked', 'Orca Summit Staging.exe');
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let main, renderer, child, runStarted = false, presenterReady = false;
let recordedApis = 0, lastApproval = '', lastOutcome = '', lastStage = '';
const timeline = [];
const entry = (type, data = {}) => {
  const e = { at: new Date().toISOString(), type, ...data };
  timeline.push(e); appendFileSync(join(evidence, 'timeline.jsonl'), JSON.stringify(e) + '\n');
};
const productionFiles = [
  'C:/[REDACTED CONTEXT]s/james/AppData/Roaming/@clawde/desktop/orca-settings.json',
  'C:/[REDACTED CONTEXT]s/james/AppData/Roaming/@clawde/desktop/Local State',
  'C:/[REDACTED CONTEXT]s/james/AppData/Roaming/@clawde/desktop/orca-auth.json',
  'C:/[REDACTED CONTEXT]s/james/.orca/userContext.json',
];
const protectedRecords = productionFiles.filter(existsSync).map(path => ({ path, sha256: hash(path) }));
writeFileSync(join(evidence, 'production-before.json'), JSON.stringify(protectedRecords, null, 2));
copyFileSync(join(profile, 'orca-settings.json'), join(evidence, 'staging-settings-before.encrypted.json'));

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  const pending = new Map(), handlers = new Map(); let counter = 0;
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if(p) { clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
    else handlers.get(msg.method)?.(msg.params);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000);
    pending.set(id, {resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
  });
  return {send, on:(event, fn)=>handlers.set(event,fn), close:()=>ws.close(), eval:async expression=>{
    const r = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }};
}
async function connect(port, type) {
  for(let i=0;i<100;i++) {
    try { const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const target=list.find(t=>type==='main'||t.type==='page'&&t.url.startsWith('file:')); if(target)return cdp(target.webSocketDebuggerUrl); }catch{}
    if(child.exitCode!==null) throw new Error('Staging exited before UI connection'); await sleep(200);
  }
  throw new Error('Unable to operate staging UI');
}
async function click(selector) {
  // Actual browser input delivered to the visible application's controls.
  const pos = await renderer.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Unavailable UI control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await renderer.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});
  await renderer.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos});
}
async function fill(selector,text) {
  await click(selector);
  await renderer.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await renderer.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await renderer.send('Input.insertText',{text});
  await renderer.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await renderer.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
}
async function selectFirstProvider(selector) {
  await click(selector);
  for(const [key,code,n] of [['Home','Home',36],['ArrowDown','ArrowDown',40],['Enter','Enter',13]]) {
    await renderer.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n});
    await renderer.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n});
  }
}
async function checked(selector,value) {
  if(await renderer.eval(`document.querySelector(${JSON.stringify(selector)}).checked`)!==value)await click(selector);
}
async function waitFor(expression, timeout=12000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {if(await renderer.eval(expression))return;await sleep(150);}
  throw new Error('UI did not reach expected state: '+expression);
}
async function shot(name) {const r=await renderer.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,name),Buffer.from(r.data,'base64'));}
async function state() {
  return renderer.eval(`({at:new Date().toISOString(),demoMode,demoExecution,busy,initState,authLocked:authState.locked,
    selectedOffline:document.querySelector('[data-demo-exec="offline"]')?.getAttribute('aria-checked'),
    outcome:document.querySelector('.demo-outcome')?.innerText,
    tracker:demoTracker?.getState(),
    approvalVisible:getComputedStyle(document.getElementById('tool-approval-dialog')).display!=='none',
    approvalId:document.getElementById('tool-approval-dialog').dataset.approvalId,
    approvalTool:document.getElementById('approval-tool-name').textContent,
    approvalArgs:document.getElementById('approval-args').textContent,
    approvalTimer:document.getElementById('approval-timer').textContent,
    alwaysApprove:document.getElementById('chk-always-approve').checked,
    settingsStatus:document.getElementById('settings-status')?.textContent,
    notice:document.getElementById('demo-recorded-notice')?.innerText,
    messageText:document.getElementById('messages').innerText})`);
}
function filesIn(root, prefix='') {
  return readdirSync(root,{withFileTypes:true}).flatMap(d=>d.isDirectory()?filesIn(join(root,d.name),join(prefix,d.name)):[{path:join(prefix,d.name),sha256:hash(join(root,d.name))}]);
}
function processCheck() {
  const command="Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'docker|npx|Orca' -or $_.CommandLine -match 'desktop-commander|github-mcp-server|modelcontextprotocol[/\\]server-github' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='mcp';Expression={$_.CommandLine -match 'desktop-commander|github-mcp-server|modelcontextprotocol[/\\]server-github'}} | ConvertTo-Json -Compress";
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true});
  const parsed=raw.trim()?JSON.parse(raw):[];return Array.isArray(parsed)?parsed:[parsed];
}
async function configure() {
  await click('#btn-settings');await waitFor(`!!editingSettings && !!document.querySelector('[data-role-id="debugger"]')`);
  // Keep all secret values inside the renderer; return only comparison booleans.
  await renderer.eval(`window.__rehearsalOriginalKeys=editingSettings.providers.map(p=>p.apiKey);true`);
  const sel='[data-role-id="debugger"] .role-provider-sel';
  await selectFirstProvider(sel);
  assert.equal(await renderer.eval(`document.querySelector(${JSON.stringify(sel)}).value`),'prov_d833');
  await fill('[data-role-id="debugger"] .role-model-inp','claude-sonnet-5-5');
  await checked('#mcp-dc-enabled',false);await checked('#mcp-gh-enabled',false);await checked('#set-demo-mode',true);
  await fill('#set-workspace',workspace);
  const audit=await renderer.eval(`({providers:editingSettings.providers.map((p,i)=>({id:p.id,type:p.type,baseUrl:p.baseUrl,keyPresent:!!p.apiKey,keyUnchanged:p.apiKey===window.__rehearsalOriginalKeys[i]})),roles:editingSettings.roles,budgetUsd:document.getElementById('set-budget').value,demoMode:document.getElementById('set-demo-mode').checked,workspace:document.getElementById('set-workspace').value,mcp:editingSettings.mcpServers.map(s=>({id:s.id,enabled:s.enabled}))})`);
  assert.ok(audit.providers.every(p=>p.keyUnchanged));assert.ok(audit.providers.find(p=>p.id==='prov_d833')?.keyPresent);
  const active=['brain','strong_model','cheap_model','utility','reviewer','narrator','planner_deep','debugger','reader','vision'];
  for(const [role,v] of Object.entries(audit.roles))if(active.includes(role)&&v.providerId) {
    const provider=audit.providers.find(p=>p.id===v.providerId);assert.ok(provider,'Missing provider for '+role);assert.ok(v.model,'No model for '+role);
    if(provider.type==='anthropic')assert.match(v.model,/^claude-/,'Invalid Anthropic model assignment for '+role);
  }
  await click('#btn-save-settings');
  await waitFor(`!document.getElementById('btn-save-settings').disabled && document.getElementById('settings-status').textContent.includes('Saved')`);
  await click('#btn-settings-back');
  await click('#btn-demo-reset');
  await waitFor(`!demoResetting && !document.getElementById('btn-demo-reset').disabled`);
  assert.ok(existsSync(join(workspace,'.orca-demo-workspace')),'Reset did not create demo workspace');
  const baseline=resolve(staging,'win-unpacked','resources','demo','summit-app');
  const baselineFiles=filesIn(baseline);
  for(const f of baselineFiles)assert.equal(hash(join(workspace,f.path)),f.sha256,'Baseline mismatch: '+f.path);
  mkdirSync(join(evidence,'workspace-before'),{recursive:true});
  for(const f of baselineFiles){mkdirSync(dirname(join(evidence,'workspace-before',f.path)),{recursive:true});copyFileSync(join(workspace,f.path),join(evidence,'workspace-before',f.path));}
  assert.match(readFileSync(join(workspace,'src','bookings.js'),'utf8'),/first\.start <= second\.end && second\.start <= first\.end/);
  assert.match(readFileSync(join(workspace,'test','bookings.test.js'),'utf8'),/a meeting can start exactly when the previous one ends/);
  const processes=processCheck();assert.ok(!processes.some(p=>p.mcp),'An MCP server process is present');
  const final=await state();assert.equal(final.demoMode,true);assert.equal(final.demoExecution,'offline');assert.equal(final.alwaysApprove,false);
  const result={at:new Date().toISOString(),identity:await main.eval(`(()=>{const app=process.mainModule.require('electron').app;return{name:app.getName(),version:app.getVersion(),userData:app.getPath('userData'),sessionData:app.getPath('sessionData')}})()`),audit,baselineFiles,processes,state:final};
  assert.equal(result.identity.userData.toLowerCase(),profile.toLowerCase());
  writeFileSync(join(evidence,'preflight.json'),JSON.stringify(result,null,2));await shot('preflight.png');entry('preflight_passed');return result;
}

async function action(name) {
  if(name==='status')return{state:await state(),apiCount:recordedApis,presenterReady,runStarted};
  if(name==='configure')return configure();
  if(name==='confirm-ready') {presenterReady=true;entry('presenter_readiness_confirmed');return{ready:true};}
  if(name==='catalog') {
    assert.ok(presenterReady,'Presenter readiness is required before any API request');
    await click('#btn-settings');await waitFor('!!editingSettings');
    await click('.provider-item[data-prov-idx="0"] .btn-fetch-models');
    await waitFor(`!document.querySelector('.provider-item[data-prov-idx="0"] .btn-fetch-models').disabled`,30000);
    const result=await renderer.eval(`({models:fetchedModels.get('prov_d833')??[],status:document.querySelector('.provider-item[data-prov-idx="0"] .fetch-models-status').textContent})`);
    writeFileSync(join(evidence,'account-model-catalog.json'),JSON.stringify(result,null,2));entry('model_catalog',result);return result;
  }
  if(name==='live') {
    assert.ok(presenterReady);assert.ok(!runStarted);
    if(await renderer.eval(`getComputedStyle(document.getElementById('settings-view')).display!=='none'`))await click('#btn-settings-back');
    await click('[data-demo-exec="live"]');
    // The presenter's confirmation was obtained before clicking this UI acknowledgment.
    await click('#demo-recorded-notice button');
    await waitFor(`demoExecution==='live' && initKnown && initState.ok`,30000);
    await shot('live-ready.png');entry('live_mode_initialized');return state();
  }
  if(name==='start') {
    assert.ok(presenterReady);assert.ok(!runStarted,'The single rehearsal has already started');
    const s=await state();assert.equal(s.demoMode,true);assert.equal(s.demoExecution,'live');assert.equal(s.initState.ok,true);assert.equal(s.alwaysApprove,false);
    runStarted=true;entry('single_find_fix_run_started');await click('.demo-preset.primary');return state();
  }
  if(name==='screenshot'){await shot('current.png');return{saved:true};}
  if(name==='stop') {if((await state()).busy)await click('#send-btn');entry('run_stop_requested');return state();}
  if(name==='close') {
    assert.ok(!(await state()).busy,'Stop or finish the run before closing');
    const preservation=protectedRecords.map(r=>({...r,unchanged:hash(r.path)===r.sha256}));
    writeFileSync(join(evidence,'production-preservation.json'),JSON.stringify(preservation,null,2));
    if(existsSync(workspace))writeFileSync(join(evidence,'workspace-after-hashes.json'),JSON.stringify(filesIn(workspace),null,2));
    entry('staging_closed');writeFileSync(join(evidence,'final-state.json'),JSON.stringify(await state(),null,2));
    await main.eval(`setImmediate(()=>process.mainModule.require('electron').app.quit());true`);main.close();renderer.close();
    setTimeout(()=>{server.close();process.exit(0);},750);return{closed:true,preservation};
  }
  throw new Error('Unknown action; tool approvals must be performed by the presenter in the actual UI');
}

const out=createWriteStream(join(evidence,'application-stdout.log')),err=createWriteStream(join(evidence,'application-stderr.log'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ORCA_FULL_TRACE;
let existing=false;
try { existing=(await(await fetch('http://127.0.0.1:19562/json/list')).json()).length>0; } catch{}
if(existing)child={exitCode:null,on:()=>{}};
else {
  child=spawn(exe,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=19561','--inspect=127.0.0.1:19562'],{cwd:evidence,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(out);child.stderr.pipe(err);
}
main=await connect(19562,'main');renderer=await connect(19561,'renderer');
assert.equal((await main.eval(`process.mainModule.require('electron').app.getPath('exe')`)).toLowerCase(),exe.toLowerCase());
await renderer.send('Runtime.enable');await renderer.send('Page.enable');await renderer.send('Runtime.addBinding',{name:'rehearsalEvent'});
renderer.on('Runtime.bindingCalled',({name,payload})=>{
  if(name!=='rehearsalEvent')return;const e=JSON.parse(payload);entry(e.kind,{data:e.data});
  if(e.kind==='approval_requested')console.log('PRESENTER_APPROVAL_REQUIRED '+JSON.stringify(e.data));
});
await waitFor('typeof initKnown !== "undefined" && initKnown && authKnown');
// Read-only event subscriptions; approval responses remain exclusively in the UI.
await renderer.eval(`window.orca.onOrcaEvent(e=>{if(e.type!=='stream:token')window.rehearsalEvent(JSON.stringify({kind:'orca_event',data:e}));});window.orca.onToolRequest((id,tool,args)=>window.rehearsalEvent(JSON.stringify({kind:'approval_requested',data:{id,tool,args}})));true`);
let apiPoll = false;
const timer=setInterval(async()=>{
  if(apiPoll)return;apiPoll=true;
  try {
    const s=await state();
    if(s.alwaysApprove) {entry('security_failure',{reason:'Always approve checkbox enabled'});if(s.busy)await click('#send-btn');console.log('BLOCKING_FAILURE: Always approve was enabled; run stopped.');}
    if(s.tracker?.stage!==lastStage){lastStage=s.tracker?.stage;entry('pipeline_stage',{stage:lastStage});console.log('PIPELINE_STAGE '+lastStage);}
    if(s.approvalVisible&&s.approvalId!==lastApproval){lastApproval=s.approvalId;await shot('approval-'+timeline.length+'.png');entry('visible_approval',{tool:s.approvalTool,args:s.approvalArgs,timer:s.approvalTimer});}
    if(s.outcome&&s.outcome!==lastOutcome){lastOutcome=s.outcome;entry('visible_outcome',{outcome:s.outcome});await shot('outcome.png');console.log('OUTCOME '+s.outcome);}
    writeFileSync(join(evidence,'current-state.json'),JSON.stringify(s,null,2));
  }catch(e){entry('monitor_error',{error:e.message});}
  finally{apiPoll=false;}
},1000);
const server=createServer(async(req,res)=>{
  try {
    if(req.method!=='POST')throw new Error('POST required');
    const name=new URL(req.url,'http://127.0.0.1').pathname.slice(1);
    const result=await action(name);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  }catch(e){entry('control_error',{error:e.message});res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
server.listen(19563,'127.0.0.1',()=>console.log('STAGING_UI_READY http://127.0.0.1:19563; no API requests initiated.'));
child.on('exit',()=>{clearInterval(timer);server.close();out.end();err.end();});
