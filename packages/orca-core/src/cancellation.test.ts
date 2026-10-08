import { describe, expect, it, vi } from 'vitest';
import { createOrcaRuntime } from './runtime.js';
import { createMirandaGate } from '@clawde/miranda-core';
import type { OrcaRunCtx, OrcaTaskSpec, OrcaPipelineTrace } from './types.js';
import type { PappyResult } from '@clawde/pappy-core';
const task:OrcaTaskSpec={intent:'test cancellation',originalUserMessage:'test cancellation',goals:['complete work']};
const qc:PappyResult={verdict:'FAIL',confidence:0,summary:'not verified',acceptance_criteria:[],claims:[],receipt_ledger:[],issues:[],repair_task:null,repairTask:'retry task',internalSummary:'FAIL'};
function harness(run:(task:OrcaTaskSpec,ctx:OrcaRunCtx)=>Promise<any>,evaluate=vi.fn(()=>qc)){
  let trace:OrcaPipelineTrace|undefined;const maestro={run:vi.fn(run)};const pappy={evaluate};
  const runtime=createOrcaRuntime({maestro,pappy,llm:{complete:async()=>({text:'unused'}),stream:async()=>({text:'unused'})},gate:createMirandaGate(),maxRepairPasses:2,writeTrace:t=>{trace=t;}});
  return {runtime,maestro,pappy,trace:()=>trace};
}
describe('cancellation across pipeline stages',()=>{
  it('refuses a planning run already cancelled before dispatch',async()=>{
    const c=new AbortController();c.abort('before planning');const h=harness(async()=>({outputText:'unused'}));await expect(h.runtime.executeTask(task,{abortSignal:c.signal})).rejects.toThrow('before planning');expect(h.maestro.run).not.toHaveBeenCalled();expect(h.pappy.evaluate).not.toHaveBeenCalled();
  });
  it.each(['planning','worker execution','approval waiting'])('cancellation during %s prevents verification and automatic repair',async stage=>{
    const c=new AbortController();const h=harness(async(_task,ctx)=>{ctx.recordTrace?.('test.stage',{stage});c.abort(new Error(`cancel during ${stage}`));return {outputText:'stale output',metadata:{role:'debugger'}};});
    const repair=vi.fn();h.runtime.on('repair:start',repair);await expect(h.runtime.executeTask(task,{abortSignal:c.signal})).rejects.toThrow(`cancel during ${stage}`);expect(h.maestro.run).toHaveBeenCalledOnce();expect(h.pappy.evaluate).not.toHaveBeenCalled();expect(repair).not.toHaveBeenCalled();expect(h.trace()?.finalResult?.status).toBe('ABORTED');expect(h.trace()?.finalResult?.summary).toContain(stage);
  });
  it('cancellation during verification never starts repair or publishes success',async()=>{
    const c=new AbortController();const evaluate=vi.fn(()=>{c.abort('verification cancelled');return qc;});const h=harness(async()=>({outputText:'worker result',metadata:{role:'debugger'}}),evaluate);const repair=vi.fn(),done=vi.fn();h.runtime.on('repair:start',repair);h.runtime.on('task:done',done);
    await expect(h.runtime.executeTask(task,{abortSignal:c.signal})).rejects.toThrow('verification cancelled');expect(evaluate).toHaveBeenCalledOnce();expect(h.maestro.run).toHaveBeenCalledOnce();expect(repair).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();expect(h.trace()?.finalResult?.status).toBe('ABORTED');
  });
  it('records cancellation while verification evidence is being persisted and never publishes success',async()=>{
    const c=new AbortController();const traces:OrcaPipelineTrace[]=[];
    const runtime=createOrcaRuntime({maestro:{run:async()=>({outputText:'verified result'})},pappy:{evaluate:()=>({...qc,verdict:'PASS',repairTask:undefined})},llm:{complete:async()=>({text:'unused'})},writeTrace:async trace=>{traces.push(structuredClone(trace));if(traces.length===1)c.abort('stopped during verification persistence');}});
    const done=vi.fn(),repair=vi.fn();runtime.on('task:done',done);runtime.on('repair:start',repair);
    await expect(runtime.executeTask(task,{abortSignal:c.signal})).rejects.toThrow('stopped during verification persistence');
    expect(traces.at(-1)?.finalResult?.status).toBe('ABORTED');expect(traces.at(-1)?.finalResult?.summary).toContain('verification persistence');
    expect(done).not.toHaveBeenCalled();expect(repair).not.toHaveBeenCalled();
  });
});
