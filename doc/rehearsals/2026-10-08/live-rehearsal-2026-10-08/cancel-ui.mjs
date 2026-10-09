// Cancel through visible UI controls only. Never approve tool execution.
const targets=await (await fetch('http://127.0.0.1:19561/json/list')).json();
const target=targets.find(t=>t.type==='page');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let seq=0;const pending=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function click(selector){const r=await send('Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||getComputedStyle(e).display==='none')return null;const b=e.getBoundingClientRect();return b.width&&b.height?{x:b.x+b.width/2,y:b.y+b.height/2}:null})()`,returnByValue:true});const p=r.result.value;if(!p)return;await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
await click('#btn-deny-tool');
await new Promise(r=>setTimeout(r,100));
await click('#send-btn');
console.log(JSON.stringify({at:new Date().toISOString(),action:'Denied pending command and clicked Stop through native UI'}));
ws.close();
